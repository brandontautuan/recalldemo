import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import {
  contextPreviewIsCurrent,
  contextPreviewPayload,
  createMeetingContextState,
  manualAnalysisPayload,
  saveContextPreview,
  updateMeetingContext,
} from '../public/context-ui-state.js';

const indexHtml = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const contextStateModule = fs.readFileSync(fileURLToPath(new URL('../public/context-ui-state.js', import.meta.url)), 'utf8');

test('project context UI requires a matching current preview before selected-context analysis', () => {
  let state = createMeetingContextState();
  assert.deepEqual(manualAnalysisPayload(state), { projectContext: '' });
  state = updateMeetingContext(state, { projectId: 'project-event-platform', projectContext: 'Focus on retries.' });
  assert.deepEqual(contextPreviewPayload(state), { projectId: 'project-event-platform', projectContext: 'Focus on retries.' });
  assert.equal(contextPreviewIsCurrent(state), false);
  assert.throws(() => manualAnalysisPayload(state), /current context preview/);
  state = saveContextPreview(state, { id: 'selection-1', projectId: 'project-event-platform', analysisId: null });
  assert.equal(contextPreviewIsCurrent(state), true);
  assert.deepEqual(manualAnalysisPayload(state), { contextSelectionId: 'selection-1', projectContext: 'Focus on retries.' });
});

test('changing notes or project invalidates a preview and prevents stale submission', () => {
  let state = updateMeetingContext(createMeetingContextState(), { projectId: 'project-event-platform', projectContext: 'Original notes.' });
  state = saveContextPreview(state, { id: 'selection-1', projectId: 'project-event-platform', analysisId: null });
  state = updateMeetingContext(state, { projectContext: 'Changed notes.' });
  assert.equal(state.preview, null);
  assert.throws(() => manualAnalysisPayload(state), /current context preview/);
  state = saveContextPreview(state, { id: 'selection-2', projectId: 'project-event-platform', analysisId: null });
  state = updateMeetingContext(state, { projectId: 'project-mobile-release' });
  assert.equal(state.preview, null);
});

test('dashboard exposes explicit preview, confirmation-only analysis, and separate provenance surfaces', () => {
  assert.match(indexHtml, /Preview selected context/);
  assert.match(indexHtml, /Context preview — no Groq request made/);
  assert.match(indexHtml, /window\.confirm\(disclosure\)/);
  assert.match(contextStateModule, /contextSelectionId/);
  assert.match(indexHtml, /Retrieved project context/);
  assert.match(indexHtml, /Transcript evidence/);
  assert.doesNotMatch(indexHtml, /setInterval\([^]*\/analyze/);
});

test('application serves the browser context-state module as JavaScript', async () => {
  const app = createApp({
    config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }),
    store: { dashboard: () => ({ meetings: [] }) },
    recall: {},
    analysis: {},
  });
  const request = Object.assign(Readable.from([]), { method: 'GET', url: '/context-ui-state.js', headers: {} });
  const response = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(body = '') { this.body += body; },
  };
  await app(request, response);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['Content-Type'], /text\/javascript/);
  assert.match(response.body, /manualAnalysisPayload/);
});
