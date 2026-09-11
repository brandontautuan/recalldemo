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
import { TicketValidationError, ticketFromArtifact } from '../src/tickets.js';

const invoke = async (app, method, url, body) => {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { 'content-type': 'application/json' } });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

const fixtureStore = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ticket-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.seedMock(mockFixture);
  return store;
};

test('local tickets snapshot approved action-item evidence and prevent duplicate source versions', async (context) => {
  const store = fixtureStore(context);
  const app = createApp({ config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }), recall: {}, analysis: {}, store });
  assert.equal((await invoke(app, 'POST', '/api/artifacts/mock-artifact-action/approve', { expectedVersion: 1 })).status, 200);
  const create = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/tickets', { artifactId: 'mock-artifact-action', artifactVersion: 2 });
  assert.equal(create.status, 201);
  assert.equal(create.body.created, true);
  assert.equal(create.body.ticket.status, 'open');
  assert.equal(create.body.ticket.sourceArtifactVersion, 2);
  assert.deepEqual(create.body.ticket.evidence, store.getArtifact('mock-artifact-action').evidence);
  const duplicate = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/tickets', { artifactId: 'mock-artifact-action', artifactVersion: 2 });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.created, false);
  assert.equal(store.tickets().length, 1);
});

test('ticket creation requires an approved supported artifact and ticket updates are versioned', async (context) => {
  const store = fixtureStore(context);
  const app = createApp({ config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }), recall: {}, analysis: {}, store });
  assert.equal((await invoke(app, 'POST', '/api/meetings/mock-architecture-review/tickets', { artifactId: 'mock-artifact-action', artifactVersion: 1 })).status, 422);
  assert.equal((await invoke(app, 'POST', '/api/artifacts/mock-artifact-adr/approve', { expectedVersion: 1 })).status, 200);
  assert.equal((await invoke(app, 'POST', '/api/meetings/mock-architecture-review/tickets', { artifactId: 'mock-artifact-adr', artifactVersion: 2 })).status, 422);
  assert.equal((await invoke(app, 'POST', '/api/artifacts/mock-artifact-bug/approve', { expectedVersion: 1 })).status, 200);
  const created = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/tickets', { artifactId: 'mock-artifact-bug', artifactVersion: 2 });
  const updated = await invoke(app, 'PATCH', `/api/tickets/${created.body.ticket.id}`, { expectedVersion: 1, status: 'in_progress', priority: 'critical', owner: 'Maya Chen', notes: 'Reproduce this before the next release.' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ticket.version, 2);
  assert.equal(updated.body.ticket.status, 'in_progress');
  assert.equal((await invoke(app, 'PATCH', `/api/tickets/${created.body.ticket.id}`, { expectedVersion: 1, status: 'done', priority: null, owner: null, notes: null })).status, 409);
  assert.equal((await invoke(app, 'PATCH', `/api/tickets/${created.body.ticket.id}`, { expectedVersion: 2, status: 'invalid', priority: null, owner: null, notes: null })).status, 422);
});

test('ticket snapshots reject unsupported artifact types without inventing ticket data', () => {
  const artifact = { ...mockFixture.artifacts[0], status: 'approved', version: 2 };
  assert.throws(() => ticketFromArtifact({ id: 'ticket-1', artifact, meeting: mockFixture.meeting }), TicketValidationError);
});
