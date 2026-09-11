/** Local ticket workspace: creates immutable ticket snapshots from approved meeting artifacts only. */
export const ticketArtifactTypes = new Set(['action_item', 'bug_report']);
export const ticketStatuses = new Set(['open', 'in_progress', 'blocked', 'done']);
export const ticketPriorities = new Set(['low', 'medium', 'high', 'critical']);

export class TicketValidationError extends Error {
  constructor(issues) {
    super(`Ticket validation failed: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

const optionalText = (value, field, issues, maximumLength) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maximumLength) {
    issues.push(`${field} must be null or a string of at most ${maximumLength} characters`);
    return null;
  }
  return value.trim() || null;
};

const artifactPriority = (artifact) => artifact.content?.priority ?? artifact.content?.severity ?? artifact.content?.impact ?? null;
const artifactOwner = (artifact) => artifact.content?.assignee ?? artifact.content?.owner ?? artifact.content?.suggestedOwner ?? null;
const artifactDescription = (artifact) => artifact.content?.summary ?? artifact.content?.description ?? artifact.content?.problem ?? null;

/** Creates an immutable local-work snapshot only after human approval has made the source artifact actionable. */
export function ticketFromArtifact({ id, artifact, meeting, now = new Date().toISOString() }) {
  if (!artifact || artifact.status !== 'approved') throw new TicketValidationError(['Only approved artifacts can create local tickets.']);
  if (!ticketArtifactTypes.has(artifact.type)) throw new TicketValidationError(['Only action items and bug reports can create local tickets.']);
  const priority = artifactPriority(artifact);
  return {
    id,
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    sourceArtifactId: artifact.id,
    sourceArtifactVersion: artifact.version ?? 1,
    type: artifact.type,
    title: artifact.title,
    description: artifactDescription(artifact),
    status: 'open',
    priority: ticketPriorities.has(priority) ? priority : null,
    owner: artifactOwner(artifact),
    notes: null,
    evidence: structuredClone(artifact.evidence ?? []),
    contextProvenance: structuredClone(artifact.contextProvenance ?? null),
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

/** Ticket edits intentionally exclude source evidence and artifact links, which must remain traceable to the approved snapshot. */
export function validateTicketUpdate(input) {
  const issues = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TicketValidationError(['Request body must be a JSON object.']);
  if (Object.keys(input).some((field) => !['expectedVersion', 'status', 'priority', 'owner', 'notes'].includes(field))) issues.push('Request body contains unsupported fields.');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) issues.push('expectedVersion must be a positive integer.');
  if (!ticketStatuses.has(input.status)) issues.push('status is invalid.');
  if (input.priority !== null && !ticketPriorities.has(input.priority)) issues.push('priority is invalid.');
  const owner = optionalText(input.owner, 'owner', issues, 100);
  const notes = optionalText(input.notes, 'notes', issues, 5_000);
  if (issues.length) throw new TicketValidationError(issues);
  return { expectedVersion: input.expectedVersion, status: input.status, priority: input.priority, owner, notes };
}
