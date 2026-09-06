import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createArtifactExport, ExportValidationError, ExportVersionConflictError, safeExportFilename } from '../src/export.js';
import { mockFixture } from '../src/mock-data.js';
import { JsonStore } from '../src/store.js';

const fixtureStore = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-export-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.seedMock(mockFixture);
  return store;
};

const approve = (store, id) => store.updateArtifact(id, { expectedVersion: 1, action: 'approve' }).artifact;
const selection = (artifact) => ({ artifactId: artifact.id, version: artifact.version });
const exportFrom = (store, format, selections) => createArtifactExport({
  meeting: store.getMeeting(mockFixture.meeting.id),
  selections,
  artifacts: store.artifactsForMeeting(mockFixture.meeting.id),
  reviewEvents: store.reviewEventsForMeeting(mockFixture.meeting.id),
  format,
  exportedAt: '2026-09-05T12:00:00.000Z',
});

test('canonical export contains only explicitly selected approved versions and evidence', (context) => {
  const store = fixtureStore(context);
  const decision = approve(store, 'mock-artifact-adr');
  const payload = exportFrom(store, 'canonical', [selection(decision)]);
  assert.equal(payload.schemaVersion, 'recall-engineering-export/v1');
  assert.equal(payload.format, 'canonical');
  assert.equal(payload.artifacts.length, 1);
  assert.equal(payload.artifacts[0].id, decision.id);
  assert.equal(payload.artifacts[0].status, 'approved');
  assert.equal(payload.artifacts[0].evidence[0].utteranceId, 'mock-utterance-2');
  assert.ok(payload.artifacts[0].approvedAt);
});

test('Linear export produces issueCreate drafts without inventing workspace IDs', (context) => {
  const store = fixtureStore(context);
  const actionItem = approve(store, 'mock-artifact-action');
  const payload = exportFrom(store, 'linear', [selection(actionItem)]);
  assert.equal(payload.externallySubmitted, false);
  assert.equal(payload.drafts[0].mutation, 'issueCreate');
  assert.equal(payload.drafts[0].input.title, actionItem.title);
  assert.match(payload.drafts[0].input.description, /Transcript evidence/);
  assert.equal(payload.drafts[0].mappingHints.requiredTeamId, null);
  assert.equal(payload.drafts[0].mappingHints.assigneeName, 'Jon Bell');
});

test('Jira export produces Cloud v3 ADF drafts for mixed artifact types', (context) => {
  const store = fixtureStore(context);
  const decision = approve(store, 'mock-artifact-adr');
  const bug = approve(store, 'mock-artifact-bug');
  const payload = exportFrom(store, 'jira', [selection(decision), selection(bug)]);
  assert.equal(payload.destination, 'jira-cloud-v3');
  assert.equal(payload.externallySubmitted, false);
  assert.deepEqual(payload.drafts.map((draft) => draft.mappingHints.issueTypeName), ['Task', 'Bug']);
  assert.equal(payload.drafts[0].fields.description.type, 'doc');
  assert.equal(payload.drafts[0].fields.description.version, 1);
  assert.ok(payload.drafts[0].fields.description.content.every((node) => node.type === 'paragraph'));
  assert.equal(payload.drafts[0].mappingHints.requiredProjectKeyOrId, null);
});

test('export rejects empty, duplicate, non-approved, cross-meeting, and stale selections', (context) => {
  const store = fixtureStore(context);
  const proposed = store.getArtifact('mock-artifact-risk');
  assert.throws(() => exportFrom(store, 'canonical', []), ExportValidationError);
  assert.throws(() => exportFrom(store, 'canonical', [selection(proposed)]), /must be approved/);
  const approved = approve(store, 'mock-artifact-adr');
  assert.throws(() => exportFrom(store, 'canonical', [selection(approved), selection(approved)]), /duplicates/);
  assert.throws(() => exportFrom(store, 'canonical', [{ artifactId: 'another-meeting-artifact', version: 1 }]), /outside this meeting/);
  assert.throws(() => exportFrom(store, 'canonical', [{ artifactId: approved.id, version: 1 }]), ExportVersionConflictError);
});

test('export filenames are deterministic and safe', () => {
  assert.equal(safeExportFilename('../../Résumé: Architecture / Review', 'jira'), 'resume-architecture-review-jira-export.json');
  assert.equal(safeExportFilename('', 'canonical'), 'meeting-canonical-export.json');
});

test('Jira export rejects fields beyond documented import limits', (context) => {
  const store = fixtureStore(context);
  const artifact = approve(store, 'mock-artifact-adr');
  artifact.title = 'x'.repeat(256);
  assert.throws(() => exportFrom(store, 'jira', [selection(artifact)]), /255-character summary limit/);
});

test('export API performs no Recall or Groq calls', async (context) => {
  const store = fixtureStore(context);
  const approved = approve(store, 'mock-artifact-adr');
  let externalCalls = 0;
  const app = createApp({
    config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }),
    recall: new Proxy({}, { get() { return () => { externalCalls += 1; }; } }),
    analysis: { async analyze() { externalCalls += 1; } },
    store,
  });
  const requestBody = JSON.stringify({ format: 'canonical', selections: [selection(approved)] });
  const request = Object.assign(Readable.from([Buffer.from(requestBody)]), { method: 'POST', url: `/api/meetings/${mockFixture.meeting.id}/export`, headers: { 'content-type': 'application/json' } });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(request, response);
  assert.equal(response.statusCode, 200);
  assert.match(JSON.parse(response.body).filename, /canonical-export\.json$/);
  assert.equal(externalCalls, 0);
});
