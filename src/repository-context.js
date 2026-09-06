import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from './context-seed.js';

const supportedDocumentExtensions = new Set(['.md', '.mdx', '.rst', '.txt']);
const deniedSegments = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage']);
const deniedFilenames = [/^\.env(?:\.|$)/i, /credential/i, /secret/i, /private[-_.]?key/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i];

export class RepositoryContextError extends Error {
  constructor(message, code = 'invalid_repository_context') {
    super(message);
    this.name = 'RepositoryContextError';
    this.code = code;
  }
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const validateRelativeDocumentPath = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new RepositoryContextError('Approved document paths must be non-empty strings.');
  const normalized = path.normalize(value.trim());
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new RepositoryContextError('Approved document paths must stay inside the repository.');
  const segments = normalized.split(path.sep);
  if (segments.some((segment) => deniedSegments.has(segment) || segment === '')) throw new RepositoryContextError(`Approved document path is denied: ${value}`);
  if (deniedFilenames.some((pattern) => pattern.test(path.basename(normalized)))) throw new RepositoryContextError(`Approved document path may contain secrets: ${value}`);
  if (!supportedDocumentExtensions.has(path.extname(normalized).toLowerCase())) throw new RepositoryContextError(`Approved documents must use one of: ${[...supportedDocumentExtensions].join(', ')}`);
  return normalized;
};

const gitOutput = (repositoryPath, args) => {
  const response = spawnSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 1_000_000, timeout: 5_000 });
  return response.status === 0 ? response.stdout.trim() : null;
};

const boundedLines = (content, maximumCharacters) => {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (normalized.length <= maximumCharacters) {
    const bounded = normalized.trim();
    return { content: bounded, lineEnd: bounded.split('\n').length, truncated: false };
  }
  const prefix = normalized.slice(0, maximumCharacters);
  const lastNewline = prefix.lastIndexOf('\n');
  const bounded = (lastNewline > 0 ? prefix.slice(0, lastNewline) : prefix).trim();
  return { content: bounded, lineEnd: bounded ? bounded.split('\n').length : 0, truncated: true };
};

export function resolveApprovedRepositoryPath(repositoryPath, allowedRoots) {
  if (typeof repositoryPath !== 'string' || !repositoryPath.trim()) throw new RepositoryContextError('A local repository path is required.');
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) throw new RepositoryContextError('PROJECT_REPOSITORY_ROOTS must allow at least one parent directory.', 'repository_roots_not_configured');
  let realRepositoryPath;
  try { realRepositoryPath = fs.realpathSync(repositoryPath.trim()); }
  catch { throw new RepositoryContextError('The configured repository path does not exist.'); }
  if (!fs.statSync(realRepositoryPath).isDirectory()) throw new RepositoryContextError('The configured repository path must be a directory.');
  const realRoots = allowedRoots.map((root) => {
    try { return fs.realpathSync(root); }
    catch { throw new RepositoryContextError(`Configured repository root does not exist: ${root}`, 'repository_roots_not_configured'); }
  });
  if (!realRoots.some((root) => isWithin(root, realRepositoryPath))) throw new RepositoryContextError('The repository path is outside PROJECT_REPOSITORY_ROOTS.');
  return realRepositoryPath;
}

export function scanApprovedRepository({ repositoryPath, approvedFiles, allowedRoots, maximumFiles = 20, maximumFileBytes = 100_000, maximumFileCharacters = 6_000, maximumTrackedFiles = 300 }) {
  if (!Array.isArray(approvedFiles) || !approvedFiles.length || approvedFiles.length > maximumFiles) throw new RepositoryContextError(`Choose 1 to ${maximumFiles} approved documentation files.`);
  const realRepositoryPath = resolveApprovedRepositoryPath(repositoryPath, allowedRoots);
  const uniqueFiles = [...new Set(approvedFiles.map(validateRelativeDocumentPath))].sort((left, right) => left.localeCompare(right));
  const documents = uniqueFiles.map((relativePath) => {
    const candidate = path.resolve(realRepositoryPath, relativePath);
    let realFile;
    try { realFile = fs.realpathSync(candidate); }
    catch { throw new RepositoryContextError(`Approved document was not found: ${relativePath}`); }
    if (!isWithin(realRepositoryPath, realFile)) throw new RepositoryContextError(`Approved document escapes the repository: ${relativePath}`);
    const stats = fs.lstatSync(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new RepositoryContextError(`Approved document must be a regular non-symbolic file: ${relativePath}`);
    if (stats.size > maximumFileBytes) throw new RepositoryContextError(`Approved document exceeds ${maximumFileBytes} bytes: ${relativePath}`);
    const excerpt = boundedLines(fs.readFileSync(realFile, 'utf8'), maximumFileCharacters);
    if (!excerpt.content) throw new RepositoryContextError(`Approved document is empty: ${relativePath}`);
    return {
      kind: /^readme(?:\.|$)/i.test(path.basename(relativePath)) ? 'readme_excerpt' : 'project_metadata',
      title: path.basename(relativePath),
      sourcePath: relativePath.split(path.sep).join('/'),
      content: excerpt.content,
      contentSha256: crypto.createHash('sha256').update(excerpt.content).digest('hex'),
      lineStart: 1,
      lineEnd: excerpt.lineEnd,
      truncated: excerpt.truncated,
    };
  });
  const trackedOutput = gitOutput(realRepositoryPath, ['ls-files', '-z']);
  const trackedFiles = trackedOutput === null ? uniqueFiles.map((value) => value.split(path.sep).join('/')) : trackedOutput.split('\0')
    .filter(Boolean)
    .filter((file) => !file.split('/').some((segment) => deniedSegments.has(segment)))
    .filter((file) => !deniedFilenames.some((pattern) => pattern.test(path.posix.basename(file))))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maximumTrackedFiles);
  const commitVersion = gitOutput(realRepositoryPath, ['rev-parse', 'HEAD']);
  const workingTreeStatus = gitOutput(realRepositoryPath, ['status', '--porcelain=v1', '--untracked-files=no']);
  const fingerprintInput = { commitVersion, workingTreeStatus, trackedFiles, documents: documents.map(({ truncated, ...document }) => document) };
  return {
    repositoryPath: realRepositoryPath,
    commitVersion,
    trackedFiles,
    documents,
    sourceFingerprint: crypto.createHash('sha256').update(canonicalJson(fingerprintInput)).digest('hex'),
    scannedAt: new Date().toISOString(),
  };
}
