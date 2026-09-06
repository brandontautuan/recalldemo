import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { mockFixture } from '../src/mock-data.js';
import { JsonStore } from '../src/store.js';

const invoke = async (app, method, url, body = '') => {
  const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers: {} });
  const response = { statusCode: null, body: '', writeHead(statusCode) { this.statusCode = statusCode; }, end(value = '') { this.body += value; } };
  await app(request, response);
  return response;
};

const fixtureStore = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-demo-reset-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.seedMock(mockFixture);
  return store;
};

test('demo reset restores only the named fixture and is idempotent', (context) => {
  const store = fixtureStore(context);
  const mockArtifact = store.getArtifact('mock-artifact-action');
  store.updateArtifact(mockArtifact.id, { expectedVersion: 1, action: 'approve' });
  store.beginAnalysis(mockFixture.meeting.id);
  store.addMeeting({ id: 'live-meeting', title: 'Keep me', status: 'created', statusHistory: [], isMock: false, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' });
  store.saveTranscript('live-transcript', { id: 'live-transcript', meetingId: 'live-meeting', status: 'done', isMock: false });
  store.data.artifacts['live-artifact'] = { id: 'live-artifact', meetingId: 'live-meeting', status: 'approved' };

  store.resetMock(mockFixture);
  const first = structuredClone(store.dashboard());
  assert.equal(store.getArtifact('mock-artifact-action').status, 'proposed');
  assert.equal(store.latestAnalysis(mockFixture.meeting.id), null);
  assert.deepEqual(store.reviewEventsForMeeting(mockFixture.meeting.id), []);
  assert.equal(store.getMeeting('live-meeting').title, 'Keep me');
  assert.equal(store.getTranscript('live-transcript').status, 'done');
  assert.equal(store.getArtifact('live-artifact').status, 'approved');

  store.resetMock(mockFixture);
  assert.deepEqual(store.dashboard(), first);
});

test('mock reset endpoint makes no Recall or Groq calls and rejects arbitrary scope', async (context) => {
  const store = fixtureStore(context);
  let externalCalls = 0;
  const external = new Proxy({}, { get: () => async () => { externalCalls += 1; throw new Error('external call was not expected'); } });
  const app = createApp({ config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }), recall: external, analysis: external, store });

  const reset = await invoke(app, 'POST', '/api/demo/reset', '{}');
  assert.equal(reset.statusCode, 200);
  assert.equal(JSON.parse(reset.body).reset, true);
  assert.equal(externalCalls, 0);
  assert.equal((await invoke(app, 'POST', '/api/demo/reset', '{"meetingId":"live-meeting"}')).statusCode, 400);
  assert.equal(externalCalls, 0);
});

test('demo reset is unavailable in live mode', async (context) => {
  const store = fixtureStore(context);
  let externalCalls = 0;
  const external = new Proxy({}, { get: () => async () => { externalCalls += 1; } });
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'test', RECALL_WEBHOOK_VERIFICATION_SECRET: 'whsec_dGVzdA==', PUBLIC_API_BASE_URL: 'https://example.test' });
  const app = createApp({ config, recall: external, analysis: external, store });
  const response = await invoke(app, 'POST', '/api/demo/reset', '{}');
  assert.equal(response.statusCode, 404);
  assert.equal(externalCalls, 0);
});
