import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { ProjectContextStore } from '../src/context-db.js';
import { loadSeedManifest } from '../src/context-seed.js';
import { mockFixture } from '../src/mock-data.js';
import { JsonStore } from '../src/store.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const invoke = async (app, method, url, body = '') => {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers: {} });
  const response = { statusCode: null, body: '', writeHead(status) { this.statusCode = status; }, end(value = '') { this.body += value; } };
  await app(req, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

const fixtureApp = (context, analyzeImplementation = null) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-context-api-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contextStore = new ProjectContextStore(path.join(directory, 'context.sqlite'));
  contextStore.migrate();
  const seed = loadSeedManifest(path.join(repositoryRoot, 'seeds/project-context.example.json'));
  contextStore.ingestSeed(seed.manifest);
  const store = new JsonStore(path.join(directory, 'recall-store.json'));
  store.seedMock(mockFixture);
  let recallCalls = 0;
  let analysisCalls = 0;
  let lastAnalysisInput = null;
  const recall = new Proxy({}, { get() { return async () => { recallCalls += 1; }; } });
  const analysis = { async analyze(input) { analysisCalls += 1; lastAnalysisInput = input; return analyzeImplementation ? analyzeImplementation(input) : undefined; } };
  const config = createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' });
  const app = createApp({ config, recall, analysis, store, contextStore });
  context.after(() => contextStore.close());
  return { app, contextStore, store, calls: () => ({ recallCalls, analysisCalls }), lastAnalysisInput: () => lastAnalysisInput };
};

test('lists active projects and returns source inventory without document contents', async (context) => {
  const { app } = fixtureApp(context);
  const projects = await invoke(app, 'GET', '/api/projects');
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body.projects.map((project) => project.id), ['project-event-platform', 'project-mobile-release']);
  const inventory = await invoke(app, 'GET', '/api/projects/project-event-platform/context');
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.sources.length, 6);
  assert.doesNotMatch(JSON.stringify(inventory.body), /validates event envelopes/);
});

test('creates and persists an immutable bounded context preview without external calls', async (context) => {
  const { app, contextStore, calls } = fixtureApp(context);
  const response = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({
    projectId: 'project-event-platform',
    projectContext: 'Focus on event ingestion and dead-letter queue reliability.',
  }));
  assert.equal(response.status, 201);
  const preview = response.body.contextSelection;
  assert.equal(preview.meetingId, 'mock-architecture-review');
  assert.equal(preview.projectId, 'project-event-platform');
  assert.equal(preview.schemaVersion, 'project-context-selection/v1');
  assert.ok(preview.sources.some((source) => source.id === 'work-item:work-event-dlq-observability'));
  assert.ok(preview.omissions.some((omission) => omission.sourceId === 'document:doc-event-retired-guidance' && omission.reason === 'inactive'));
  assert.ok(preview.omissions.some((omission) => omission.sourceId === 'work-item:work-event-dashboard-colors' && omission.reason === 'no_lexical_overlap'));
  assert.ok(preview.characterCount <= preview.maximumCharacters);
  assert.deepEqual(calls(), { recallCalls: 0, analysisCalls: 0 });
  assert.deepEqual(contextStore.getContextSelection(preview.id), preview);
  const association = contextStore.database.prepare("SELECT project_id FROM meeting_project_context WHERE meeting_id = 'mock-architecture-review'").get();
  assert.equal(association.project_id, 'project-event-platform');
});

test('context preview validates meetings, transcripts, projects, and request fields', async (context) => {
  const { app, contextStore, store } = fixtureApp(context);
  assert.equal((await invoke(app, 'POST', '/api/meetings/missing/context-preview', JSON.stringify({ projectId: 'project-event-platform' }))).status, 404);
  assert.equal((await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'missing' }))).status, 404);
  assert.equal((await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'project-event-platform', sources: ['arbitrary'] }))).status, 400);
  contextStore.database.prepare("UPDATE projects SET is_active = 0 WHERE id = 'project-event-platform'").run();
  assert.equal((await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'project-event-platform' }))).status, 409);
  contextStore.database.prepare("UPDATE projects SET is_active = 1 WHERE id = 'project-event-platform'").run();
  store.saveTranscript(mockFixture.transcript.id, { ...mockFixture.transcript, status: 'failed' });
  assert.equal((await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'project-event-platform' }))).status, 409);
});

test('detects persisted context snapshot tampering', async (context) => {
  const { app, contextStore } = fixtureApp(context);
  const response = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'project-event-platform' }));
  const id = response.body.contextSelection.id;
  contextStore.database.prepare('UPDATE context_selections SET selection_json = ? WHERE id = ?').run('{}', id);
  assert.throws(() => contextStore.getContextSelection(id), /integrity check/);
});

test('binds one verified preview to one explicit manual analysis and hydrates context provenance', async (context) => {
  const generatedArtifact = {
    type: 'action_item', title: 'Document the event retry policy', status: 'proposed', description: 'Document the agreed event retry and dead-letter queue policy.', context: null, decision: null,
    alternativesRejected: [], consequences: [], assignee: null, dueDate: null, acceptanceCriteria: ['The retry policy is documented.'], priority: 'medium',
    stepsToReproduce: [], expectedBehavior: null, actualBehavior: null, severity: null, impact: null, mitigation: null, owner: null, question: null, suggestedOwner: null,
    summary: 'Document the retry policy.', problem: 'The retry policy is not recorded.', whyItMatters: 'Reliable event delivery needs explicit retry rules.', proposedImplementationAreas: ['Event ingestion documentation'], dependencies: [], risks: [], openQuestions: [],
    repositoryReferences: [],
    evidenceUtteranceIds: ['mock-utterance-1'], contextSourceIds: ['document:doc-event-readme-overview'], confidence: 'high',
  };
  const fixture = fixtureApp(context, () => ({ model: 'openai/gpt-oss-20b', usage: null, rateLimit: {}, output: { artifacts: [generatedArtifact] } }));
  const notes = 'Focus on event ingestion and dead-letter queue reliability.';
  const previewResponse = await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'project-event-platform', projectContext: notes }));
  const selection = previewResponse.body.contextSelection;
  assert.equal((await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: selection.id, projectContext: notes }))).status, 409);
  assert.equal(fixture.calls().analysisCalls, 0);
  const approvalResponse = await invoke(fixture.app, 'POST', `/api/meetings/mock-architecture-review/context-preview/${selection.id}/approve`);
  assert.equal(approvalResponse.status, 200);
  const analysisResponse = await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: selection.id, projectContext: notes }));
  assert.equal(analysisResponse.status, 200);
  assert.equal(fixture.calls().analysisCalls, 1);
  assert.equal(fixture.lastAnalysisInput().contextSelection.id, selection.id);
  assert.equal(analysisResponse.body.analysis.contextSelectionId, selection.id);
  assert.equal(analysisResponse.body.analysis.contextSelectionSha256, selection.contentSha256);
  assert.equal(analysisResponse.body.artifacts[0].contextProvenance.selectionId, selection.id);
  assert.deepEqual(analysisResponse.body.artifacts[0].contextProvenance.sources, [{ sourceId: 'document:doc-event-readme-overview', kind: 'readme_excerpt', label: 'Event ingestion overview', revision: 1, sourcePath: 'README.md#architecture', lineStart: null, lineEnd: null, ingestionId: null, truncated: false, trackedFiles: [] }]);
  assert.equal(fixture.contextStore.getContextSelection(selection.id).analysisId, analysisResponse.body.analysis.id);
  const persistedRun = fixture.contextStore.database.prepare('SELECT status, provider, context_selection_id AS contextSelectionId FROM analysis_runs WHERE id = ?').get(analysisResponse.body.analysis.id);
  assert.equal(persistedRun.status, 'completed');
  assert.equal(persistedRun.provider, 'groq');
  assert.equal(persistedRun.contextSelectionId, selection.id);
  const reused = await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: selection.id, projectContext: notes }));
  assert.equal(reused.status, 409);
  assert.equal(fixture.calls().analysisCalls, 1);
});

test('rejects changed notes, cross-meeting previews, unavailable projects, and arbitrary context input before Groq', async (context) => {
  const fixture = fixtureApp(context);
  const notes = 'Original ranking notes.';
  const previewResponse = await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: 'project-event-platform', projectContext: notes }));
  const selectionId = previewResponse.body.contextSelection.id;
  assert.equal((await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: selectionId, projectContext: 'Changed notes.' }))).status, 409);
  assert.equal((await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: 'missing', projectContext: notes }))).status, 404);
  assert.equal((await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: selectionId, projectContext: notes, contextSources: [] }))).status, 400);
  fixture.store.addMeeting({ id: 'another-meeting', title: 'Other', meetingType: 'general_technical_sync', participants: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  fixture.store.saveTranscript('other-transcript', { id: 'other-transcript', meetingId: 'another-meeting', status: 'done', utterances: [{ id: 'other-utterance', text: 'Other meeting.' }] });
  assert.equal((await invoke(fixture.app, 'POST', '/api/meetings/another-meeting/analyze', JSON.stringify({ contextSelectionId: selectionId, projectContext: notes }))).status, 409);
  fixture.contextStore.database.prepare("UPDATE projects SET is_active = 0 WHERE id = 'project-event-platform'").run();
  assert.equal((await invoke(fixture.app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: selectionId, projectContext: notes }))).status, 409);
  assert.deepEqual(fixture.calls(), { recallCalls: 0, analysisCalls: 0 });
});
