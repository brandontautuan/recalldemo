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
          evidenceUtteranceIds: stringArray,
          confidence: { type: 'string', enum: confidenceValues },
        },
        required: ['type', 'title', 'status', 'description', 'context', 'decision', 'alternativesRejected', 'consequences', 'assignee', 'dueDate', 'acceptanceCriteria', 'priority', 'stepsToReproduce', 'expectedBehavior', 'actualBehavior', 'severity', 'impact', 'mitigation', 'owner', 'question', 'suggestedOwner', 'evidenceUtteranceIds', 'confidence'],
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
const immutableArtifactFields = new Set(['type', 'status', 'evidenceUtteranceIds', 'confidence']);
const editableContentFields = new Set([...artifactFields].filter((field) => !immutableArtifactFields.has(field) && field !== 'title'));

export function validateAndHydrateArtifacts(payload, { meetingId, participants, utterances }) {
  const issues = [];
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.artifacts)) {
    throw new ArtifactValidationError(['root.artifacts must be an array']);
  }
  for (const field of Object.keys(payload)) if (field !== 'artifacts') issues.push(`root.${field} is not allowed`);
  if (payload.artifacts.length > 30) issues.push('no more than 30 artifacts may be returned');
  const utteranceById = new Map(utterances.map((utterance) => [utterance.id, utterance]));
  const participantNames = new Set(participants.map((participant) => participant.name).filter(Boolean));
  const duplicates = new Set();

  payload.artifacts.forEach((artifact, index) => {
    const label = `artifacts[${index}]`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) { issues.push(`${label} must be an object`); return; }
    for (const field of Object.keys(artifact)) if (!artifactFields.has(field)) issues.push(`${label}.${field} is not allowed`);
    for (const field of artifactFields) if (!(field in artifact)) issues.push(`${label}.${field} is required`);
    if (!artifactTypes.includes(artifact.type)) issues.push(`${label}.type is unsupported`);
    if (typeof artifact.title !== 'string' || artifact.title.trim().length < 4) issues.push(`${label}.title is too vague`);
    if (artifact.status !== 'proposed') issues.push(`${label}.status must be proposed`);
    if (!confidenceValues.includes(artifact.confidence)) issues.push(`${label}.confidence is invalid`);
    if (!isStringArray(artifact.evidenceUtteranceIds)) issues.push(`${label}.evidenceUtteranceIds must be a string array`);
    else for (const id of artifact.evidenceUtteranceIds) if (!utteranceById.has(id)) issues.push(`${label} references unknown evidence ${id}`);
    if (artifact.assignee !== null && !participantNames.has(artifact.assignee)) issues.push(`${label}.assignee is not a meeting participant`);
    if (artifact.owner !== null && !participantNames.has(artifact.owner)) issues.push(`${label}.owner is not a meeting participant`);
    if (artifact.suggestedOwner !== null && !participantNames.has(artifact.suggestedOwner)) issues.push(`${label}.suggestedOwner is not a meeting participant`);
    if (!priorityValues.includes(artifact.priority)) issues.push(`${label}.priority is invalid`);
    if (!priorityValues.includes(artifact.severity)) issues.push(`${label}.severity is invalid`);
    if (!priorityValues.includes(artifact.impact)) issues.push(`${label}.impact is invalid`);
    for (const field of ['description', 'context', 'decision', 'assignee', 'dueDate', 'expectedBehavior', 'actualBehavior', 'mitigation', 'owner', 'question', 'suggestedOwner']) {
      if (!isNullableString(artifact[field])) issues.push(`${label}.${field} must be a string or null`);
    }
    for (const field of ['consequences', 'acceptanceCriteria', 'stepsToReproduce']) if (!isStringArray(artifact[field])) issues.push(`${label}.${field} must be a string array`);
    if (!Array.isArray(artifact.alternativesRejected) || !artifact.alternativesRejected.every((item) => typeof item?.alternative === 'string' && typeof item?.reason === 'string')) issues.push(`${label}.alternativesRejected is invalid`);
    if (artifact.type === 'architecture_decision' && (!artifact.decision || artifact.decision.trim().length < 4)) issues.push(`${label} architecture decision must state the decision`);
    if (artifact.type === 'action_item' && (!artifact.description || artifact.description.trim().length < 10)) issues.push(`${label} action item is overly vague`);
    if (artifact.type === 'bug_report' && (!artifact.description || !artifact.expectedBehavior || !artifact.actualBehavior)) issues.push(`${label} bug report must describe the issue, expected behavior, and actual behavior`);
    if (artifact.type === 'bug_report' && Array.isArray(artifact.stepsToReproduce) && artifact.stepsToReproduce.length && (!Array.isArray(artifact.evidenceUtteranceIds) || !artifact.evidenceUtteranceIds.length)) issues.push(`${label} has unsupported reproduction steps`);
    if (artifact.type === 'risk' && (!artifact.description || !artifact.impact)) issues.push(`${label} risk must include a description and impact`);
    if (artifact.type === 'open_question' && (!artifact.question || artifact.question.trim().length < 4)) issues.push(`${label} open question must state the question`);
    const duplicateKey = typeof artifact.title === 'string' ? `${artifact.type}:${normalizedTitle(artifact.title)}` : label;
    if (duplicates.has(duplicateKey)) issues.push(`${label} duplicates another artifact`);
    duplicates.add(duplicateKey);
  });
  if (issues.length) throw new ArtifactValidationError(issues);

  const now = new Date().toISOString();
  return payload.artifacts.map((artifact) => {
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
    const { type, title, status, confidence, evidenceUtteranceIds, ...content } = artifact;
    return {
      id: crypto.randomUUID(),
      meetingId,
      type,
      status,
      title: title.trim(),
      content,
      confidence,
      evidence,
      evidenceState: evidence.length ? 'supported' : 'missing',
      validationWarnings: evidence.length ? [] : ['No transcript evidence was supplied.'],
      source: 'groq',
      createdAt: now,
      updatedAt: now,
    };
  });
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
    ...artifact.content,
    ...(revision.content ?? {}),
    evidenceUtteranceIds: (artifact.evidence ?? []).map((item) => item.utteranceId),
    confidence: artifact.confidence,
  };
  const [validated] = validateAndHydrateArtifacts({ artifacts: [candidate] }, { ...context, meetingId: artifact.meetingId });
  return { title: validated.title, content: validated.content };
}
