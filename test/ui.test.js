import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import {
  contextPreviewIsCurrent,
  approveContextPreview,
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
  state = approveContextPreview(state, { ...state.preview, approvedAt: '2026-01-01T00:00:00.000Z' });
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
  assert.match(indexHtml, /One-time repository setup/);
  assert.match(indexHtml, /Scan project context/);
  assert.match(indexHtml, /Approve collected context/);
  assert.match(indexHtml, /Approve context snapshot/);
  assert.doesNotMatch(indexHtml, /setInterval\([^]*\/analyze/);
});

test('mock-mode UI exposes a confirmed fixture reset and explicit privacy boundaries', () => {
  assert.match(indexHtml, /id="reset-demo"/);
  assert.match(indexHtml, /Reset only the clearly labeled demo fixture/);
  assert.match(indexHtml, /stores the normalized transcript locally, not recording media/);
  assert.match(indexHtml, /sent to Groq only after you explicitly confirm analysis/);
  assert.match(indexHtml, /Canonical application JSON \(recommended\)/);
  assert.match(indexHtml, /Show meeting workflow/);
  assert.match(indexHtml, /local-recap-mode/);
});

test('dashboard exposes a preview-gated local manual transcript workflow', () => {
  assert.match(indexHtml, /Create a manual transcript/);
  assert.match(indexHtml, /Load sample transcript/);
  assert.match(indexHtml, /Preview parsed transcript/);
  assert.match(indexHtml, /Create manual meeting/);
  assert.match(indexHtml, /\/api\/manual-transcripts\/preview/);
  assert.match(indexHtml, /\/api\/manual-meetings/);
  assert.match(indexHtml, /does not contact Recall or Groq/);
  assert.match(indexHtml, /manualPreviewFingerprint/);
});

test('the normalized transcript collapses and survives the dashboard poll', () => {
  // Collapsed by default, with the utterance count readable without expanding.
  assert.match(indexHtml, /node\('details', undefined, 'transcript-panel'\)/);
  assert.match(indexHtml, /transcriptSection\.open = expandedTranscripts\.has\(meeting\.id\)/);
  assert.match(indexHtml, /'utterance' : 'utterances'/);
  // The poll calls replaceChildren on every card, so the open set is what keeps a panel open.
  assert.match(indexHtml, /const expandedTranscripts = new Set\(\)/);
  assert.match(indexHtml, /expandedTranscripts\.add\(meeting\.id\)/);
  assert.match(indexHtml, /expandedTranscripts\.delete\(meeting\.id\)/);
  // Evidence jumps must still land when the panel is closed.
  assert.match(indexHtml, /target\.closest\('\.transcript-panel'\)/);
  assert.match(indexHtml, /if \(panel && !panel\.open\)/);
  // Expanded height is capped so a long transcript still cannot fill the screen.
  assert.match(indexHtml, /\.transcript-turns \{ max-height: 30rem; overflow-y: auto;/);
});

test('a stored analysis result from an earlier session is not replayed on the meeting card', () => {
  // A failure the user did not trigger in this page session must not render at all.
  assert.match(indexHtml, /const analysisRequestedHere = new Set\(\)/);
  assert.match(indexHtml, /analysis && analysisRequestedHere\.has\(meeting\.id\)/);
  assert.match(indexHtml, /analysisRequestedHere\.add\(meeting\.id\)/);
  // An in-flight run still reports itself regardless of who started it.
  assert.match(indexHtml, /analysis\?\.status === 'running'\) card\.append\(node\('p', 'Groq analysis: running…'/);
  // Suppressed from the card is not the same as discarded: it still reaches the console, once.
  assert.match(indexHtml, /console\.warn\('Groq analysis failed'/);
  assert.match(indexHtml, /const loggedAnalysisFailures = new Set\(\)/);
  assert.match(indexHtml, /!loggedAnalysisFailures\.has\(analysis\.id\)/);
  assert.match(indexHtml, /loggedAnalysisFailures\.add\(analysis\.id\)/);
});

test('the meeting card offers an inline rename that persists through the API', () => {
  assert.match(indexHtml, /node\('button', 'Rename', 'title-action'\)/);
  assert.match(indexHtml, /method: 'PATCH'/);
  assert.match(indexHtml, /fetch\(`\/api\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}`/);
  // An in-progress draft must survive the poll that rebuilds every card.
  assert.match(indexHtml, /const renamingMeetings = new Map\(\)/);
  assert.match(indexHtml, /renamingMeetings\.set\(meeting\.id, input\.value\)/);
  // Keyboard affordances and a cancel path.
  assert.match(indexHtml, /event\.key === 'Enter'/);
  assert.match(indexHtml, /event\.key === 'Escape'/);
  assert.match(indexHtml, /input\.maxLength = 200/);
});

test('the transcript panel is themed in dark mode like every other card', () => {
  const darkBlock = indexHtml.slice(indexHtml.indexOf('@media (prefers-color-scheme: dark)'));
  // The panel is a <details>, so the section/article card rules do not reach it on their own.
  assert.match(darkBlock, /section, article, \.context-preview, \.transcript-panel \{ background: #182335;/);
  assert.match(darkBlock, /\.transcript-turns \{ border-color: #30425f; \}/);
  assert.match(darkBlock, /\.transcript-panel > summary::before[^}]*color: #7fa6ff;/);
});

test('dashboard exposes a server-authorized local repository context form', () => {
  assert.match(indexHtml, /One-time repository setup/);
  assert.match(indexHtml, /Local repository path/);
  assert.match(indexHtml, /\/api\/projects\/local/);
  assert.match(indexHtml, /projectAdminHeaders/);
  assert.doesNotMatch(indexHtml, /github/i);
});

test('dashboard exposes a separate local ticket workspace with explicit source-linked creation', () => {
  assert.match(indexHtml, /id="tickets-tab-button"/);
  assert.match(indexHtml, /Local tickets/);
  assert.match(indexHtml, /Create local ticket/);
  assert.match(indexHtml, /artifact version/);
  assert.match(indexHtml, /\/api\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}\/tickets/);
  assert.match(indexHtml, /\/api\/tickets\/\$\{encodeURIComponent\(ticket\.id\)\}/);
});

test('dashboard exposes an explicit preview-gated local context recap workflow', () => {
  assert.match(indexHtml, /Ask your repository/);
  assert.match(indexHtml, /1\. Preview sources/);
  assert.match(indexHtml, /Ask Groq for recap/);
  assert.match(indexHtml, /local-recap-preview/);
  assert.match(indexHtml, /local-recap/);
  assert.match(indexHtml, /does not read arbitrary files/);
  assert.match(indexHtml, /Preview sources before asking Groq for a recap/);
  assert.match(indexHtml, /Step 1: preview the exact local sources/);
  assert.match(indexHtml, /recapButton\.hidden/);
  assert.match(indexHtml, /recap-form/);
  assert.match(indexHtml, /recap-admin-token/);
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
