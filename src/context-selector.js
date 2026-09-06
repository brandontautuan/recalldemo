import crypto from 'node:crypto';
import { canonicalJson } from './context-seed.js';

const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'will', 'with']);
const closedWorkItemStatuses = new Set(['cancelled', 'canceled', 'closed', 'done', 'resolved']);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const projectContextHash = (value) => value ? hash(value.trim()) : null;
const tokens = (value) => new Set(String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .match(/[a-z0-9]+/g)
  ?.filter((token) => token.length > 1 && !stopWords.has(token)) ?? []);
const overlap = (left, right) => [...left].filter((token) => right.has(token)).length;
const comparePriorityAndId = (left, right) => left.selectionPriority - right.selectionPriority || left.id.localeCompare(right.id);

const projectSource = (project) => ({
  id: `project:${project.id}`,
  kind: 'project_metadata',
  label: project.name,
  revision: project.updatedAt,
  text: [
    `Project: ${project.name}`,
    `Description: ${project.description}`,
    `Terminology: ${canonicalJson(project.terminology)}`,
    `Ticket format: ${canonicalJson(project.ticketFormat)}`,
  ].join('\n'),
});
const repositorySource = (repository) => ({
  id: `repository:${repository.id}`,
  kind: 'repository_metadata',
  label: repository.name,
  revision: repository.updatedAt,
  trackedFiles: Array.isArray(repository.metadata.trackedFiles) ? repository.metadata.trackedFiles : [],
  text: [
    `Repository: ${repository.name}`,
    repository.remoteUrl === 'https://local.invalid/not-configured' ? null : `Remote URL: ${repository.remoteUrl}`,
    `Default branch: ${repository.defaultBranch}`,
    `Metadata: ${canonicalJson(repository.metadata)}`,
  ].filter(Boolean).join('\n'),
});
const documentSource = (document) => ({
  id: `document:${document.id}`,
  kind: document.kind,
  label: document.title,
  revision: document.revision,
  sourcePath: document.sourcePath,
  lineStart: document.lineStart ?? null,
  lineEnd: document.lineEnd ?? null,
  ingestionId: document.ingestionId ?? null,
  truncated: Boolean(document.truncated),
  text: document.content,
});
const workItemSource = (workItem) => ({
  id: `work-item:${workItem.id}`,
  kind: 'work_item_snapshot',
  label: workItem.externalKey ? `${workItem.externalKey}: ${workItem.title}` : workItem.title,
  revision: workItem.updatedAt,
  sourceUrl: workItem.sourceUrl,
  text: [
    `Work item: ${workItem.title}`,
    `Status: ${workItem.status}`,
    `Priority: ${workItem.priority ?? 'unspecified'}`,
    `Labels: ${workItem.labels.join(', ') || 'none'}`,
    `Description: ${workItem.description}`,
  ].join('\n'),
});

export function buildContextSelection({ project, repositories, documents, workItems, meeting, transcript, projectContext = null, maximumCharacters }) {
  const queryTokens = tokens([
    meeting.title,
    projectContext,
    ...transcript.utterances.map((utterance) => utterance.text),
  ].filter(Boolean).join('\n'));
  const candidates = [
    projectSource(project),
    ...[...repositories].sort((left, right) => left.id.localeCompare(right.id)).map(repositorySource),
    ...documents.filter((document) => document.isActive).sort(comparePriorityAndId).map(documentSource),
  ];
  const omissions = documents.filter((document) => !document.isActive).map((document) => ({ sourceId: `document:${document.id}`, label: document.title, reason: 'inactive' }));
  const relevantWorkItems = [];
  for (const workItem of workItems) {
    const sourceId = `work-item:${workItem.id}`;
    if (closedWorkItemStatuses.has(workItem.status)) {
      omissions.push({ sourceId, label: workItem.title, reason: 'not_open' });
      continue;
    }
    const score = overlap(queryTokens, tokens([workItem.title, workItem.description, ...workItem.labels].join('\n')));
    if (score === 0) {
      omissions.push({ sourceId, label: workItem.title, reason: 'no_lexical_overlap' });
      continue;
    }
    relevantWorkItems.push({ ...workItem, overlapScore: score });
  }
  relevantWorkItems.sort((left, right) => right.overlapScore - left.overlapScore
    || left.selectionPriority - right.selectionPriority
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id));
  candidates.push(...relevantWorkItems.map((workItem) => ({ ...workItemSource(workItem), overlapScore: workItem.overlapScore })));

  const sources = [];
  let characterCount = 0;
  let budgetExhausted = false;
  for (const source of candidates) {
    if (budgetExhausted || characterCount + source.text.length > maximumCharacters) {
      budgetExhausted = true;
      omissions.push({ sourceId: source.id, label: source.label, reason: 'character_budget' });
      continue;
    }
    sources.push(source);
    characterCount += source.text.length;
  }
  omissions.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const selection = {
    schemaVersion: 'project-context-selection/v1',
    project: { id: project.id, slug: project.slug, name: project.name, revision: project.updatedAt },
    sources,
    omissions,
    characterCount,
    maximumCharacters,
    query: { projectContextSha256: projectContextHash(projectContext) },
  };
  return { selection, contentSha256: hash(canonicalJson(selection)) };
}
