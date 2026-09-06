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

const invoke = async (app, method, url, body) => {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { 'content-type': 'application/json' } });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

const fixtureStore = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-review-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.seedMock(mockFixture);
  return store;
};

test('stores review decisions with version checks and append-only audit events', (context) => {
  const store = fixtureStore(context);
  const artifact = store.getArtifact('mock-artifact-adr');
  const approved = store.updateArtifact(artifact.id, { expectedVersion: 1, action: 'approve' });
  assert.equal(approved.artifact.status, 'approved');
  assert.equal(approved.artifact.version, 2);
  assert.equal(store.updateArtifact(artifact.id, { expectedVersion: 1, action: 'reject' }).conflict, true);
  assert.deepEqual(store.reviewEventsForArtifact(artifact.id).map((event) => event.action), ['approve']);
});

test('restores the immutable Groq fixture after a user edit and rejection', (context) => {
  const store = fixtureStore(context);
  const artifact = store.getArtifact('mock-artifact-action');
  const originalTitle = artifact.originalProposal.title;
  const edited = store.updateArtifact(artifact.id, { expectedVersion: 1, action: 'edit', title: 'User-edited title', content: { ...artifact.content, description: 'A sufficiently detailed user-authored action item.' } });
  assert.equal(edited.artifact.status, 'needs_changes');
  assert.equal(edited.artifact.userEdited, true);
  const rejected = store.updateArtifact(artifact.id, { expectedVersion: 2, action: 'reject', note: 'Owner needs confirmation.' });
  assert.equal(rejected.artifact.rejectionNote, 'Owner needs confirmation.');
  const restored = store.updateArtifact(artifact.id, { expectedVersion: 3, action: 'restore' });
  assert.equal(restored.artifact.title, originalTitle);
  assert.equal(restored.artifact.status, 'proposed');
  assert.equal(restored.artifact.userEdited, false);
  assert.deepEqual(store.reviewEventsForArtifact(artifact.id).map((event) => event.action), ['edit', 'reject', 'restore']);
});

test('reanalysis replaces only unreviewed proposals', (context) => {
  const store = fixtureStore(context);
  store.updateArtifact('mock-artifact-adr', { expectedVersion: 1, action: 'approve' });
  const replacement = structuredClone(mockFixture.artifacts[1]);
  replacement.id = 'replacement-proposal';
  store.replaceProposedArtifacts(mockFixture.meeting.id, [replacement]);
  assert.equal(store.getArtifact('mock-artifact-adr').status, 'approved');
  assert.equal(store.getArtifact('mock-artifact-action'), null);
  assert.equal(store.getArtifact('replacement-proposal').status, 'proposed');
});

test('review API validates edits, rejects stale writes, and never invokes Groq', async (context) => {
  const store = fixtureStore(context);
  let analysisCalls = 0;
  const app = createApp({
    config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }),
    recall: {},
    analysis: { async analyze() { analysisCalls += 1; } },
    store,
  });
  const invalid = await invoke(app, 'PATCH', '/api/artifacts/mock-artifact-action', { expectedVersion: 1, content: { assignee: 'Not A Participant' } });
  assert.equal(invalid.status, 422);
  assert.equal(store.getArtifact('mock-artifact-action').version, 1);
  const edited = await invoke(app, 'PATCH', '/api/artifacts/mock-artifact-action', { expectedVersion: 1, title: 'Document and verify the migration', content: { description: 'Document the migration plan and verify every acceptance check.' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.artifact.status, 'needs_changes');
  assert.equal(edited.body.artifact.originalProposal.title, 'Document the event-model migration');
  const stale = await invoke(app, 'POST', '/api/artifacts/mock-artifact-action/approve', { expectedVersion: 1 });
  assert.equal(stale.status, 409);
  const approved = await invoke(app, 'POST', '/api/artifacts/mock-artifact-action/approve', { expectedVersion: 2 });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.artifact.status, 'approved');
  assert.equal(analysisCalls, 0);
});

test('rejected artifacts must be restored before they can be edited or approved', async (context) => {
  const store = fixtureStore(context);
  const app = createApp({ config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }), recall: {}, analysis: {}, store });
  assert.equal((await invoke(app, 'POST', '/api/artifacts/mock-artifact-risk/reject', { expectedVersion: 1 })).status, 200);
  assert.equal((await invoke(app, 'POST', '/api/artifacts/mock-artifact-risk/approve', { expectedVersion: 2 })).status, 409);
  assert.equal((await invoke(app, 'PATCH', '/api/artifacts/mock-artifact-risk', { expectedVersion: 2, title: 'Edited rejected risk' })).status, 409);
  const restored = await invoke(app, 'POST', '/api/artifacts/mock-artifact-risk/restore', { expectedVersion: 2 });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.artifact.status, 'proposed');
});
