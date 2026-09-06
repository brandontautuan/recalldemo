import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyRecallRequest } from './verify.js';
import { calculateMeetingAnalytics, normalizeTranscript } from './transcript.js';
import { normalizeLifecycleEvent, normalizeRetrievedStatus } from './lifecycle.js';
import { ArtifactValidationError, validateAndHydrateArtifacts, validateArtifactRevision } from './artifacts.js';
import { GroqBusyError, GroqConfigurationError, GroqRateLimitError } from './groq-client.js';
import { createArtifactExport, ExportValidationError, ExportVersionConflictError, safeExportFilename } from './export.js';
import { buildContextSelection, projectContextHash } from './context-selector.js';
import { ContextSelectionIntegrityError } from './context-db.js';
import { mockFixture } from './mock-data.js';

const publicDir = path.resolve('public');
const titleOf = (event) => event.raw?.summary ?? event.raw?.title ?? event.title ?? '';
export const eligibleCalendarEvent = (event, now = new Date()) =>
  !event.is_deleted && Boolean(event.meeting_url) && new Date(event.start_time) > now && titleOf(event).includes('[recall]');

const readBody = async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const meetingTypes = new Set(['architecture_review', 'sprint_planning', 'incident_review', 'bug_triage', 'general_technical_sync']);
const supportedMeetingHost = (hostname) => hostname === 'meet.google.com'
  || hostname === 'teams.microsoft.com'
  || hostname === 'teams.live.com'
  || hostname === 'zoom.us'
  || hostname.endsWith('.zoom.us');

const validMeetingUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && supportedMeetingHost(url.hostname);
  } catch {
    return false;
  }
};

export function createApp({ config, recall, store, analysis, contextStore = null, logger = console }) {
  const meetingForBot = (botId) => botId ? store.findMeetingByBotId(botId) : null;
  const setMeetingState = (meeting, state, details = {}) => typeof store.setMeetingState === 'function'
    ? store.setMeetingState(meeting.id, state, details)
    : store.updateMeeting(meeting.id, {
      status: state,
      processingStatus: state === 'failed' ? 'failed' : meeting.processingStatus,
      error: state === 'failed' ? { code: details.code, subCode: details.subCode ?? null, message: details.message ?? null } : null,
    });

  const requestTranscript = async (recordingId, meeting) => {
    const claimKey = `transcript:${recordingId}`;
    if (!store.claim(claimKey)) return false;
    if (meeting) {
      const retryableFailure = ['transcript_create_failed', 'transcript_download_or_parse_failed', 'transcript_failed', 'transcript_retry_failed'].includes(meeting.error?.code);
      setMeetingState(meeting, 'transcript_processing', { eventType: 'app.transcript_processing', code: 'transcript_processing', allowRecovery: meeting.status === 'failed' && retryableFailure });
      store.updateMeeting(meeting.id, { transcriptStatus: 'creating', processingStatus: 'transcribing', error: null });
    }
    try {
      await recall.createTranscript(recordingId);
      if (meeting) store.updateMeeting(meeting.id, { transcriptStatus: 'pending', processingStatus: 'awaiting_transcript' });
      return true;
    } catch (error) {
      store.releaseClaim(claimKey);
      if (meeting) {
        store.updateMeeting(meeting.id, { transcriptStatus: 'failed' });
        setMeetingState(meeting, 'failed', { eventType: 'app.transcript_failed', code: 'transcript_create_failed', message: 'Recall could not start transcript processing.' });
      }
      throw error;
    }
  };

  const completeTranscript = async ({ transcriptId, recordingId = null, botId = null, artifact = null }) => {
    const claimKey = `transcript-result:${transcriptId}`;
    const existing = store.getTranscript(transcriptId);
    if (existing?.status === 'done') return existing;
    if (!store.claim(claimKey)) return existing;
    const meeting = meetingForBot(botId);
    try {
      const transcriptArtifact = artifact ?? await recall.getTranscript(transcriptId);
      const downloadUrl = transcriptArtifact?.data?.download_url;
      if (typeof downloadUrl !== 'string') throw new Error('Recall transcript artifact had no download URL.');
      const utterances = normalizeTranscript(await recall.downloadTranscript(downloadUrl));
      const analytics = calculateMeetingAnalytics(utterances);
      const transcript = store.saveTranscript(transcriptId, {
        id: transcriptId,
        meetingId: meeting?.id ?? existing?.meetingId ?? null,
        recordingId,
        status: 'done',
        utterances,
        paragraphs: utterances,
        analytics,
        receivedAt: new Date().toISOString(),
      });
      if (meeting) store.updateMeeting(meeting.id, {
        transcriptStatus: 'done',
        processingStatus: 'complete',
        durationMs: analytics.meetingDurationSeconds * 1000,
        participants: analytics.participants.map(({ speakerId, speakerName }) => ({ id: speakerId, name: speakerName })),
        error: null,
      });
      if (meeting) setMeetingState(meeting, 'completed', { eventType: 'app.transcript_ready', code: 'transcript_ready' });
      return transcript;
    } catch (error) {
      store.releaseClaim(claimKey);
      logger.error('transcript-processing-failed', { transcriptId });
      store.saveTranscript(transcriptId, { id: transcriptId, meetingId: meeting?.id ?? existing?.meetingId ?? null, recordingId, status: 'failed', failureCode: 'transcript_download_or_parse_failed', receivedAt: new Date().toISOString() });
      if (meeting) {
        store.updateMeeting(meeting.id, { transcriptStatus: 'failed' });
        setMeetingState(meeting, 'failed', { eventType: 'app.transcript_failed', code: 'transcript_download_or_parse_failed', message: 'The transcript could not be retrieved or normalized.' });
      }
      throw error;
    }
  };

  const reconcileMeeting = async (meeting) => {
    const bot = await recall.getBot(meeting.botId);
    for (const statusChange of Array.isArray(bot?.status_changes) ? bot.status_changes : []) {
      const lifecycle = normalizeRetrievedStatus(meeting.botId, statusChange);
      if (lifecycle) store.recordLifecycle(lifecycle);
    }
    for (const recording of Array.isArray(bot?.recordings) ? bot.recordings : []) {
      const transcript = recording?.media_shortcuts?.transcript;
      if (typeof transcript?.id === 'string' && typeof transcript?.data?.download_url === 'string') {
        await completeTranscript({ transcriptId: transcript.id, recordingId: recording.id ?? null, botId: meeting.botId, artifact: transcript });
      }
    }
    return { bot, meeting: store.getMeeting(meeting.id) };
  };

  const processWebhook = async (event) => {
    const type = event.event ?? event.type;
    const data = event.data ?? {};
    const lifecycle = normalizeLifecycleEvent(event);
    if (lifecycle) {
      store.recordLifecycle(lifecycle);
    } else if (type === 'recording.done') {
      const recordingId = data.recording?.id;
      if (recordingId) await requestTranscript(recordingId, meetingForBot(data.bot?.id));
    } else if (type === 'recording.failed') {
      const meeting = meetingForBot(data.bot?.id);
      const failure = data.data ?? data.status ?? {};
      if (meeting) {
        store.updateMeeting(meeting.id, { transcriptStatus: 'unavailable' });
        setMeetingState(meeting, 'failed', { eventType: 'app.recording_failed', code: 'recording_failed', subCode: failure.sub_code ?? null, message: 'Recall did not make a recording available.' });
      }
    } else if (type === 'transcript.done') {
      const transcriptId = data.transcript?.id;
      if (transcriptId) await completeTranscript({ transcriptId, recordingId: data.recording?.id ?? null, botId: data.bot?.id ?? null });
    } else if (type === 'transcript.failed') {
      const id = data.transcript?.id ?? crypto.randomUUID();
      store.saveTranscript(id, { id, status: 'failed', failureCode: data.status?.sub_code ?? 'unknown', receivedAt: new Date().toISOString() });
      const meeting = data.bot?.id ? store.findMeetingByBotId(data.bot.id) : null;
      if (meeting) {
        store.updateMeeting(meeting.id, { transcriptStatus: 'failed' });
        setMeetingState(meeting, 'failed', { eventType: 'app.transcript_failed', code: 'transcript_failed', subCode: data.status?.sub_code ?? 'unknown', message: 'Recall reported that transcript processing failed.' });
      }
    } else if (type === 'calendar.sync_events') {
      const calendarId = data.calendar_id;
      if (!calendarId) return;
      const response = await recall.listCalendarEvents(calendarId, data.last_updated_ts);
      const events = response.results ?? response.data ?? [];
      for (const calendarEvent of events) {
        if (!eligibleCalendarEvent(calendarEvent)) { store.rememberEvent(calendarEvent.id, { status: 'skipped', reason: 'not-tagged-future-meeting' }); continue; }
        const key = `calendar-schedule:${calendarEvent.id}:${calendarEvent.updated_at}`;
        if (!store.claim(key)) continue;
        const scheduled = await recall.scheduleCalendarEvent(calendarEvent.id, `calendar-event:${calendarEvent.ical_uid ?? calendarEvent.id}`);
        store.rememberEvent(calendarEvent.id, { status: 'scheduled', botIds: scheduled.bots?.map((bot) => bot.id) ?? [], updatedAt: calendarEvent.updated_at });
      }
    } else if (type === 'calendar.update') {
      store.rememberEvent(`calendar:${data.calendar_id}`, { status: 'calendar-updated', updatedAt: new Date().toISOString() });
    }
  };

  return async function app(req, res) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(publicDir, 'index.html'))); }
    if (req.method === 'GET' && url.pathname === '/context-ui-state.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(fs.readFileSync(path.join(publicDir, 'context-ui-state.js'))); }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, { ...store.dashboard(), mockMode: config.mockMode });
    if (req.method === 'GET' && url.pathname === '/api/meetings') return json(res, 200, store.dashboard().meetings);
    if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
      if (!config.mockMode) return json(res, 404, { error: 'Demo reset is available only in mock mode.' });
      let body = {};
      try {
        const rawBody = await readBody(req);
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return json(res, 400, { error: 'Request body must be valid JSON.' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
      if (Object.keys(body).length) return json(res, 400, { error: 'Demo reset does not accept fields.' });
      if (typeof store.resetMock !== 'function') return json(res, 503, { error: 'Demo reset is unavailable.' });
      store.resetMock(mockFixture);
      return json(res, 200, { reset: true, ...store.dashboard(), mockMode: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      if (!contextStore) return json(res, 503, { error: 'Project context is unavailable.' });
      return json(res, 200, { projects: contextStore.listProjects() });
    }
    const projectContextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/context$/);
    if (req.method === 'GET' && projectContextMatch) {
      if (!contextStore) return json(res, 503, { error: 'Project context is unavailable.' });
      const projectId = decodeURIComponent(projectContextMatch[1]);
      const inventory = contextStore.projectInventory(projectId);
      if (!inventory) return json(res, 404, { error: 'Project not found.' });
      if (!inventory.project.isActive) return json(res, 409, { error: 'Project is inactive.' });
      return json(res, 200, inventory);
    }
    const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
    if (req.method === 'GET' && artifactMatch) {
      const artifactId = decodeURIComponent(artifactMatch[1]);
      const artifact = store.getArtifact(artifactId);
      return artifact ? json(res, 200, { artifact, reviewEvents: store.reviewEventsForArtifact(artifactId) }) : json(res, 404, { error: 'Artifact not found.' });
    }
    const reviewMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/(approve|reject|restore)$/);
    if (req.method === 'POST' && reviewMatch) {
      const artifactId = decodeURIComponent(reviewMatch[1]);
      const action = reviewMatch[2];
      const artifact = store.getArtifact(artifactId);
      if (!artifact) return json(res, 404, { error: 'Artifact not found.' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) return json(res, 400, { error: 'A positive integer expectedVersion is required.' });
      if (Object.keys(body).some((field) => !['expectedVersion', 'note'].includes(field))) return json(res, 400, { error: 'Request body contains unsupported fields.' });
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1_000)) return json(res, 400, { error: 'Review note must be a string of at most 1000 characters.' });
      const updated = store.updateArtifact(artifactId, { expectedVersion: body.expectedVersion, action, note: body.note?.trim() || null });
      if (updated.conflict) return json(res, 409, { error: 'Artifact changed since it was loaded.', artifact: updated.artifact });
      if (updated.invalidTransition) return json(res, 409, { error: `Artifact cannot transition via ${action} from its current state.`, artifact: updated.artifact });
      return json(res, 200, { artifact: updated.artifact, reviewEvents: store.reviewEventsForArtifact(artifactId) });
    }
    if (req.method === 'PATCH' && artifactMatch) {
      const artifactId = decodeURIComponent(artifactMatch[1]);
      const artifact = store.getArtifact(artifactId);
      if (!artifact) return json(res, 404, { error: 'Artifact not found.' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) return json(res, 400, { error: 'A positive integer expectedVersion is required.' });
      if (Object.keys(body).some((field) => !['expectedVersion', 'title', 'content'].includes(field))) return json(res, 400, { error: 'Request body contains unsupported fields.' });
      const meeting = store.getMeeting(artifact.meetingId);
      const transcript = store.findTranscriptByMeetingId(artifact.meetingId);
      if (!meeting || !transcript?.utterances) return json(res, 409, { error: 'The source meeting transcript is unavailable for validation.' });
      try {
        const revision = validateArtifactRevision(artifact, { title: body.title, content: body.content }, { participants: meeting.participants ?? [], utterances: transcript.utterances });
        const updated = store.updateArtifact(artifactId, { expectedVersion: body.expectedVersion, action: 'edit', ...revision });
        if (updated.conflict) return json(res, 409, { error: 'Artifact changed since it was loaded.', artifact: updated.artifact });
        if (updated.invalidTransition) return json(res, 409, { error: 'Rejected artifacts must be restored before editing.', artifact: updated.artifact });
        return json(res, 200, { artifact: updated.artifact, reviewEvents: store.reviewEventsForArtifact(artifactId) });
      } catch (error) {
        if (error instanceof ArtifactValidationError) return json(res, 422, { error: 'Artifact edit failed validation.', issues: error.issues });
        throw error;
      }
    }
    const meetingMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
    if (req.method === 'GET' && meetingMatch) {
      const meeting = store.getMeeting(decodeURIComponent(meetingMatch[1]));
      return meeting ? json(res, 200, meeting) : json(res, 404, { error: 'Meeting not found.' });
    }
    const transcriptMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/transcript$/);
    if (req.method === 'GET' && transcriptMatch) {
      const meetingId = decodeURIComponent(transcriptMatch[1]);
      const transcript = store.findTranscriptByMeetingId(meetingId);
      return transcript ? json(res, 200, transcript) : json(res, 404, { error: 'Transcript not found.' });
    }
    const artifactsMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/artifacts$/);
    if (req.method === 'GET' && artifactsMatch) {
      const meetingId = decodeURIComponent(artifactsMatch[1]);
      if (!store.getMeeting(meetingId)) return json(res, 404, { error: 'Meeting not found.' });
      return json(res, 200, { artifacts: store.artifactsForMeeting(meetingId), analysis: store.latestAnalysis(meetingId), reviewEvents: store.reviewEventsForMeeting(meetingId) });
    }
    const contextPreviewMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/context-preview$/);
    if (req.method === 'POST' && contextPreviewMatch) {
      if (!contextStore) return json(res, 503, { error: 'Project context is unavailable.' });
      const meetingId = decodeURIComponent(contextPreviewMatch[1]);
      const meeting = store.getMeeting(meetingId);
      if (!meeting) return json(res, 404, { error: 'Meeting not found.' });
      const transcript = store.findTranscriptByMeetingId(meetingId);
      if (!transcript || transcript.status !== 'done' || !transcript.utterances?.length) return json(res, 409, { error: 'A completed normalized transcript is required before creating a context preview.' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
      if (Object.keys(body).some((field) => !['projectId', 'projectContext'].includes(field))) return json(res, 400, { error: 'Request body contains unsupported fields.' });
      if (typeof body.projectId !== 'string' || !body.projectId.trim()) return json(res, 400, { error: 'projectId is required.' });
      if (body.projectContext !== undefined && (typeof body.projectContext !== 'string' || body.projectContext.length > 4_000)) return json(res, 400, { error: 'Project context must be a string of at most 4000 characters.' });
      const bundle = contextStore.getProjectBundle(body.projectId.trim().toLowerCase());
      if (!bundle) return json(res, 404, { error: 'Project not found.' });
      if (!bundle.project.isActive) return json(res, 409, { error: 'Project is inactive.' });
      const projectContext = body.projectContext?.trim() || null;
      const preview = buildContextSelection({ ...bundle, meeting, transcript, projectContext, maximumCharacters: config.projectContextMaximumCharacters });
      const saved = contextStore.saveContextSelection({ meetingId, projectId: bundle.project.id, ...preview });
      return json(res, 201, { contextSelection: saved });
    }
    const exportMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/export$/);
    if (req.method === 'POST' && exportMatch) {
      const meetingId = decodeURIComponent(exportMatch[1]);
      const meeting = store.getMeeting(meetingId);
      if (!meeting) return json(res, 404, { error: 'Meeting not found.' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Request body must be a JSON object.' });
      if (Object.keys(body).some((field) => !['format', 'selections'].includes(field))) return json(res, 400, { error: 'Request body contains unsupported fields.' });
      try {
        const exportPayload = createArtifactExport({
          meeting,
          selections: body.selections,
          artifacts: store.artifactsForMeeting(meetingId),
          reviewEvents: store.reviewEventsForMeeting(meetingId),
          format: body.format,
        });
        return json(res, 200, { filename: safeExportFilename(meeting.title, body.format), export: exportPayload });
      } catch (error) {
        if (error instanceof ExportVersionConflictError) return json(res, 409, { error: error.message, artifact: error.artifact });
        if (error instanceof ExportValidationError) return json(res, 422, { error: 'Export request failed validation.', issues: error.issues });
        throw error;
      }
    }
    const analyzeMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/analyze$/);
    if (req.method === 'POST' && analyzeMatch) {
      const meetingId = decodeURIComponent(analyzeMatch[1]);
      const meeting = store.getMeeting(meetingId);
      if (!meeting) return json(res, 404, { error: 'Meeting not found.' });
      const transcript = store.findTranscriptByMeetingId(meetingId);
      if (!transcript || transcript.status !== 'done' || !transcript.utterances?.length) return json(res, 409, { error: 'A completed normalized transcript is required before analysis.' });
      let requestBody = {};
      try {
        const rawBody = await readBody(req);
        requestBody = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return json(res, 400, { error: 'Request body must be valid JSON.' });
      }
      if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return json(res, 400, { error: 'Request body must be a JSON object.' });
      if (Object.keys(requestBody).some((field) => !['contextSelectionId', 'projectContext'].includes(field))) return json(res, 400, { error: 'Request body contains unsupported fields.' });
      if (requestBody.projectContext !== undefined && (typeof requestBody.projectContext !== 'string' || requestBody.projectContext.length > 4_000)) {
        return json(res, 400, { error: 'Project context must be a string of at most 4000 characters.' });
      }
      if (requestBody.contextSelectionId !== undefined && (typeof requestBody.contextSelectionId !== 'string' || !requestBody.contextSelectionId.trim() || requestBody.contextSelectionId.length > 128)) {
        return json(res, 400, { error: 'contextSelectionId must be a non-empty string of at most 128 characters.' });
      }
      const projectContext = requestBody.projectContext?.trim() || null;
      let contextSelection = null;
      if (requestBody.contextSelectionId !== undefined) {
        if (!contextStore) return json(res, 503, { error: 'Project context is unavailable.' });
        try { contextSelection = contextStore.getContextSelection(requestBody.contextSelectionId.trim()); }
        catch (error) {
          if (error instanceof ContextSelectionIntegrityError) return json(res, 409, { error: 'The saved context preview failed its integrity check. Create a new preview.' });
          logger.error('context-selection-read-failed', { meetingId });
          return json(res, 503, { error: 'The saved context preview is temporarily unavailable.' });
        }
        if (!contextSelection) return json(res, 404, { error: 'Context preview not found.' });
        if (contextSelection.meetingId !== meetingId) return json(res, 409, { error: 'Context preview belongs to another meeting.' });
        if (contextSelection.analysisId) return json(res, 409, { error: 'Context preview has already been used. Create a new preview.' });
        if (contextSelection.query.projectContextSha256 !== projectContextHash(projectContext)) return json(res, 409, { error: 'Project notes changed after the context preview. Create a new preview.' });
        const selectedProject = contextStore.getProject(contextSelection.projectId);
        if (!selectedProject || !selectedProject.isActive) return json(res, 409, { error: 'The selected project is no longer available.' });
      }
      const job = store.beginAnalysis(meetingId, contextSelection ? {
        contextSelectionId: contextSelection.id,
        contextSelectionSha256: contextSelection.contentSha256,
        projectId: contextSelection.projectId,
      } : {});
      if (!job) return json(res, 409, { error: 'Analysis is already running for this meeting.' });
      if (contextSelection) {
        let linked;
        try { linked = contextStore.linkContextSelectionToAnalysis(contextSelection.id, job.id); }
        catch {
          store.finishAnalysis(job.id, { status: 'failed', error: { code: 'context_selection_unavailable' } });
          logger.error('context-selection-link-failed', { meetingId, contextSelectionId: contextSelection.id });
          return json(res, 503, { error: 'The context preview could not be linked to analysis.' });
        }
        if (!linked) {
          store.finishAnalysis(job.id, { status: 'failed', error: { code: 'context_selection_conflict' } });
          return json(res, 409, { error: 'Context preview was used concurrently. Create a new preview.' });
        }
      }
      store.updateMeeting(meetingId, { analysisStatus: 'running' });
      try {
        const generated = await analysis.analyze({ meeting, transcript, projectContext, contextSelection });
        const artifacts = validateAndHydrateArtifacts(generated.output, { meetingId, participants: meeting.participants ?? [], utterances: transcript.utterances, contextSelection });
        const storedArtifacts = store.replaceProposedArtifacts(meetingId, artifacts);
        const completed = store.finishAnalysis(job.id, { status: 'complete', model: generated.model, usage: generated.usage, rateLimit: generated.rateLimit, artifactCount: storedArtifacts.length });
        store.updateMeeting(meetingId, { analysisStatus: 'complete', analysisError: null });
        return json(res, 200, { analysis: completed, artifacts: storedArtifacts });
      } catch (error) {
        const code = error instanceof GroqRateLimitError ? 'rate_limited'
          : error instanceof GroqBusyError ? 'busy'
            : error instanceof GroqConfigurationError ? 'not_configured'
              : error instanceof ArtifactValidationError ? 'invalid_output'
                : error instanceof RangeError ? 'input_too_large'
                  : 'provider_failed';
        store.finishAnalysis(job.id, { status: 'failed', error: { code, issues: error instanceof ArtifactValidationError ? error.issues : undefined } });
        store.updateMeeting(meetingId, { analysisStatus: 'failed', analysisError: { code } });
        logger.error('manual-groq-analysis-failed', { meetingId, code });
        if (error instanceof GroqRateLimitError) return json(res, 429, { error: 'Groq rate limit reached.', retryAfterSeconds: error.retryAfterSeconds }, { 'Retry-After': String(error.retryAfterSeconds) });
        if (error instanceof GroqBusyError) return json(res, 429, { error: 'Groq analysis capacity is busy. Try again shortly.' }, { 'Retry-After': '1' });
        if (error instanceof GroqConfigurationError) return json(res, 503, { error: 'GROQ_API_KEY is not configured.' });
        if (error instanceof ArtifactValidationError) return json(res, 422, { error: 'Groq returned artifacts that failed validation.', issues: error.issues });
        if (error instanceof RangeError) return json(res, 413, { error: error.message });
        return json(res, 502, { error: 'Groq analysis failed.' });
      }
    }
    const reconcileMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/reconcile$/);
    if (req.method === 'POST' && reconcileMatch) {
      const meeting = store.getMeeting(decodeURIComponent(reconcileMatch[1]));
      if (!meeting) return json(res, 404, { error: 'Meeting not found.' });
      if (!meeting.botId) return json(res, 409, { error: 'Meeting does not have a Recall bot ID.' });
      try {
        const reconciled = await reconcileMeeting(meeting);
        return json(res, 200, reconciled.meeting);
      } catch (error) {
        logger.error('bot-reconciliation-failed', { meetingId: meeting.id });
        return json(res, 502, { error: 'Recall bot reconciliation failed.' });
      }
    }
    const processMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/process$/);
    if (req.method === 'POST' && processMatch) {
      const meeting = store.getMeeting(decodeURIComponent(processMatch[1]));
      if (!meeting) return json(res, 404, { error: 'Meeting not found.' });
      if (!meeting.botId) return json(res, 409, { error: 'Meeting does not have a Recall bot ID.' });
      try {
        if (meeting.status === 'failed' && ['transcript_create_failed', 'transcript_download_or_parse_failed', 'transcript_failed', 'transcript_retry_failed'].includes(meeting.error?.code)) {
          setMeetingState(meeting, 'transcript_processing', { eventType: 'app.transcript_retry_started', code: 'transcript_retry_started', allowRecovery: true });
        }
        const { bot } = await reconcileMeeting(meeting);
        if (store.findTranscriptByMeetingId(meeting.id)?.status === 'done') return json(res, 200, store.getMeeting(meeting.id));
        const recording = (Array.isArray(bot?.recordings) ? bot.recordings : []).find((item) => typeof item?.id === 'string');
        if (!recording) return json(res, 409, { error: 'Recall has not made a recording available yet.' });
        await requestTranscript(recording.id, meeting);
        return json(res, 202, store.getMeeting(meeting.id));
      } catch (error) {
        setMeetingState(meeting, 'failed', { eventType: 'app.transcript_retry_failed', code: 'transcript_retry_failed', message: 'The processing retry could not retrieve Recall artifacts.' });
        logger.error('meeting-processing-retry-failed', { meetingId: meeting.id });
        return json(res, 502, { error: 'Meeting processing retry failed.' });
      }
    }
    if (req.method === 'POST' && (url.pathname === '/api/meetings' || url.pathname === '/api/bots')) {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
      if (!validMeetingUrl(body.meetingUrl)) return json(res, 400, { error: 'A Zoom, Google Meet, or Microsoft Teams HTTPS URL is required.' });
      const meetingType = body.meetingType || 'general_technical_sync';
      if (!meetingTypes.has(meetingType)) return json(res, 400, { error: 'A supported meeting type is required.' });
      const now = new Date().toISOString();
      const meeting = store.addMeeting({
        id: crypto.randomUUID(),
        recallBotId: null,
        botId: null,
        meetingUrl: body.meetingUrl,
        title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled meeting',
        meetingType,
        joinAt: body.joinAt || now,
        status: 'created',
        statusHistory: [{ eventType: 'app.meeting_created', status: 'created', code: 'created', subCode: null, occurredAt: now }],
        participants: [],
        startedAt: null,
        endedAt: null,
        durationMs: null,
        transcriptStatus: 'not_started',
        processingStatus: 'waiting_for_call',
        error: null,
        isMock: config.mockMode,
        createdAt: now,
        updatedAt: now,
      });
      try {
        const bot = await recall.createBot({ meetingUrl: meeting.meetingUrl, joinAt: meeting.joinAt, intentId: meeting.id });
        store.updateMeeting(meeting.id, { botId: bot.id, recallBotId: bot.id });
        if (Date.parse(meeting.joinAt) > Date.now() + 1_000) setMeetingState(meeting, 'bot_scheduled', { eventType: 'app.bot_scheduled', code: 'bot_scheduled' });
        return json(res, 201, store.getMeeting(meeting.id));
      } catch (error) {
        logger.error('bot-create-failed', { meetingId: meeting.id });
        return json(res, 502, setMeetingState(meeting, 'failed', { eventType: 'app.bot_create_failed', code: 'bot_create_failed', message: 'Recall could not schedule this bot. Create a new meeting request before trying again.' }));
      }
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/recall') {
      const rawBody = await readBody(req);
      if (!verifyRecallRequest(config.webhookSecret, req.headers, rawBody)) return json(res, 401, { error: 'Invalid Recall signature.' });
      let event;
      try { event = JSON.parse(rawBody); }
      catch { return json(res, 400, { error: 'Webhook body must be valid JSON.' }); }
      const eventId = req.headers['webhook-id'] ?? req.headers['svix-id'];
      if (store.claim(`webhook:${eventId}`)) {
        store.rememberEvent(eventId, { eventId, eventType: event.event ?? event.type ?? 'unknown', recallBotId: event.data?.bot?.id ?? null, receivedAt: new Date().toISOString(), processingStatus: 'accepted' });
        setImmediate(() => processWebhook(event)
          .then(() => store.rememberEvent(eventId, { processedAt: new Date().toISOString(), processingStatus: 'complete' }))
          .catch(() => {
            store.rememberEvent(eventId, { processedAt: new Date().toISOString(), processingStatus: 'failed' });
            logger.error('recall-webhook-processing-failed', { eventType: event.event ?? event.type, eventId });
          }));
      }
      return json(res, 202, { accepted: true });
    }
    if (req.method === 'GET' && url.pathname === '/callbacks/calendar') {
      if (!config.calendarRegionalCallbackUri) return json(res, 503, { error: 'Calendar setup has not returned a Recall callback URI yet.' });
      const allowed = ['state', 'code', 'error', 'recall_calendar_setup_probe'];
      const params = new URLSearchParams([...url.searchParams].filter(([key]) => allowed.includes(key)));
      if (![...params.keys()].some((key) => key === 'code' || key === 'error' || key === 'recall_calendar_setup_probe')) return json(res, 400, { error: 'Missing calendar callback result.' });
      const target = new URL(config.calendarRegionalCallbackUri); target.search = params.toString();
      const forward = await fetch(target, { redirect: 'manual' });
      res.writeHead(forward.status); return res.end(await forward.text());
    }
    json(res, 404, { error: 'Not found' });
  };
}
