/** Converts approved artifact versions into local-only canonical, Linear, or Jira draft payloads. */
export const exportFormats = ['canonical', 'linear', 'jira'];

export class ExportValidationError extends Error {
  constructor(issues) {
    super(`Export request failed validation: ${issues.join('; ')}`);
    this.name = 'ExportValidationError';
    this.issues = issues;
  }
}

export class ExportVersionConflictError extends Error {
  constructor(artifact) {
    super(`Artifact ${artifact.id} changed after it was selected.`);
    this.name = 'ExportVersionConflictError';
    this.artifact = artifact;
  }
}

const timestampLabel = (seconds) => {
  if (!Number.isFinite(seconds)) return 'time unavailable';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

const evidenceMarkdown = (evidence) => evidence.length
  ? evidence.map((item) => `- [${timestampLabel(item.startTime)}] ${item.speaker ?? 'Unknown speaker'}: ${item.text}`).join('\n')
  : '- No transcript evidence was supplied.';
const contextMarkdown = (provenance) => provenance?.sources?.length
  ? provenance.sources.map((source) => `- ${source.label} (${source.kind}, revision ${source.revision}, ${source.sourceId})`).join('\n')
  : '- No retrieved project-context source informed this artifact.';

const contentMarkdown = (content) => Object.entries(content)
  .filter(([, value]) => value !== null && value !== '' && (!Array.isArray(value) || value.length))
  .map(([field, value]) => {
    const label = field.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
    if (Array.isArray(value)) {
      const lines = value.map((item) => typeof item === 'string' ? item : `${item.alternative}: ${item.reason}`);
      return `## ${label}\n${lines.map((line) => `- ${line}`).join('\n')}`;
    }
    return `## ${label}\n${value}`;
  })
  .join('\n\n');

const artifactMarkdown = (artifact, meeting) => [
  contentMarkdown(artifact.content),
  `## Source meeting\n${meeting.title} (${meeting.id})`,
  `## Retrieved project context\n${contextMarkdown(artifact.contextProvenance)}`,
  `## Transcript evidence\n${evidenceMarkdown(artifact.evidence ?? [])}`,
].filter(Boolean).join('\n\n');

const approvedAt = (artifact, reviewEvents) => [...reviewEvents]
  .reverse()
  .find((event) => event.artifactId === artifact.id && event.action === 'approve' && event.version === artifact.version)?.occurredAt
  ?? artifact.reviewedAt
  ?? null;

const canonicalArtifact = (artifact, reviewEvents) => ({
  id: artifact.id,
  type: artifact.type,
  title: artifact.title,
  version: artifact.version ?? 1,
  status: artifact.status,
  content: structuredClone(artifact.content),
  confidence: artifact.confidence,
  provenance: { source: artifact.source, userEdited: Boolean(artifact.userEdited) },
  contextProvenance: structuredClone(artifact.contextProvenance ?? null),
  approvedAt: approvedAt(artifact, reviewEvents),
  evidence: structuredClone(artifact.evidence ?? []),
});

const linearDraft = (artifact, meeting) => ({
  sourceArtifact: { id: artifact.id, version: artifact.version ?? 1, type: artifact.type },
  mutation: 'issueCreate',
  input: {
    title: artifact.title,
    description: artifactMarkdown(artifact, meeting),
  },
  mappingHints: {
    requiredTeamId: null,
    assigneeName: artifact.content.assignee ?? artifact.content.owner ?? artifact.content.suggestedOwner ?? null,
    priorityName: artifact.content.priority ?? artifact.content.severity ?? artifact.content.impact ?? null,
    labelNames: ['recall-derived', artifact.type.replaceAll('_', '-')],
    dueDateText: artifact.content.dueDate ?? null,
  },
});

const adfDescription = (artifact, meeting) => ({
  type: 'doc',
  version: 1,
  content: artifactMarkdown(artifact, meeting).split('\n').filter(Boolean).map((line) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: line }],
  })),
});

const jiraDraft = (artifact, meeting) => ({
  sourceArtifact: { id: artifact.id, version: artifact.version ?? 1, type: artifact.type },
  fields: {
    summary: artifact.title,
    description: adfDescription(artifact, meeting),
    labels: ['recall-derived', artifact.type.replaceAll('_', '-')],
  },
  mappingHints: {
    requiredProjectKeyOrId: null,
    issueTypeName: artifact.type === 'bug_report' ? 'Bug' : 'Task',
    assigneeName: artifact.content.assignee ?? artifact.content.owner ?? artifact.content.suggestedOwner ?? null,
    priorityName: artifact.content.priority ?? artifact.content.severity ?? artifact.content.impact ?? null,
    dueDateText: artifact.content.dueDate ?? null,
  },
});

export const safeExportFilename = (meetingTitle, format) => {
  const slug = String(meetingTitle ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'meeting';
  return `${slug}-${format}-export.json`;
};

export function createArtifactExport({ meeting, selections, artifacts, reviewEvents = [], format, exportedAt = new Date().toISOString() }) {
  const issues = [];
  if (!exportFormats.includes(format)) issues.push(`format must be one of: ${exportFormats.join(', ')}`);
  if (!Array.isArray(selections) || selections.length === 0) issues.push('at least one artifact selection is required');
  if (Array.isArray(selections) && selections.length > 50) issues.push('no more than 50 artifacts may be exported at once');
  if (issues.length) throw new ExportValidationError(issues);

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const selectedIds = new Set();
  const selected = [];
  for (const [index, selection] of selections.entries()) {
    const label = `selections[${index}]`;
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) { issues.push(`${label} must be an object`); continue; }
    if (Object.keys(selection).some((field) => !['artifactId', 'version'].includes(field))) { issues.push(`${label} contains unsupported fields`); continue; }
    if (typeof selection.artifactId !== 'string' || !selection.artifactId) { issues.push(`${label}.artifactId is required`); continue; }
    if (!Number.isInteger(selection.version) || selection.version < 1) { issues.push(`${label}.version must be a positive integer`); continue; }
    if (selectedIds.has(selection.artifactId)) { issues.push(`${label} duplicates artifact ${selection.artifactId}`); continue; }
    selectedIds.add(selection.artifactId);
    const artifact = artifactById.get(selection.artifactId);
    if (!artifact) { issues.push(`${label} references an artifact outside this meeting`); continue; }
    if ((artifact.version ?? 1) !== selection.version) throw new ExportVersionConflictError(artifact);
    if (artifact.status !== 'approved') { issues.push(`${label} artifact must be approved`); continue; }
    if (typeof artifact.title !== 'string' || !artifact.title.trim() || !artifact.content || typeof artifact.content !== 'object' || !Array.isArray(artifact.evidence)) {
      issues.push(`${label} artifact is missing required export data`);
      continue;
    }
    selected.push(artifact);
  }
  if (format === 'jira') {
    for (const artifact of selected) {
      if (artifact.title.length > 255) issues.push(`artifact ${artifact.id} exceeds Jira's 255-character summary limit`);
      if (artifactMarkdown(artifact, meeting).length > 30_000) issues.push(`artifact ${artifact.id} exceeds Jira's 30000-character description limit`);
    }
  }
  if (issues.length) throw new ExportValidationError(issues);

  const base = {
    schemaVersion: 'recall-engineering-export/v1',
    format,
    exportedAt,
    meeting: { id: meeting.id, title: meeting.title, type: meeting.meetingType, startedAt: meeting.startedAt ?? null, endedAt: meeting.endedAt ?? null },
  };
  if (format === 'canonical') return { ...base, artifacts: selected.map((artifact) => canonicalArtifact(artifact, reviewEvents)) };
  if (format === 'linear') return { ...base, destination: 'linear', externallySubmitted: false, drafts: selected.map((artifact) => linearDraft(artifact, meeting)) };
  return { ...base, destination: 'jira-cloud-v3', externallySubmitted: false, drafts: selected.map((artifact) => jiraDraft(artifact, meeting)) };
}
