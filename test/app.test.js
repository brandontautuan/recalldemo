import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createConfig } from '../src/config.js';
import { createApp, eligibleCalendarEvent } from '../src/app.js';
import { RecallClient } from '../src/recall-client.js';
import { calculateMeetingAnalytics, normalizeTranscript } from '../src/transcript.js';
import { mockFixture } from '../src/mock-data.js';
import { JsonStore } from '../src/store.js';
import { verifyRecallRequest } from '../src/verify.js';

const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
test('configuration is injected and pins the US West Recall region', () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  assert.equal(config.region, 'us-west-2');
  assert.throws(() => createConfig({ RECALL_REGION: 'us-east-1', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' }));
});
test('configuration permits only Groq strict-output models and bounded concurrency', () => {
  assert.throws(() => createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', GROQ_MODEL: 'another-provider/model' }), /strict structured outputs/);
  assert.throws(() => createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', GROQ_MAX_CONCURRENCY: '5' }), /integer from 1 to 4/);
  const config = createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', GROQ_MODEL: 'openai/gpt-oss-120b', GROQ_MAX_CONCURRENCY: '2' });
  assert.equal(config.groqModel, 'openai/gpt-oss-120b');
  assert.equal(config.groqMaximumConcurrency, 2);
});
test('configuration validates bounded project-context storage settings', () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', DATABASE_PATH: 'data/context.sqlite', PROJECT_CONTEXT_SEED_PATH: 'seeds/context.json', PROJECT_CONTEXT_MAX_CHARACTERS: '12000' });
  assert.equal(config.databasePath, 'data/context.sqlite');
  assert.equal(config.projectContextSeedPath, 'seeds/context.json');
  assert.equal(config.projectContextMaximumCharacters, 12_000);
  assert.throws(() => createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', PROJECT_CONTEXT_MAX_CHARACTERS: '999' }), /integer from 1000/);
  assert.throws(() => createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', GROQ_MAX_INPUT_CHARACTERS: '12000', PROJECT_CONTEXT_MAX_CHARACTERS: '12000' }), /must be smaller/);
});
test('only future tagged calendar events with a meeting URL are eligible', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(eligibleCalendarEvent({ id:'1', raw:{summary:'Planning [recall]'}, meeting_url:'https://meet.google.com/a', start_time:future }), true);
  assert.equal(eligibleCalendarEvent({ id:'2', raw:{summary:'Planning'}, meeting_url:'https://meet.google.com/a', start_time:future }), false);
  assert.equal(eligibleCalendarEvent({ id:'3', raw:{summary:'Planning [recall]'}, meeting_url:null, start_time:future }), false);
  assert.equal(eligibleCalendarEvent({ id:'4', raw:{summary:'Planning [recall]'}, meeting_url:'https://meet.google.com/a', start_time:'2020-01-01T00:00:00Z' }), false);
});
test('Recall webhook verification requires a valid raw-body signature', () => {
  const raw = '{"event":"recording.done"}', id = 'msg_1', timestamp = '1731705121';
  const signature = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');
  assert.equal(verifyRecallRequest(secret, {'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}, raw), true);
  assert.equal(verifyRecallRequest(secret, {'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}, '{}'), false);
});

test('normalizes downloaded Recall transcript parts into speaker paragraphs', () => {
  const paragraphs = normalizeTranscript({ transcript_parts: [
    { participant: { id: 1, name: 'Ada' }, words: [{ text: 'Hello', start_timestamp: { relative: 0 }, end_timestamp: { relative: 0.4 } }] },
    { participant: { id: 1, name: 'Ada' }, words: [{ text: 'there', start_timestamp: { relative: 0.5 }, end_timestamp: { relative: 0.9 } }] },
    { participant: { id: 2, name: 'Lin' }, words: [{ text: 'Hi!', start_timestamp: { relative: 1 }, end_timestamp: { relative: 1.2 } }] },
  ] });
  assert.deepEqual(paragraphs.map(({ speakerId, speakerName, text, startTimestamp, endTimestamp }) => ({ speakerId, speakerName, text, startTimestamp, endTimestamp })), [
    { speakerId: '1', speakerName: 'Ada', text: 'Hello there', startTimestamp: { relative: 0, absolute: null }, endTimestamp: { relative: 0.9, absolute: null } },
    { speakerId: '2', speakerName: 'Lin', text: 'Hi!', startTimestamp: { relative: 1, absolute: null }, endTimestamp: { relative: 1.2, absolute: null } },
  ]);
  assert.throws(() => normalizeTranscript({ unexpected: [] }), /transcript_parts/);
});

test('downloads Recall transcript JSON only from the configured regional API host', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const client = new RecallClient(config, async () => new Response(JSON.stringify({ transcript_parts: [] }), { status: 200 }));
  assert.deepEqual(await client.downloadTranscript('https://us-west-2.recall.ai/api/v1/download/transcript?token=opaque'), { transcript_parts: [] });
  await assert.rejects(() => client.downloadTranscript('https://example.com/transcript'), /invalid transcript download URL/);
});

test('does not retry an ambiguous bot creation server failure', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  let calls = 0;
  const client = new RecallClient(config, async () => { calls += 1; return new Response('{}', { status: 503 }); });
  await assert.rejects(() => client.createBot({ meetingUrl: 'https://meet.google.com/abc-defg-hij', intentId: 'meeting-1' }), /503/);
  assert.equal(calls, 1);
});

test('retrieves a bot by its encoded Recall ID', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  let requestedUrl;
  const client = new RecallClient(config, async (url) => { requestedUrl = url; return new Response(JSON.stringify({ id: 'bot/id' }), { status: 200 }); });
  await client.getBot('bot/id');
  assert.equal(requestedUrl, 'https://us-west-2.recall.ai/api/v1/bot/bot%2Fid/');
});

class MemoryStore {
  constructor() { this.processed = new Set(); this.transcripts = new Map(); this.meetings = new Map(); }
  claim(key) { if (this.processed.has(key)) return false; this.processed.add(key); return true; }
  releaseClaim(key) { this.processed.delete(key); }
  saveTranscript(id, value) { this.transcripts.set(id, value); }
  getTranscript(id) { return this.transcripts.get(id) ?? null; }
  addMeeting(value) { this.meetings.set(value.id, value); return value; }
  getMeeting(id) { return this.meetings.get(id) ?? null; }
  updateMeeting(id, patch) { const value = Object.assign(this.meetings.get(id), patch); return value; }
  findMeetingByBotId(botId) { return [...this.meetings.values()].find((meeting) => meeting.botId === botId) ?? null; }
  findTranscriptByMeetingId(meetingId) { return [...this.transcripts.values()].find((transcript) => transcript.meetingId === meetingId) ?? null; }
  recordLifecycle() {}
  rememberEvent() {}
  dashboard() { const meetings = [...this.meetings.values()]; return { meetings, intents: meetings, transcripts: [...this.transcripts.values()] }; }
}

const signedWebhook = (event, messageId) => {
  const raw = JSON.stringify(event), timestamp = '1731705121';
  const signature = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${messageId}.${timestamp}.${raw}`).digest('base64');
  return { raw, headers: { 'webhook-id': messageId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } };
};

const invokeWebhook = async (app, event, messageId) => {
  const { raw, headers } = signedWebhook(event, messageId);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', url: '/webhooks/recall', headers });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(body = '') { this.body += body; } };
  await app(req, response);
  await new Promise((resolve) => setImmediate(resolve));
  return response;
};

const invoke = async (app, method, url, body = '') => {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers: {} });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(req, response);
  return response;
};

test('processes a signed transcript webhook once and records malformed downloads as failed', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const store = new MemoryStore();
  let getCalls = 0;
  const recall = {
    async getTranscript() { getCalls += 1; return { data: { download_url: 'https://us-west-2.recall.ai/download/opaque' } }; },
    async downloadTranscript() { return { transcript_parts: [{ participant: { id: 1, name: 'Ada' }, words: [{ text: 'Verified text', start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } }] }] }; },
  };
  let analysisCalls = 0;
  const analysis = { async analyze() { analysisCalls += 1; return { output: { artifacts: [] } }; } };
  const app = createApp({ config, recall, store, analysis, logger: { error() {} } });
  const event = { event: 'transcript.done', data: { transcript: { id: 'transcript-1' }, recording: { id: 'recording-1' } } };
  assert.equal((await invokeWebhook(app, event, 'message-1')).statusCode, 202);
  assert.deepEqual(store.transcripts.get('transcript-1').paragraphs.map((paragraph) => paragraph.text), ['Verified text']);
  await invokeWebhook(app, event, 'message-1');
  assert.equal(getCalls, 1);

  recall.downloadTranscript = async () => ({ malformed: true });
  const malformed = { event: 'transcript.done', data: { transcript: { id: 'transcript-2' } } };
  assert.equal((await invokeWebhook(app, malformed, 'message-2')).statusCode, 202);
  assert.equal(store.transcripts.get('transcript-2').status, 'failed');
  assert.equal(store.transcripts.get('transcript-2').failureCode, 'transcript_download_or_parse_failed');
  assert.equal(analysisCalls, 0, 'transcript webhooks must never invoke Groq automatically');
});

test('runs Groq analysis only through the explicit manual endpoint and persists proposed evidence', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-analysis-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'meeting-1', title: 'Migration review', meetingType: 'architecture_review', participants: [{ id: '1', name: 'Ada' }], analysisStatus: 'not_started', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  store.saveTranscript('transcript-1', { id: 'transcript-1', meetingId: 'meeting-1', status: 'done', utterances: [{ id: 'utterance-1', speakerId: '1', speakerName: 'Ada', text: 'I will document the migration plan.', startTimestamp: { relative: 3 }, endTimestamp: { relative: 6 } }] });
  let analysisCalls = 0;
  let receivedProjectContext;
  const analysis = { async analyze({ projectContext }) {
    analysisCalls += 1;
    receivedProjectContext = projectContext;
    return { model: 'openai/gpt-oss-20b', usage: { total_tokens: 25 }, rateLimit: { remainingRequests: 9 }, output: { artifacts: [{
      type: 'action_item', title: 'Document the migration plan', status: 'proposed', description: 'Write the event-model migration and its acceptance checks.', context: null, decision: null,
      alternativesRejected: [], consequences: [], assignee: 'Ada', dueDate: null, acceptanceCriteria: ['The migration and rollback steps are documented.'], priority: 'medium',
      stepsToReproduce: [], expectedBehavior: null, actualBehavior: null, severity: null, impact: null, mitigation: null, owner: null, question: null, suggestedOwner: null,
      evidenceUtteranceIds: ['utterance-1'], contextSourceIds: [], confidence: 'high',
    }] } };
  } };
  const config = createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' });
  const app = createApp({ config, recall: {}, analysis, store, logger: { error() {} } });
  assert.equal(analysisCalls, 0);
  const response = await invoke(app, 'POST', '/api/meetings/meeting-1/analyze', JSON.stringify({ projectContext: 'The service uses an append-only event log.' }));
  assert.equal(response.statusCode, 200);
  assert.equal(analysisCalls, 1);
  const body = JSON.parse(response.body);
  assert.equal(body.analysis.trigger, 'manual');
  assert.equal(receivedProjectContext, 'The service uses an append-only event log.');
  assert.equal(body.artifacts[0].evidence[0].text, 'I will document the migration plan.');
  assert.equal(store.getMeeting('meeting-1').analysisStatus, 'complete');
});

test('manual analysis requires a completed transcript', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-analysis-input-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'meeting-1', title: 'Review', meetingType: 'architecture_review', participants: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  let analysisCalls = 0;
  const app = createApp({ config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }), recall: {}, analysis: { async analyze() { analysisCalls += 1; } }, store });
  const response = await invoke(app, 'POST', '/api/meetings/meeting-1/analyze');
  assert.equal(response.statusCode, 409);
  assert.equal(analysisCalls, 0);
});

test('calculates deterministic talk-time analytics from normalized timestamps', () => {
  const analytics = calculateMeetingAnalytics([
    { speakerId: '1', speakerName: 'Ada', startTimestamp: { relative: 2 }, endTimestamp: { relative: 7 } },
    { speakerId: '2', speakerName: 'Lin', startTimestamp: { relative: 8 }, endTimestamp: { relative: 11 } },
    { speakerId: '1', speakerName: 'Ada', startTimestamp: { relative: 12 }, endTimestamp: { relative: 14 } },
  ]);
  assert.equal(analytics.meetingDurationSeconds, 12);
  assert.equal(analytics.totalSpeakingSeconds, 10);
  assert.equal(analytics.utteranceCount, 3);
  assert.equal(analytics.participantCount, 2);
  assert.deepEqual(analytics.participants.map(({ speakerName, speakingTimeSeconds, speakingPercentage, utteranceCount }) => ({ speakerName, speakingTimeSeconds, speakingPercentage, utteranceCount })), [
    { speakerName: 'Ada', speakingTimeSeconds: 7, speakingPercentage: 70, utteranceCount: 2 },
    { speakerName: 'Lin', speakingTimeSeconds: 3, speakingPercentage: 30, utteranceCount: 1 },
  ]);
});

test('creates a meeting with title, type, bot ID, and initial lifecycle state', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const store = new MemoryStore();
  const app = createApp({ config, store, recall: { async createBot() { return { id: 'bot-123' }; } } });
  const body = JSON.stringify({ meetingUrl: 'https://meet.google.com/abc-defg-hij', title: 'API review', meetingType: 'architecture_review' });
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/api/meetings', headers: {} });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(req, response);
  const meeting = JSON.parse(response.body);
  assert.equal(response.statusCode, 201);
  assert.equal(meeting.title, 'API review');
  assert.equal(meeting.meetingType, 'architecture_review');
  assert.equal(meeting.botId, 'bot-123');
  assert.equal(meeting.statusHistory[0].status, 'created');
});

test('rejects unsupported meeting URLs before calling Recall', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const store = new MemoryStore();
  let createCalls = 0;
  const app = createApp({ config, store, recall: { async createBot() { createCalls += 1; } } });
  const body = Buffer.from(JSON.stringify({ meetingUrl: 'https://example.com/not-a-meeting', meetingType: 'architecture_review' }));
  const req = Object.assign(Readable.from([body]), { method: 'POST', url: '/api/meetings', headers: {} });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(req, response);
  assert.equal(response.statusCode, 400);
  assert.equal(createCalls, 0);
});

test('persists a failed meeting state when Recall bot creation fails', async () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const store = new MemoryStore();
  const app = createApp({ config, store, logger: { error() {} }, recall: { async createBot() { throw new Error('unavailable'); } } });
  const body = Buffer.from(JSON.stringify({ meetingUrl: 'https://zoom.us/j/123456789', meetingType: 'incident_review' }));
  const req = Object.assign(Readable.from([body]), { method: 'POST', url: '/api/meetings', headers: {} });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(req, response);
  const meeting = JSON.parse(response.body);
  assert.equal(response.statusCode, 502);
  assert.equal(meeting.status, 'failed');
  assert.equal(meeting.error.code, 'bot_create_failed');
});

test('stores lifecycle events in event-time order and does not let bot.done hide a fatal state', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-store-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  const meeting = store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'created', statusHistory: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const app = createApp({ config, store, recall: {} });
  await invokeWebhook(app, { event: 'bot.in_call_recording', data: { data: { code: 'in_call_recording', sub_code: null, updated_at: '2026-01-01T00:02:00.000Z' }, bot: { id: 'bot-1', metadata: {} } } }, 'lifecycle-1');
  await invokeWebhook(app, { event: 'bot.joining_call', data: { data: { code: 'joining_call', sub_code: null, updated_at: '2026-01-01T00:01:00.000Z' }, bot: { id: 'bot-1', metadata: {} } } }, 'lifecycle-2');
  assert.deepEqual(meeting.statusHistory.map((entry) => entry.status), ['joining', 'recording']);
  assert.equal(meeting.status, 'recording');
  await invokeWebhook(app, { event: 'bot.fatal', data: { data: { code: 'fatal', sub_code: 'meeting_not_found', updated_at: '2026-01-01T00:03:00.000Z' }, bot: { id: 'bot-1', metadata: {} } } }, 'lifecycle-3');
  await invokeWebhook(app, { event: 'bot.done', data: { data: { code: 'done', sub_code: null, updated_at: '2026-01-01T00:04:00.000Z' }, bot: { id: 'bot-1', metadata: {} } } }, 'lifecycle-4');
  assert.equal(meeting.status, 'failed');
  assert.equal(meeting.error.subCode, 'meeting_not_found');
});

test('mock configuration works without live secrets and fixture data is clearly labeled', () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' });
  assert.equal(config.mockMode, true);
  assert.equal(mockFixture.meeting.isMock, true);
  assert.equal(mockFixture.transcript.isMock, true);
  assert.ok(mockFixture.transcript.analytics.participantCount > 0);
  assert.ok(mockFixture.meeting.statusHistory.length >= 5);
  assert.deepEqual(mockFixture.artifacts.map((artifact) => artifact.type), ['architecture_decision', 'action_item', 'bug_report', 'risk']);
});

test('reconciles missed lifecycle events and a completed transcript from Retrieve Bot', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-reconcile-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'created', statusHistory: [], transcriptStatus: 'not_started', processingStatus: 'waiting_for_call', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const recall = {
    async getBot() { return {
      id: 'bot-1',
      status_changes: [
        { code: 'in_call_recording', sub_code: null, message: null, created_at: '2026-01-01T00:02:00.000Z' },
        { code: 'joining_call', sub_code: null, message: null, created_at: '2026-01-01T00:01:00.000Z' },
        { code: 'done', sub_code: null, message: null, created_at: '2026-01-01T00:03:00.000Z' },
      ],
      recordings: [{ id: 'recording-1', media_shortcuts: { transcript: { id: 'transcript-1', data: { download_url: 'https://us-west-2.recall.ai/download/transcript-1' } } } }],
    }; },
    async downloadTranscript() { return { transcript_parts: [{ participant: { id: 1, name: 'Ada' }, language_code: 'en-US', words: [{ text: 'Recovered', start_timestamp: { relative: 0 }, end_timestamp: { relative: 2 } }] }] }; },
  };
  const app = createApp({ config, recall, store, logger: { error() {} } });
  const first = await invoke(app, 'POST', '/api/meetings/meeting-1/reconcile');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(store.getMeeting('meeting-1').statusHistory.map((entry) => entry.status), ['joining', 'recording', 'complete']);
  assert.equal(store.findTranscriptByMeetingId('meeting-1').analytics.totalSpeakingSeconds, 2);
  await invoke(app, 'POST', '/api/meetings/meeting-1/reconcile');
  assert.equal(store.getMeeting('meeting-1').statusHistory.length, 3);
});

test('allows failed transcript download processing to be retried safely', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-retry-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'complete', statusHistory: [], transcriptStatus: 'failed', processingStatus: 'failed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  let attempts = 0;
  const recall = {
    async getBot() { return { id: 'bot-1', status_changes: [], recordings: [{ id: 'recording-1', media_shortcuts: { transcript: { id: 'transcript-1', data: { download_url: 'https://us-west-2.recall.ai/download/transcript-1' } } } }] }; },
    async downloadTranscript() {
      attempts += 1;
      if (attempts === 1) throw new Error('expired');
      return { transcript_parts: [{ participant: { id: 1, name: null }, words: [{ text: 'Recovered', start_timestamp: { relative: 1 }, end_timestamp: { relative: 3 } }] }] };
    },
  };
  const app = createApp({ config, recall, store, logger: { error() {} } });
  assert.equal((await invoke(app, 'POST', '/api/meetings/meeting-1/process')).statusCode, 502);
  assert.equal(store.getTranscript('transcript-1').status, 'failed');
  assert.equal((await invoke(app, 'POST', '/api/meetings/meeting-1/process')).statusCode, 200);
  assert.equal(store.getTranscript('transcript-1').status, 'done');
  assert.equal(attempts, 2);
});

test('releases a failed transcript-creation claim so processing can be retried', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-create-retry-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'complete', statusHistory: [], transcriptStatus: 'not_started', processingStatus: 'awaiting_recording', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  let attempts = 0;
  const recall = {
    async createTranscript() { attempts += 1; if (attempts === 1) throw new Error('temporary failure'); return { id: 'transcript-1' }; },
  };
  const app = createApp({ config, recall, store, logger: { error() {} } });
  const event = { event: 'recording.done', data: { recording: { id: 'recording-1' }, bot: { id: 'bot-1' } } };
  await invokeWebhook(app, event, 'recording-message-1');
  assert.equal(store.getMeeting('meeting-1').transcriptStatus, 'failed');
  await invokeWebhook(app, event, 'recording-message-2');
  assert.equal(attempts, 2);
  assert.equal(store.getMeeting('meeting-1').transcriptStatus, 'pending');
});

test('records recording.failed as a user-safe meeting failure', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-recording-failed-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'complete', statusHistory: [], transcriptStatus: 'not_started', processingStatus: 'awaiting_recording', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  const app = createApp({ config, recall: {}, store, logger: { error() {} } });
  const event = { event: 'recording.failed', data: { data: { sub_code: 'no_recording' }, bot: { id: 'bot-1' } } };
  await invokeWebhook(app, event, 'recording-failed-message');
  assert.equal(store.getMeeting('meeting-1').transcriptStatus, 'unavailable');
  assert.equal(store.getMeeting('meeting-1').error.subCode, 'no_recording');
});
