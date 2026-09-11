/** Demo JSON store for meeting state, webhook idempotency, analysis jobs, and review audit history. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canAdvanceMeetingState, canonicalMeetingStates, canonicalizeMeetingState, recoveryActionsForMeeting } from './lifecycle.js';

const canonicalStateSet = new Set(canonicalMeetingStates);

const normalizeHistoryEntry = (entry, attempt) => ({
  ...entry,
  status: entry.status ? canonicalizeMeetingState(entry.status) : null,
  providerStatus: entry.providerStatus ?? entry.code ?? entry.status ?? entry.eventType,
  attempt: entry.attempt ?? attempt,
});

const normalizeMeetingLifecycle = (meeting) => {
  meeting.lifecycleAttempt = Number.isInteger(meeting.lifecycleAttempt) && meeting.lifecycleAttempt > 0 ? meeting.lifecycleAttempt : 1;
  meeting.lifecycleAttemptStartedAt ??= meeting.createdAt ?? new Date().toISOString();
  meeting.statusHistory = (Array.isArray(meeting.statusHistory) ? meeting.statusHistory : []).map((entry) => normalizeHistoryEntry(entry, meeting.lifecycleAttempt));
  meeting.status = canonicalStateSet.has(meeting.canonicalState)
    ? meeting.canonicalState
    : canonicalizeMeetingState(meeting.status, meeting.transcriptStatus);
  meeting.canonicalState = meeting.status;
  meeting.stateUpdatedAt ??= meeting.statusHistory.at(-1)?.occurredAt ?? meeting.updatedAt ?? meeting.createdAt;
  return meeting;
};

export class JsonStore {
  constructor(file = path.resolve('data/recall-store.json')) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    this.data = {
      meetings: stored.meetings ?? stored.intents ?? {},
      events: stored.events ?? {},
      processed: stored.processed ?? {},
      transcripts: stored.transcripts ?? {},
      artifacts: stored.artifacts ?? {},
      analyses: stored.analyses ?? {},
      reviewEvents: stored.reviewEvents ?? {},
      tickets: stored.tickets ?? {},
      ticketEvents: stored.ticketEvents ?? {},
    };
    for (const meeting of Object.values(this.data.meetings)) normalizeMeetingLifecycle(meeting);
  }
  persist() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  addMeeting(meeting) { this.data.meetings[meeting.id] = normalizeMeetingLifecycle(meeting); this.persist(); return meeting; }
  getMeeting(id) { return this.data.meetings[id] ?? null; }
  updateMeeting(id, patch) {
    const meeting = this.data.meetings[id];
    if (!meeting) return null;
    Object.assign(meeting, patch, { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    this.persist();
    return meeting;
  }
  addIntent(intent) { return this.addMeeting(intent); }
  updateIntent(id, patch) { return this.updateMeeting(id, patch); }
  findMeetingByBotId(botId) { return Object.values(this.data.meetings).find((meeting) => meeting.botId === botId || meeting.recallBotId === botId) ?? null; }
  findMeetingBySchedulingKey(schedulingKey) { return Object.values(this.data.meetings).find((meeting) => meeting.schedulingKey === schedulingKey) ?? null; }
  findTranscriptByMeetingId(meetingId) { return Object.values(this.data.transcripts).find((transcript) => transcript.meetingId === meetingId) ?? null; }
  getTranscript(id) { return this.data.transcripts[id] ?? null; }
  recordLifecycle(lifecycle) {
    const meeting = this.findMeetingByBotId(lifecycle.botId)
      ?? (lifecycle.schedulingIntentId ? this.data.meetings[lifecycle.schedulingIntentId] : null);
    if (!meeting) return null;
    meeting.botId = lifecycle.botId;
    meeting.recallBotId = lifecycle.botId;
    normalizeMeetingLifecycle(meeting);
    const history = Array.isArray(meeting.statusHistory) ? meeting.statusHistory : [];
    const entry = {
      eventType: lifecycle.eventType,
      status: lifecycle.status,
      providerStatus: lifecycle.providerStatus,
      code: lifecycle.code,
      subCode: lifecycle.subCode,
      message: lifecycle.message,
      occurredAt: lifecycle.occurredAt,
      attempt: lifecycle.occurredAt < meeting.lifecycleAttemptStartedAt ? Math.max(1, meeting.lifecycleAttempt - 1) : meeting.lifecycleAttempt,
    };
    const duplicate = history.some((item) => item.eventType === entry.eventType
      && item.code === entry.code
      && item.subCode === entry.subCode
      && item.occurredAt === entry.occurredAt);
    if (!duplicate) history.push(entry);
    history.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    meeting.statusHistory = history;
    // A failed Create Bot response is ambiguous: a later Recall lifecycle event proves the bot exists.
    const recoveredFromAmbiguousCreation = meeting.status === 'failed'
      && meeting.error?.code === 'bot_create_failed'
      && entry.status !== 'failed';
    if (entry.attempt === meeting.lifecycleAttempt && entry.status && (recoveredFromAmbiguousCreation || canAdvanceMeetingState(meeting.status, entry.status))) {
      this.applyMeetingState(meeting, entry.status, entry);
    }
    meeting.updatedAt = new Date().toISOString();
    this.persist();
    return meeting;
  }
  applyMeetingState(meeting, state, { occurredAt = new Date().toISOString(), code = null, subCode = null, message = null } = {}) {
    meeting.status = state;
    meeting.canonicalState = state;
    meeting.stateUpdatedAt = occurredAt;
    if (state === 'recording') meeting.startedAt ??= occurredAt;
    if (['transcript_processing', 'completed', 'failed'].includes(state)) meeting.endedAt ??= occurredAt;
    if (state === 'failed') {
      meeting.processingStatus = 'failed';
      meeting.error = { code: code ?? 'capture_failed', subCode, message };
    } else {
      meeting.error = null;
      if (state === 'completed') meeting.processingStatus = 'complete';
      else if (state === 'transcript_processing') meeting.processingStatus = meeting.transcriptStatus === 'pending' ? 'awaiting_transcript' : 'transcribing';
      else meeting.processingStatus ??= 'waiting_for_call';
    }
  }
  setMeetingState(id, state, { eventType, code = state, subCode = null, message = null, occurredAt = new Date().toISOString(), allowRecovery = false } = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    normalizeMeetingLifecycle(meeting);
    const newAttempt = allowRecovery && meeting.status === 'failed' && state === 'transcript_processing';
    if (!canAdvanceMeetingState(meeting.status, state, { newAttempt })) return meeting;
    if (newAttempt) {
      meeting.lifecycleAttempt += 1;
      meeting.lifecycleAttemptStartedAt = occurredAt;
    }
    const entry = { eventType: eventType ?? `app.${state}`, status: state, providerStatus: code, code, subCode, message, occurredAt, attempt: meeting.lifecycleAttempt };
    meeting.statusHistory.push(entry);
    meeting.statusHistory.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    this.applyMeetingState(meeting, state, entry);
    meeting.updatedAt = new Date().toISOString();
    this.persist();
    return meeting;
  }
  claim(key) { if (this.data.processed[key]) return false; this.data.processed[key] = new Date().toISOString(); this.persist(); return true; }
  releaseClaim(key) { if (this.data.processed[key]) { delete this.data.processed[key]; this.persist(); } }
  rememberEvent(id, patch) { this.data.events[id] = { ...(this.data.events[id] ?? {}), ...patch }; this.persist(); }
  saveTranscript(id, transcript) { this.data.transcripts[id] = transcript; this.persist(); return transcript; }
  seedMock({ meeting, transcript, artifacts = [] }) {
    if (!this.data.meetings[meeting.id]) this.data.meetings[meeting.id] = normalizeMeetingLifecycle(structuredClone(meeting));
    if (!this.data.transcripts[transcript.id]) this.data.transcripts[transcript.id] = structuredClone(transcript);
    for (const artifact of artifacts) if (!this.data.artifacts[artifact.id]) this.data.artifacts[artifact.id] = structuredClone(artifact);
    this.persist();
  }
  resetMock({ meeting, transcript, artifacts = [] }) {
    const meetingId = meeting.id;
    delete this.data.meetings[meetingId];
    for (const [id, storedTranscript] of Object.entries(this.data.transcripts)) {
      if (id === transcript.id || (storedTranscript.meetingId === meetingId && storedTranscript.isMock === true)) delete this.data.transcripts[id];
    }
    for (const [id, artifact] of Object.entries(this.data.artifacts)) {
      if (artifact.meetingId === meetingId) delete this.data.artifacts[id];
    }
    for (const [id, analysis] of Object.entries(this.data.analyses)) {
      if (analysis.meetingId === meetingId) delete this.data.analyses[id];
    }
    for (const [id, reviewEvent] of Object.entries(this.data.reviewEvents)) {
      if (reviewEvent.meetingId === meetingId) delete this.data.reviewEvents[id];
    }
    for (const [id, ticket] of Object.entries(this.data.tickets)) if (ticket.meetingId === meetingId) delete this.data.tickets[id];
    for (const [id, ticketEvent] of Object.entries(this.data.ticketEvents)) if (ticketEvent.meetingId === meetingId) delete this.data.ticketEvents[id];
    this.data.meetings[meetingId] = normalizeMeetingLifecycle(structuredClone(meeting));
    this.data.transcripts[transcript.id] = structuredClone(transcript);
    for (const artifact of artifacts) this.data.artifacts[artifact.id] = structuredClone(artifact);
    this.persist();
    return this.getMeeting(meetingId);
  }
  deleteManualMeeting(meetingId) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting || meeting.source !== 'manual') return { deleted: false, reason: 'not_manual' };
    const reviewEvents = this.reviewEventsForMeeting(meetingId).filter((event) => event.action !== 'generated');
    if (reviewEvents.length) return { deleted: false, reason: 'reviewed' };
    delete this.data.meetings[meetingId];
    for (const [id, transcript] of Object.entries(this.data.transcripts)) if (transcript.meetingId === meetingId) delete this.data.transcripts[id];
    for (const [id, artifact] of Object.entries(this.data.artifacts)) if (artifact.meetingId === meetingId) delete this.data.artifacts[id];
    for (const [id, analysis] of Object.entries(this.data.analyses)) if (analysis.meetingId === meetingId) delete this.data.analyses[id];
    for (const [id, event] of Object.entries(this.data.reviewEvents)) if (event.meetingId === meetingId) delete this.data.reviewEvents[id];
    for (const [id, ticket] of Object.entries(this.data.tickets)) if (ticket.meetingId === meetingId) delete this.data.tickets[id];
    for (const [id, ticketEvent] of Object.entries(this.data.ticketEvents)) if (ticketEvent.meetingId === meetingId) delete this.data.ticketEvents[id];
    this.persist();
    return { deleted: true };
  }
  beginAnalysis(meetingId, metadata = {}) {
    const active = Object.values(this.data.analyses).find((analysis) => analysis.meetingId === meetingId && analysis.status === 'running');
    if (active) return null;
    const now = new Date().toISOString();
    const analysis = { id: crypto.randomUUID(), meetingId, status: 'running', trigger: 'manual', contextSelectionId: metadata.contextSelectionId ?? null, contextSelectionSha256: metadata.contextSelectionSha256 ?? null, projectId: metadata.projectId ?? null, createdAt: now, updatedAt: now, error: null };
    this.data.analyses[analysis.id] = analysis;
    this.persist();
    return analysis;
  }
  finishAnalysis(id, patch) {
    const analysis = this.data.analyses[id];
    if (!analysis) return null;
    Object.assign(analysis, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    return analysis;
  }
  latestAnalysis(meetingId) {
    return Object.values(this.data.analyses)
      .filter((analysis) => analysis.meetingId === meetingId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }
  replaceProposedArtifacts(meetingId, artifacts) {
    for (const [id, artifact] of Object.entries(this.data.artifacts)) {
      if (artifact.meetingId === meetingId && artifact.status === 'proposed') delete this.data.artifacts[id];
    }
    for (const artifact of artifacts) {
      const storedArtifact = {
        ...artifact,
        version: 1,
        userEdited: false,
        reviewedAt: null,
        rejectionNote: null,
        originalProposal: {
          title: artifact.title,
          content: structuredClone(artifact.content),
          confidence: artifact.confidence,
          evidence: structuredClone(artifact.evidence),
          evidenceState: artifact.evidenceState,
          validationWarnings: structuredClone(artifact.validationWarnings),
        },
      };
      this.data.artifacts[artifact.id] = storedArtifact;
      this.recordReviewEvent(artifact.id, meetingId, 'generated', { toStatus: 'proposed', version: 1 }, false);
    }
    this.persist();
    return artifacts.map((artifact) => this.data.artifacts[artifact.id]);
  }
  getArtifact(id) { return this.data.artifacts[id] ?? null; }
  recordReviewEvent(artifactId, meetingId, action, details, shouldPersist = true) {
    const event = { id: crypto.randomUUID(), artifactId, meetingId, action, actor: action === 'generated' ? 'system' : 'local_user', occurredAt: new Date().toISOString(), ...details };
    this.data.reviewEvents[event.id] = event;
    if (shouldPersist) this.persist();
    return event;
  }
  updateArtifact(id, { expectedVersion, action, title, content, note = null }) {
    const artifact = this.getArtifact(id);
    if (!artifact) return null;
    const currentVersion = artifact.version ?? 1;
    if (currentVersion !== expectedVersion) return { conflict: true, artifact };
    const allowedStatuses = action === 'approve' ? ['proposed', 'needs_changes']
      : action === 'reject' ? ['proposed', 'needs_changes', 'approved']
        : action === 'edit' ? ['proposed', 'needs_changes', 'approved']
          : action === 'restore' ? ['proposed', 'needs_changes', 'approved', 'rejected']
            : [];
    if (!allowedStatuses.includes(artifact.status)) return { invalidTransition: true, artifact };
    const previousStatus = artifact.status;
    if (!artifact.originalProposal) artifact.originalProposal = {
      title: artifact.title,
      content: structuredClone(artifact.content),
      confidence: artifact.confidence,
      evidence: structuredClone(artifact.evidence ?? []),
      evidenceState: artifact.evidenceState,
      validationWarnings: structuredClone(artifact.validationWarnings ?? []),
    };
    if (action === 'edit') {
      artifact.title = title;
      artifact.content = content;
      artifact.status = 'needs_changes';
      artifact.userEdited = true;
    } else if (action === 'approve') {
      artifact.status = 'approved';
      artifact.rejectionNote = null;
    } else if (action === 'reject') {
      artifact.status = 'rejected';
      artifact.rejectionNote = note;
    } else if (action === 'restore') {
      artifact.title = artifact.originalProposal.title;
      artifact.content = structuredClone(artifact.originalProposal.content);
      artifact.confidence = artifact.originalProposal.confidence;
      artifact.evidence = structuredClone(artifact.originalProposal.evidence);
      artifact.evidenceState = artifact.originalProposal.evidenceState;
      artifact.validationWarnings = structuredClone(artifact.originalProposal.validationWarnings);
      artifact.status = 'proposed';
      artifact.userEdited = false;
      artifact.rejectionNote = null;
    } else {
      throw new Error(`Unsupported review action: ${action}`);
    }
    artifact.version = currentVersion + 1;
    artifact.reviewedAt = new Date().toISOString();
    artifact.updatedAt = artifact.reviewedAt;
    this.recordReviewEvent(id, artifact.meetingId, action, { fromStatus: previousStatus, toStatus: artifact.status, version: artifact.version, note }, false);
    this.persist();
    return { artifact, conflict: false, invalidTransition: false };
  }
  reviewEventsForArtifact(artifactId) {
    return Object.values(this.data.reviewEvents).filter((event) => event.artifactId === artifactId).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }
  reviewEventsForMeeting(meetingId) {
    return Object.values(this.data.reviewEvents).filter((event) => event.meetingId === meetingId).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }
  artifactsForMeeting(meetingId) { return Object.values(this.data.artifacts).filter((artifact) => artifact.meetingId === meetingId); }
  ticketForArtifactVersion(artifactId, artifactVersion) {
    return Object.values(this.data.tickets).find((ticket) => ticket.sourceArtifactId === artifactId && ticket.sourceArtifactVersion === artifactVersion) ?? null;
  }
  createTicket(ticket) {
    const existing = this.ticketForArtifactVersion(ticket.sourceArtifactId, ticket.sourceArtifactVersion);
    if (existing) return { ticket: existing, created: false };
    this.data.tickets[ticket.id] = ticket;
    this.recordTicketEvent(ticket, 'created', { version: ticket.version }, false);
    this.persist();
    return { ticket, created: true };
  }
  getTicket(id) { return this.data.tickets[id] ?? null; }
  updateTicket(id, { expectedVersion, status, priority, owner, notes }) {
    const ticket = this.getTicket(id);
    if (!ticket) return null;
    if (ticket.version !== expectedVersion) return { conflict: true, ticket };
    const before = { status: ticket.status, priority: ticket.priority, owner: ticket.owner, notes: ticket.notes };
    Object.assign(ticket, { status, priority, owner, notes, version: ticket.version + 1, updatedAt: new Date().toISOString() });
    this.recordTicketEvent(ticket, 'updated', { from: before, to: { status, priority, owner, notes }, version: ticket.version }, false);
    this.persist();
    return { ticket, conflict: false };
  }
  recordTicketEvent(ticket, action, details, shouldPersist = true) {
    const event = { id: crypto.randomUUID(), ticketId: ticket.id, meetingId: ticket.meetingId, action, actor: 'local_user', occurredAt: new Date().toISOString(), ...details };
    this.data.ticketEvents[event.id] = event;
    if (shouldPersist) this.persist();
    return event;
  }
  ticketEventsForTicket(ticketId) { return Object.values(this.data.ticketEvents).filter((event) => event.ticketId === ticketId).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)); }
  tickets() { return Object.values(this.data.tickets).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); }
  dashboard() {
    const meetings = Object.values(this.data.meetings)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((meeting) => ({ ...meeting, recoveryActions: recoveryActionsForMeeting(meeting) }));
    return { mockMode: false, meetings, intents: meetings, transcripts: Object.values(this.data.transcripts), artifacts: Object.values(this.data.artifacts), analyses: Object.values(this.data.analyses), reviewEvents: Object.values(this.data.reviewEvents), tickets: this.tickets(), ticketEvents: Object.values(this.data.ticketEvents) };
  }
}
