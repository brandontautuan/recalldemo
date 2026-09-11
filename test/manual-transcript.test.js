import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { ManualTranscriptValidationError, parseManualTranscript } from '../src/manual-transcript.js';
import { JsonStore } from '../src/store.js';

const invoke = async (app, method, url, body = '') => {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers: {} });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(req, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

const timestampedInput = {
  title: 'Event model review',
  meetingType: 'architecture_review',
  format: 'timestamped_speaker_lines',
  text: '[00:00] Maya: Adopt one event model.\n[00:05.500] Jon: I will document it.\n[00:10] Maya: Decision recorded.',
};

test('parses timestamped manual speaker lines into line-addressable evidence without external services', () => {
  const parsed = parseManualTranscript(timestampedInput);
  assert.equal(parsed.timestampsAvailable, true);
  assert.equal(parsed.utterances.length, 3);
  assert.deepEqual(parsed.utterances.map((utterance) => ({ speaker: utterance.speakerName, start: utterance.startTimestamp?.relative, end: utterance.endTimestamp?.relative })), [
    { speaker: 'Maya', start: 0, end: 5.5 },
    { speaker: 'Jon', start: 5.5, end: 10 },
    { speaker: 'Maya', start: 10, end: undefined },
  ]);
  assert.equal(parsed.analytics.totalSpeakingSeconds, 10);
  assert.equal(parsed.participants.length, 2);
});

test('preserves absent timestamps and rejects malformed manual input', () => {
  const parsed = parseManualTranscript({ title: 'Notes', format: 'speaker_lines', text: 'Ada: Keep the schema stable.\nLin: Add a migration.' });
  assert.equal(parsed.timestampsAvailable, false);
  assert.equal(parsed.analytics, null);
  assert.equal(parsed.utterances[0].startTimestamp, null);
  assert.throws(() => parseManualTranscript({ ...timestampedInput, text: '[00:12] Maya: Later\n[00:04] Jon: Earlier' }), ManualTranscriptValidationError);
  assert.throws(() => parseManualTranscript({ ...timestampedInput, text: 'Maya without a separator' }), /Line 1 must include/);
  assert.throws(() => parseManualTranscript({ title: 'Notes', format: 'plain_paragraphs', text: 'Unattributed notes' }), /defaultSpeaker is required/);
});

test('previewing and creating a manual meeting never calls Recall or analysis before an explicit analysis request', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-transcript-route-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  let recallCalls = 0;
  let analysisCalls = 0;
  const recall = new Proxy({}, { get() { return async () => { recallCalls += 1; }; } });
  const analysis = { async analyze() { analysisCalls += 1; } };
  const app = createApp({ config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }), store, recall, analysis });

  const preview = await invoke(app, 'POST', '/api/manual-transcripts/preview', JSON.stringify(timestampedInput));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.utterances.length, 3);
  assert.equal(Object.keys(store.dashboard().meetings).length, 0);

  const created = await invoke(app, 'POST', '/api/manual-meetings', JSON.stringify(timestampedInput));
  assert.equal(created.status, 201);
  assert.equal(created.body.meeting.source, 'manual');
  assert.equal(created.body.meeting.status, 'completed');
  assert.equal(created.body.meeting.botId, null);
  assert.equal(created.body.transcript.source, 'manual');
  assert.equal(created.body.transcript.sourceMetadata.timestampsAvailable, true);
  assert.equal(created.body.meeting.statusHistory[0].eventType, 'app.manual_transcript_created');
  assert.equal(recallCalls, 0);
  assert.equal(analysisCalls, 0);

  const deleted = await invoke(app, 'DELETE', `/api/manual-meetings/${created.body.meeting.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(store.getMeeting(created.body.meeting.id), null);
});

test('manual transcript endpoints are disabled unless explicitly enabled outside mock mode', async () => {
  const store = { dashboard: () => ({ meetings: [], transcripts: [], artifacts: [], analyses: [], reviewEvents: [] }) };
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: 'whsec_test', PUBLIC_API_BASE_URL: 'https://recall-demo.example' });
  const app = createApp({ config, store, recall: {}, analysis: {} });
  const response = await invoke(app, 'POST', '/api/manual-transcripts/preview', JSON.stringify(timestampedInput));
  assert.equal(response.status, 404);
});

test('manual meeting deletion preserves reviewed audit history', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-transcript-delete-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.addMeeting({ id: 'manual-1', source: 'manual', status: 'completed', statusHistory: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  store.recordReviewEvent('artifact-1', 'manual-1', 'approve', {}, true);
  assert.deepEqual(store.deleteManualMeeting('manual-1'), { deleted: false, reason: 'reviewed' });
  assert.ok(store.getMeeting('manual-1'));
});
