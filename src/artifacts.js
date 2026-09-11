/** Schema and evidence gate for untrusted Groq artifact proposals and human revisions. */
import crypto from 'node:crypto';

export const artifactTypes = ['architecture_decision', 'action_item', 'bug_report', 'risk', 'open_question'];
const confidenceValues = ['low', 'medium', 'high'];
const priorityValues = ['low', 'medium', 'high', 'critical', null];

const nullableString = { type: ['string', 'null'] };
const stringArray = { type: 'array', items: { type: 'string' } };

export const artifactResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifacts: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: artifactTypes },
          title: { type: 'string' },
          status: { type: 'string', enum: ['proposed'] },
          description: nullableString,
          context: nullableString,
          decision: nullableString,
          alternativesRejected: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { alternative: { type: 'string' }, reason: { type: 'string' } }, required: ['alternative', 'reason'] } },
          consequences: stringArray,
          assignee: nullableString,
          dueDate: nullableString,
          acceptanceCriteria: stringArray,
          priority: { enum: priorityValues },
          stepsToReproduce: stringArray,
          expectedBehavior: nullableString,
          actualBehavior: nullableString,
          severity: { enum: priorityValues },
          impact: { enum: priorityValues },
          mitigation: nullableString,
          owner: nullableString,
          question: nullableString,
          suggestedOwner: nullableString,
          summary: nullableString,
          problem: nullableString,
          whyItMatters: nullableString,
          proposedImplementationAreas: stringArray,
          dependencies: stringArray,
          risks: stringArray,
          openQuestions: stringArray,
          repositoryReferences: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sourceId: { type: 'string' },
                path: { type: 'string' },
                lineStart: { type: ['integer', 'null'] },
                lineEnd: { type: ['integer', 'null'] },
              },
              required: ['sourceId', 'path', 'lineStart', 'lineEnd'],
            },
          },
          evidenceUtteranceIds: stringArray,
          contextSourceIds: stringArray,
          confidence: { type: 'string', enum: confidenceValues },
        },
        required: ['type', 'title', 'status', 'description', 'context', 'decision', 'alternativesRejected', 'consequences', 'assignee', 'dueDate', 'acceptanceCriteria', 'priority', 'stepsToReproduce', 'expectedBehavior', 'actualBehavior', 'severity', 'impact', 'mitigation', 'owner', 'question', 'suggestedOwner', 'summary', 'problem', 'whyItMatters', 'proposedImplementationAreas', 'dependencies', 'risks', 'openQuestions', 'repositoryReferences', 'evidenceUtteranceIds', 'contextSourceIds', 'confidence'],
      },
    },
  },
  required: ['artifacts'],
};

export class ArtifactValidationError extends Error {
  constructor(issues) {
    super(`Generated artifacts failed validation: ${issues.join('; ')}`);
    this.name = 'ArtifactValidationError';
    this.issues = issues;
  }
}

const isNullableString = (value) => value === null || typeof value === 'string';
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const normalizedTitle = (value) => value.trim().toLocaleLowerCase();
const artifactFields = new Set(Object.keys(artifactResponseSchema.properties.artifacts.items.properties));
const immutableArtifactFields = new Set(['type', 'status', 'repositoryReferences', 'evidenceUtteranceIds', 'contextSourceIds', 'confidence']);
const editableContentFields = new Set([...artifactFields].filter((field) => !immutableArtifactFields.has(field) && field !== 'title'));

const meaningfulText = (value, minimumLength) => typeof value === 'string' && value.trim().length >= minimumLength;
// The analysis prompt routes ticket-like action items into summary/problem rather than description,
// so a grounded ticket must not be rejected merely for leaving description null.
const hasActionItemBody = (artifact) => [artifact.description, artifact.summary, artifact.problem].some((value) => meaningfulText(value, 10));

function collectArtifactIssues(artifact, label, { utteranceById, contextSourceById, participantNames, duplicates }) {
  const issues = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) { issues.push(`${label} must be an object`); return issues; }
  for (const field of Object.keys(artifact)) if (!artifactFields.has(field)) issues.push(`${label}.${field} is not allowed`);
  for (const field of artifactFields) if (!(field in artifact)) issues.push(`${label}.${field} is required`);
  if (!artifactTypes.includes(artifact.type)) issues.push(`${label}.type is unsupported`);
  if (typeof artifact.title !== 'string' || artifact.title.trim().length < 4) issues.push(`${label}.title is too vague`);
  if (artifact.status !== 'proposed') issues.push(`${label}.status must be proposed`);
  if (!confidenceValues.includes(artifact.confidence)) issues.push(`${label}.confidence is invalid`);
  if (!isStringArray(artifact.evidenceUtteranceIds)) issues.push(`${label}.evidenceUtteranceIds must be a string array`);
  else for (const id of artifact.evidenceUtteranceIds) if (!utteranceById.has(id)) issues.push(`${label} references unknown evidence ${id}`);
  if (!isStringArray(artifact.contextSourceIds)) issues.push(`${label}.contextSourceIds must be a string array`);
  else {
    const referencedSources = new Set();
    for (const id of artifact.contextSourceIds) {
      if (!contextSourceById.has(id)) issues.push(`${label} references unknown context source ${id}`);
      if (referencedSources.has(id)) issues.push(`${label} duplicates context source ${id}`);
      referencedSources.add(id);
    }
  }
  if (!Array.isArray(artifact.repositoryReferences)) issues.push(`${label}.repositoryReferences must be an array`);
  else for (const [referenceIndex, reference] of artifact.repositoryReferences.entries()) {
    const referenceLabel = `${label}.repositoryReferences[${referenceIndex}]`;
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) { issues.push(`${referenceLabel} must be an object`); continue; }
    if (Object.keys(reference).some((field) => !['sourceId', 'path', 'lineStart', 'lineEnd'].includes(field))) issues.push(`${referenceLabel} contains unsupported fields`);
    if (typeof reference.sourceId !== 'string' || typeof reference.path !== 'string' || !reference.path) { issues.push(`${referenceLabel} requires sourceId and path`); continue; }
    const source = contextSourceById.get(reference.sourceId);
    if (!source) { issues.push(`${referenceLabel} references unapproved context`); continue; }
    if (!artifact.contextSourceIds?.includes(reference.sourceId)) issues.push(`${referenceLabel}.sourceId must also appear in contextSourceIds`);
    if (source.sourcePath !== reference.path && !source.trackedFiles?.includes(reference.path)) issues.push(`${referenceLabel}.path is not present in its approved context source`);
    if (reference.lineStart !== null && (!Number.isInteger(reference.lineStart) || reference.lineStart < 1)) issues.push(`${referenceLabel}.lineStart is invalid`);
    if (reference.lineEnd !== null && (!Number.isInteger(reference.lineEnd) || reference.lineEnd < (reference.lineStart ?? 1))) issues.push(`${referenceLabel}.lineEnd is invalid`);
    if ((reference.lineStart === null) !== (reference.lineEnd === null)) issues.push(`${referenceLabel} line range must be complete or null`);
    if (source.sourcePath && (reference.lineStart !== source.lineStart || reference.lineEnd !== source.lineEnd)) issues.push(`${referenceLabel} line range must match the approved excerpt`);
  }
  if (artifact.assignee !== null && !participantNames.has(artifact.assignee)) issues.push(`${label}.assignee is not a meeting participant`);
  if (artifact.owner !== null && !participantNames.has(artifact.owner)) issues.push(`${label}.owner is not a meeting participant`);
  if (artifact.suggestedOwner !== null && !participantNames.has(artifact.suggestedOwner)) issues.push(`${label}.suggestedOwner is not a meeting participant`);
  if (!priorityValues.includes(artifact.priority)) issues.push(`${label}.priority is invalid`);
  if (!priorityValues.includes(artifact.severity)) issues.push(`${label}.severity is invalid`);
  if (!priorityValues.includes(artifact.impact)) issues.push(`${label}.impact is invalid`);
  for (const field of ['description', 'context', 'decision', 'assignee', 'dueDate', 'expectedBehavior', 'actualBehavior', 'mitigation', 'owner', 'question', 'suggestedOwner', 'summary', 'problem', 'whyItMatters']) {
    if (!isNullableString(artifact[field])) issues.push(`${label}.${field} must be a string or null`);
  }
  for (const field of ['consequences', 'acceptanceCriteria', 'stepsToReproduce', 'proposedImplementationAreas', 'dependencies', 'risks', 'openQuestions']) if (!isStringArray(artifact[field])) issues.push(`${label}.${field} must be a string array`);
  if (!Array.isArray(artifact.alternativesRejected) || !artifact.alternativesRejected.every((item) => typeof item?.alternative === 'string' && typeof item?.reason === 'string')) issues.push(`${label}.alternativesRejected is invalid`);
  if (artifact.type === 'architecture_decision' && !meaningfulText(artifact.decision, 4)) issues.push(`${label} architecture decision must state the decision`);
  if (artifact.type === 'action_item' && !hasActionItemBody(artifact)) issues.push(`${label} action item is overly vague`);
  if (artifact.type === 'bug_report' && (!artifact.description || !artifact.expectedBehavior || !artifact.actualBehavior)) issues.push(`${label} bug report must describe the issue, expected behavior, and actual behavior`);
  if (artifact.type === 'bug_report' && Array.isArray(artifact.stepsToReproduce) && artifact.stepsToReproduce.length && (!Array.isArray(artifact.evidenceUtteranceIds) || !artifact.evidenceUtteranceIds.length)) issues.push(`${label} has unsupported reproduction steps`);
  if (artifact.type === 'risk' && (!artifact.description || !artifact.impact)) issues.push(`${label} risk must include a description and impact`);
  if (artifact.type === 'open_question' && !meaningfulText(artifact.question, 4)) issues.push(`${label} open question must state the question`);
  if (Array.isArray(artifact.evidenceUtteranceIds) && Array.isArray(artifact.contextSourceIds) && !artifact.evidenceUtteranceIds.length && !artifact.contextSourceIds.length) issues.push(`${label} must reference transcript evidence or approved project context`);
  const duplicateKey = typeof artifact.title === 'string' ? `${artifact.type}:${normalizedTitle(artifact.title)}` : label;
  if (duplicates.has(duplicateKey)) issues.push(`${label} duplicates another artifact`);
  // Only a clean artifact claims the key: a rejected one is dropped, so an identical later proposal is new.
  else if (!issues.length) duplicates.add(duplicateKey);
  return issues;
}

function inspectArtifacts(payload, { meetingId, participants, utterances, contextSelection = null }) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.artifacts)) {
    throw new ArtifactValidationError(['root.artifacts must be an array']);
  }
  const rootIssues = [];
  for (const field of Object.keys(payload)) if (field !== 'artifacts') rootIssues.push(`root.${field} is not allowed`);
  if (payload.artifacts.length > 30) rootIssues.push('no more than 30 artifacts may be returned');
  const utteranceById = new Map(utterances.map((utterance) => [utterance.id, utterance]));
  const contextSourceById = new Map((contextSelection?.sources ?? []).map((source) => [source.id, source]));
  const participantNames = new Set(participants.map((participant) => participant.name).filter(Boolean));
  const duplicates = new Set();
  const issuesByIndex = payload.artifacts.map((artifact, index) => collectArtifactIssues(artifact, `artifacts[${index}]`, { utteranceById, contextSourceById, participantNames, duplicates }));
  return { rootIssues, issuesByIndex, meetingId, contextSelection, utteranceById, contextSourceById };
}

function hydrateArtifact(artifact, { meetingId, contextSelection, utteranceById, contextSourceById, now }) {
  const evidence = artifact.evidenceUtteranceIds.map((utteranceId) => {
    const utterance = utteranceById.get(utteranceId);
    return {
      utteranceId,
      speaker: utterance.speakerName ?? utterance.speaker,
      startTime: utterance.startTimestamp?.relative ?? null,
      endTime: utterance.endTimestamp?.relative ?? null,
      text: utterance.text,
    };
  });
  const contextSources = artifact.contextSourceIds.map((sourceId) => {
    const source = contextSourceById.get(sourceId);
    return { sourceId, kind: source.kind, label: source.label, revision: source.revision, sourcePath: source.sourcePath ?? null, ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}), lineStart: source.lineStart ?? null, lineEnd: source.lineEnd ?? null, ingestionId: source.ingestionId ?? null, truncated: Boolean(source.truncated), trackedFiles: source.trackedFiles ?? [] };
  });
  const { type, title, status, confidence, evidenceUtteranceIds, contextSourceIds, ...content } = artifact;
  return {
    id: crypto.randomUUID(),
    meetingId,
    type,
    status,
    title: title.trim(),
    content,
    confidence,
    evidence,
    contextProvenance: contextSelection ? {
      selectionId: contextSelection.id,
      projectId: contextSelection.projectId,
      contentSha256: contextSelection.contentSha256,
      sources: contextSources,
    } : null,
    evidenceState: evidence.length ? 'supported' : 'missing',
    validationWarnings: evidence.length ? [] : ['No transcript evidence was supplied.'],
    source: 'groq',
    createdAt: now,
    updatedAt: now,
  };
}

export function validateAndHydrateArtifacts(payload, context) {
  const inspected = inspectArtifacts(payload, context);
  const issues = [...inspected.rootIssues, ...inspected.issuesByIndex.flat()];
  if (issues.length) throw new ArtifactValidationError(issues);
  const now = new Date().toISOString();
  return payload.artifacts.map((artifact) => hydrateArtifact(artifact, { ...inspected, now }));
}

// Analysis keeps every artifact that validates and reports the rest, so a single malformed proposal
// cannot discard an otherwise grounded batch. Root-level problems still reject the whole payload,
// as does a batch in which nothing survived — neither leaves anything trustworthy to store.
export function validateAndHydrateSupportedArtifacts(payload, context) {
  const inspected = inspectArtifacts(payload, context);
  if (inspected.rootIssues.length) throw new ArtifactValidationError(inspected.rootIssues);
  const now = new Date().toISOString();
  const artifacts = [];
  const rejected = [];
  payload.artifacts.forEach((artifact, index) => {
    const issues = inspected.issuesByIndex[index];
    if (!issues.length) { artifacts.push(hydrateArtifact(artifact, { ...inspected, now })); return; }
    rejected.push({
      index,
      type: artifactTypes.includes(artifact?.type) ? artifact.type : null,
      title: typeof artifact?.title === 'string' ? artifact.title.trim().slice(0, 120) : null,
      issues,
    });
  });
  if (!artifacts.length && rejected.length) throw new ArtifactValidationError(inspected.issuesByIndex.flat());
  return { artifacts, rejected };
}

export function validateArtifactRevision(artifact, revision, context) {
  const issues = [];
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) throw new ArtifactValidationError(['revision must be an object']);
  for (const field of Object.keys(revision)) if (!['title', 'content'].includes(field)) issues.push(`revision.${field} is not editable`);
  if (revision.title !== undefined && typeof revision.title !== 'string') issues.push('revision.title must be a string');
  if (revision.title === undefined && revision.content === undefined) issues.push('revision must include a title or content change');
  if (revision.content !== undefined && (!revision.content || typeof revision.content !== 'object' || Array.isArray(revision.content))) issues.push('revision.content must be an object');
  if (revision.content && typeof revision.content === 'object' && !Array.isArray(revision.content)) {
    for (const field of Object.keys(revision.content)) if (!editableContentFields.has(field)) issues.push(`revision.content.${field} is not editable`);
  }
  if (issues.length) throw new ArtifactValidationError(issues);
  const candidate = {
    type: artifact.type,
    title: revision.title ?? artifact.title,
    status: 'proposed',
    summary: null,
    problem: null,
    whyItMatters: null,
    proposedImplementationAreas: [],
    dependencies: [],
    risks: [],
    openQuestions: [],
    repositoryReferences: [],
    ...artifact.content,
    ...(revision.content ?? {}),
    evidenceUtteranceIds: (artifact.evidence ?? []).map((item) => item.utteranceId),
    contextSourceIds: (artifact.contextProvenance?.sources ?? []).map((item) => item.sourceId),
    confidence: artifact.confidence,
  };
  const contextSelection = artifact.contextProvenance ? {
    id: artifact.contextProvenance.selectionId,
    projectId: artifact.contextProvenance.projectId,
    contentSha256: artifact.contextProvenance.contentSha256,
    sources: artifact.contextProvenance.sources.map((source) => ({ id: source.sourceId, ...source })),
  } : null;
  const [validated] = validateAndHydrateArtifacts({ artifacts: [candidate] }, { ...context, meetingId: artifact.meetingId, contextSelection });
  return { title: validated.title, content: validated.content };
}
