import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
    };
  }
  persist() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  addMeeting(meeting) { this.data.meetings[meeting.id] = meeting; this.persist(); return meeting; }
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
  findTranscriptByMeetingId(meetingId) { return Object.values(this.data.transcripts).find((transcript) => transcript.meetingId === meetingId) ?? null; }
  getTranscript(id) { return this.data.transcripts[id] ?? null; }
  recordLifecycle(lifecycle) {
    const meeting = this.findMeetingByBotId(lifecycle.botId)
      ?? (lifecycle.schedulingIntentId ? this.data.meetings[lifecycle.schedulingIntentId] : null);
    if (!meeting) return null;
    meeting.botId = lifecycle.botId;
    meeting.recallBotId = lifecycle.botId;
    const history = Array.isArray(meeting.statusHistory) ? meeting.statusHistory : [];
    const entry = {
      eventType: lifecycle.eventType,
      status: lifecycle.status,
      code: lifecycle.code,
      subCode: lifecycle.subCode,
      message: lifecycle.message,
      occurredAt: lifecycle.occurredAt,
    };
    const duplicate = history.some((item) => item.eventType === entry.eventType
      && item.code === entry.code
      && item.subCode === entry.subCode
      && item.occurredAt === entry.occurredAt);
    if (!duplicate) history.push(entry);
    history.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    meeting.statusHistory = history;
    const latest = history.at(-1);
    const failure = [...history].reverse().find((item) => item.status === 'failed');
    meeting.status = failure ? 'failed' : latest.status;
    meeting.error = failure ? { code: failure.code, subCode: failure.subCode, message: failure.message } : null;
    const recording = history.find((item) => item.status === 'recording');
    if (recording) meeting.startedAt = recording.occurredAt;
    const ended = [...history].reverse().find((item) => ['processing', 'complete', 'failed'].includes(item.status));
    if (ended) meeting.endedAt = ended.occurredAt;
    if (failure) meeting.processingStatus = 'failed';
    else if (latest.status === 'complete') meeting.processingStatus = meeting.transcriptStatus === 'done' ? 'complete' : 'awaiting_transcript';
    else if (latest.status === 'processing') meeting.processingStatus = 'awaiting_recording';
    meeting.updatedAt = new Date().toISOString();
    this.persist();
    return meeting;
  }
  claim(key) { if (this.data.processed[key]) return false; this.data.processed[key] = new Date().toISOString(); this.persist(); return true; }
  releaseClaim(key) { if (this.data.processed[key]) { delete this.data.processed[key]; this.persist(); } }
  rememberEvent(id, patch) { this.data.events[id] = { ...(this.data.events[id] ?? {}), ...patch }; this.persist(); }
  saveTranscript(id, transcript) { this.data.transcripts[id] = transcript; this.persist(); return transcript; }
  seedMock({ meeting, transcript, artifacts = [] }) {
    if (!this.data.meetings[meeting.id]) this.data.meetings[meeting.id] = structuredClone(meeting);
    if (!this.data.transcripts[transcript.id]) this.data.transcripts[transcript.id] = structuredClone(transcript);
    for (const artifact of artifacts) if (!this.data.artifacts[artifact.id]) this.data.artifacts[artifact.id] = structuredClone(artifact);
    this.persist();
  }
  beginAnalysis(meetingId) {
    const active = Object.values(this.data.analyses).find((analysis) => analysis.meetingId === meetingId && analysis.status === 'running');
    if (active) return null;
    const now = new Date().toISOString();
    const analysis = { id: crypto.randomUUID(), meetingId, status: 'running', trigger: 'manual', createdAt: now, updatedAt: now, error: null };
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
  dashboard() {
    const meetings = Object.values(this.data.meetings).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { mockMode: false, meetings, intents: meetings, transcripts: Object.values(this.data.transcripts), artifacts: Object.values(this.data.artifacts), analyses: Object.values(this.data.analyses), reviewEvents: Object.values(this.data.reviewEvents) };
  }
}
