import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const maximumSeedBytes = 1_000_000;
const documentKinds = new Set(['project_metadata', 'readme_excerpt', 'repository_metadata', 'work_item_snapshot']);
const idPattern = /^[a-z][a-z0-9._:-]{1,127}$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const limits = { projects: 100, repositories: 500, documents: 2_000, workItems: 2_000 };

export class ContextSeedValidationError extends Error {
  constructor(issues) {
    super(`Project-context seed failed validation: ${issues.join('; ')}`);
    this.name = 'ContextSeedValidationError';
    this.issues = issues;
  }
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value, allowed, label, issues) => {
  if (!isObject(value)) { issues.push(`${label} must be an object`); return false; }
  for (const field of Object.keys(value)) if (!allowed.includes(field)) issues.push(`${label}.${field} is not supported`);
  return true;
};
const requiredString = (value, label, issues, maximum = 10_000) => {
  if (typeof value !== 'string' || !value.trim()) { issues.push(`${label} must be a non-empty string`); return; }
  if (value.length > maximum) issues.push(`${label} must contain at most ${maximum} characters`);
};
const optionalString = (value, label, issues, maximum = 10_000) => {
  if (value !== undefined && value !== null) requiredString(value, label, issues, maximum);
};
const identifier = (value, label, issues) => {
  requiredString(value, label, issues, 128);
  if (typeof value === 'string' && !idPattern.test(value.trim().toLowerCase())) issues.push(`${label} must be a stable lowercase-compatible identifier`);
};
const timestamp = (value, label, issues) => {
  requiredString(value, label, issues, 64);
  if (typeof value === 'string' && !Number.isFinite(Date.parse(value))) issues.push(`${label} must be a valid timestamp`);
};
const jsonObject = (value, label, issues) => {
  if (!isObject(value)) { issues.push(`${label} must be an object`); return; }
  if (JSON.stringify(value).length > 20_000) issues.push(`${label} is too large`);
};
const httpsUrl = (value, label, issues, optional = false) => {
  if (optional && (value === undefined || value === null)) return;
  requiredString(value, label, issues, 2_000);
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) issues.push(`${label} must be an HTTPS URL without embedded credentials`);
  } catch { issues.push(`${label} must be a valid URL`); }
};
const priority = (value, label, issues) => {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) issues.push(`${label} must be an integer from 0 to 1000000`);
};
const revision = (value, label, issues) => {
  if (!Number.isInteger(value) || value < 1) issues.push(`${label} must be a positive integer`);
};

const validateRepository = (repository, label, issues) => {
  if (!exactFields(repository, ['id', 'name', 'remoteUrl', 'defaultBranch', 'metadata', 'createdAt', 'updatedAt'], label, issues)) return;
  identifier(repository.id, `${label}.id`, issues);
  requiredString(repository.name, `${label}.name`, issues, 200);
  httpsUrl(repository.remoteUrl, `${label}.remoteUrl`, issues);
  requiredString(repository.defaultBranch, `${label}.defaultBranch`, issues, 200);
  jsonObject(repository.metadata, `${label}.metadata`, issues);
  timestamp(repository.createdAt, `${label}.createdAt`, issues);
  timestamp(repository.updatedAt, `${label}.updatedAt`, issues);
};

const validateDocument = (document, label, repositoryIds, issues) => {
  if (!exactFields(document, ['id', 'repositoryId', 'kind', 'title', 'sourcePath', 'content', 'revision', 'selectionPriority', 'isActive', 'createdAt', 'updatedAt'], label, issues)) return;
  identifier(document.id, `${label}.id`, issues);
  optionalString(document.repositoryId, `${label}.repositoryId`, issues, 128);
  if (document.repositoryId && !repositoryIds.has(document.repositoryId.trim().toLowerCase())) issues.push(`${label}.repositoryId must reference a repository in the same project`);
  if (!documentKinds.has(document.kind)) issues.push(`${label}.kind is unsupported`);
  requiredString(document.title, `${label}.title`, issues, 300);
  requiredString(document.sourcePath, `${label}.sourcePath`, issues, 1_000);
  if (typeof document.sourcePath === 'string') {
    const normalizedPath = path.posix.normalize(document.sourcePath.replaceAll('\\', '/'));
    if (normalizedPath.startsWith('../') || normalizedPath.startsWith('/') || normalizedPath === '..') issues.push(`${label}.sourcePath must be a relative display path`);
  }
  requiredString(document.content, `${label}.content`, issues, 20_000);
  revision(document.revision, `${label}.revision`, issues);
  priority(document.selectionPriority, `${label}.selectionPriority`, issues);
  if (typeof document.isActive !== 'boolean') issues.push(`${label}.isActive must be a boolean`);
  timestamp(document.createdAt, `${label}.createdAt`, issues);
  timestamp(document.updatedAt, `${label}.updatedAt`, issues);
};

const validateWorkItem = (workItem, label, issues) => {
  if (!exactFields(workItem, ['id', 'externalKey', 'title', 'description', 'status', 'priority', 'selectionPriority', 'labels', 'sourceUrl', 'updatedAt'], label, issues)) return;
  identifier(workItem.id, `${label}.id`, issues);
  optionalString(workItem.externalKey, `${label}.externalKey`, issues, 200);
  requiredString(workItem.title, `${label}.title`, issues, 500);
  requiredString(workItem.description, `${label}.description`, issues, 10_000);
  requiredString(workItem.status, `${label}.status`, issues, 100);
  optionalString(workItem.priority, `${label}.priority`, issues, 100);
  priority(workItem.selectionPriority, `${label}.selectionPriority`, issues);
  if (!Array.isArray(workItem.labels) || workItem.labels.some((labelValue) => typeof labelValue !== 'string' || !labelValue.trim() || labelValue.length > 100)) issues.push(`${label}.labels must contain non-empty strings of at most 100 characters`);
  httpsUrl(workItem.sourceUrl, `${label}.sourceUrl`, issues, true);
  timestamp(workItem.updatedAt, `${label}.updatedAt`, issues);
};

export function validateSeedManifest(manifest) {
  const issues = [];
  if (!exactFields(manifest, ['schemaVersion', 'projects'], 'manifest', issues)) throw new ContextSeedValidationError(issues);
  if (manifest.schemaVersion !== 'project-context-seed/v1') issues.push('manifest.schemaVersion must equal project-context-seed/v1');
  if (!Array.isArray(manifest.projects) || manifest.projects.length === 0 || manifest.projects.length > limits.projects) issues.push(`manifest.projects must contain 1 to ${limits.projects} projects`);
  const ids = { projects: new Set(), repositories: new Set(), documents: new Set(), workItems: new Set() };
  const slugs = new Set();
  for (const [projectIndex, project] of (Array.isArray(manifest.projects) ? manifest.projects : []).entries()) {
    const label = `manifest.projects[${projectIndex}]`;
    if (!exactFields(project, ['id', 'slug', 'name', 'description', 'terminology', 'ticketFormat', 'isActive', 'createdAt', 'updatedAt', 'repositories', 'documents', 'workItems'], label, issues)) continue;
    identifier(project.id, `${label}.id`, issues);
    requiredString(project.slug, `${label}.slug`, issues, 100);
    if (typeof project.slug === 'string' && !slugPattern.test(project.slug.trim().toLowerCase())) issues.push(`${label}.slug must contain lowercase words separated by hyphens`);
    requiredString(project.name, `${label}.name`, issues, 200);
    requiredString(project.description, `${label}.description`, issues, 10_000);
    jsonObject(project.terminology, `${label}.terminology`, issues);
    jsonObject(project.ticketFormat, `${label}.ticketFormat`, issues);
    if (typeof project.isActive !== 'boolean') issues.push(`${label}.isActive must be a boolean`);
    timestamp(project.createdAt, `${label}.createdAt`, issues);
    timestamp(project.updatedAt, `${label}.updatedAt`, issues);
    const projectId = typeof project.id === 'string' ? project.id.trim().toLowerCase() : '';
    const slug = typeof project.slug === 'string' ? project.slug.trim().toLowerCase() : '';
    if (ids.projects.has(projectId)) issues.push(`${label}.id is duplicated`); else ids.projects.add(projectId);
    if (slugs.has(slug)) issues.push(`${label}.slug is duplicated`); else slugs.add(slug);
    for (const field of ['repositories', 'documents', 'workItems']) {
      if (!Array.isArray(project[field]) || project[field].length > limits[field]) issues.push(`${label}.${field} must be an array with at most ${limits[field]} entries`);
    }
    const repositories = Array.isArray(project.repositories) ? project.repositories : [];
    const repositoryIds = new Set(repositories.map((repository) => typeof repository?.id === 'string' ? repository.id.trim().toLowerCase() : ''));
    for (const [index, repository] of repositories.entries()) {
      validateRepository(repository, `${label}.repositories[${index}]`, issues);
      const id = typeof repository?.id === 'string' ? repository.id.trim().toLowerCase() : '';
      if (ids.repositories.has(id)) issues.push(`${label}.repositories[${index}].id is duplicated`); else ids.repositories.add(id);
    }
    for (const [index, document] of (Array.isArray(project.documents) ? project.documents : []).entries()) {
      validateDocument(document, `${label}.documents[${index}]`, repositoryIds, issues);
      const id = typeof document?.id === 'string' ? document.id.trim().toLowerCase() : '';
      if (ids.documents.has(id)) issues.push(`${label}.documents[${index}].id is duplicated`); else ids.documents.add(id);
    }
    const externalKeys = new Set();
    for (const [index, workItem] of (Array.isArray(project.workItems) ? project.workItems : []).entries()) {
      validateWorkItem(workItem, `${label}.workItems[${index}]`, issues);
      const id = typeof workItem?.id === 'string' ? workItem.id.trim().toLowerCase() : '';
      if (ids.workItems.has(id)) issues.push(`${label}.workItems[${index}].id is duplicated`); else ids.workItems.add(id);
      if (workItem?.externalKey) {
        const key = workItem.externalKey.trim();
        if (externalKeys.has(key)) issues.push(`${label}.workItems[${index}].externalKey is duplicated within the project`); else externalKeys.add(key);
      }
    }
  }
  if (issues.length) throw new ContextSeedValidationError(issues);
}

const normalizeInline = (value) => value.trim().replace(/\s+/g, ' ');
const normalizeContent = (value) => value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[\t ]+$/g, '')).join('\n').trim();
const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
};
export const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const normalizeTimestamp = (value) => new Date(value).toISOString();
const normalizeUrl = (value) => {
  if (!value) return null;
  const url = new URL(value.trim());
  url.hash = '';
  return url.toString();
};

export function normalizeSeedManifest(manifest) {
  validateSeedManifest(manifest);
  const normalized = {
    schemaVersion: manifest.schemaVersion,
    projects: manifest.projects.map((project) => ({
      id: project.id.trim().toLowerCase(),
      slug: project.slug.trim().toLowerCase(),
      name: normalizeInline(project.name),
      description: normalizeContent(project.description),
      terminology: canonicalValue(project.terminology),
      ticketFormat: canonicalValue(project.ticketFormat),
      isActive: project.isActive,
      createdAt: normalizeTimestamp(project.createdAt),
      updatedAt: normalizeTimestamp(project.updatedAt),
      repositories: project.repositories.map((repository) => ({
        id: repository.id.trim().toLowerCase(),
        name: normalizeInline(repository.name),
        remoteUrl: normalizeUrl(repository.remoteUrl),
        defaultBranch: normalizeInline(repository.defaultBranch),
        metadata: canonicalValue(repository.metadata),
        createdAt: normalizeTimestamp(repository.createdAt),
        updatedAt: normalizeTimestamp(repository.updatedAt),
      })).sort((left, right) => left.id.localeCompare(right.id)),
      documents: project.documents.map((document) => ({
        id: document.id.trim().toLowerCase(),
        repositoryId: document.repositoryId ? document.repositoryId.trim().toLowerCase() : null,
        kind: document.kind,
        title: normalizeInline(document.title),
        sourcePath: path.posix.normalize(document.sourcePath.replaceAll('\\', '/').trim()),
        content: normalizeContent(document.content),
        revision: document.revision,
        selectionPriority: document.selectionPriority,
        isActive: document.isActive,
        createdAt: normalizeTimestamp(document.createdAt),
        updatedAt: normalizeTimestamp(document.updatedAt),
      })).sort((left, right) => left.id.localeCompare(right.id)),
      workItems: project.workItems.map((workItem) => ({
        id: workItem.id.trim().toLowerCase(),
        externalKey: workItem.externalKey ? normalizeInline(workItem.externalKey) : null,
        title: normalizeInline(workItem.title),
        description: normalizeContent(workItem.description),
        status: normalizeInline(workItem.status).toLowerCase(),
        priority: workItem.priority ? normalizeInline(workItem.priority) : null,
        selectionPriority: workItem.selectionPriority,
        labels: [...new Set(workItem.labels.map(normalizeInline))].sort((left, right) => left.localeCompare(right)),
        sourceUrl: normalizeUrl(workItem.sourceUrl),
        updatedAt: normalizeTimestamp(workItem.updatedAt),
      })).sort((left, right) => left.id.localeCompare(right.id)),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
  return { manifest: normalized, contentSha256: crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex') };
}

export function loadSeedManifest(seedPath, { publicDirectory = path.resolve('public'), maximumBytes = maximumSeedBytes } = {}) {
  const resolvedPath = path.resolve(seedPath);
  const relativeToPublic = path.relative(path.resolve(publicDirectory), resolvedPath);
  if (relativeToPublic === '' || (!relativeToPublic.startsWith('..') && !path.isAbsolute(relativeToPublic))) throw new Error('PROJECT_CONTEXT_SEED_PATH must not be inside the public directory.');
  const stats = fs.lstatSync(resolvedPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('PROJECT_CONTEXT_SEED_PATH must be a regular file, not a symbolic link.');
  if (stats.size > maximumBytes) throw new Error(`Project-context seed exceeds ${maximumBytes} bytes.`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')); }
  catch (error) { throw new Error(`Project-context seed must be valid JSON: ${error.message}`, { cause: error }); }
  return normalizeSeedManifest(parsed);
}
