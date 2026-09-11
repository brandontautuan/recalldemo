import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { LocalRecapValidationError, recapPreviewHash, validateLocalRecap } from '../src/local-recap.js';

const bundle = {
  project: { id: 'project-local', slug: 'local', name: 'Local Project', description: 'A reviewed local project.', terminology: {}, ticketFormat: {}, isActive: true, updatedAt: '2026-01-01T00:00:00.000Z' },
  repositories: [{ id: 'repo-local', name: 'local', remoteUrl: 'https://local.invalid/not-configured', defaultBranch: 'main', metadata: {}, localPath: null, approvedFiles: [] }],
  documents: [{ id: 'doc-readme', kind: 'readme_excerpt', title: 'README', sourcePath: 'README.md', content: 'The retry policy uses bounded exponential backoff.', revision: 1, selectionPriority: 1, isActive: true, ingestionId: null, lineStart: 1, lineEnd: 1, truncated: false }],
  workItems: [],
};

const invoke = async (app, method, url, body = '') => {
  const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers: {} });
  const response = { statusCode: null, body: '', writeHead(statusCode) { this.statusCode = statusCode; }, end(value = '') { this.body += value; } };
  await app(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

test('local recap requires a reviewed preview and only accepts citations from it', async () => {
  let recapCalls = 0;
  const app = createApp({
    config: createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true' }),
    recall: {}, store: { dashboard: () => ({ meetings: [] }) }, logger: { error() {} },
    contextStore: { getProjectBundle: (id) => id === 'project-local' ? bundle : null, localRepositoriesRequireApproval: () => false },
    analysis: { async recap({ preview }) { recapCalls += 1; return { model: 'openai/gpt-oss-20b', usage: null, rateLimit: {}, output: { answer: 'Retries use bounded exponential backoff.', citations: [{ sourceId: preview.sources.find((source) => source.id === 'document:doc-readme').id, claim: 'The README describes bounded exponential backoff.' }] } }; } },
  });
  const question = 'How do retries work?';
  const previewResponse = await invoke(app, 'POST', '/api/projects/project-local/local-recap-preview', JSON.stringify({ question }));
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.preview.sources.some((source) => source.id === 'document:doc-readme'), true);

  const missingPreview = await invoke(app, 'POST', '/api/projects/project-local/local-recap', JSON.stringify({ question }));
  assert.equal(missingPreview.status, 400);
  const response = await invoke(app, 'POST', '/api/projects/project-local/local-recap', JSON.stringify({ question, preview: previewResponse.body.preview, previewSha256: previewResponse.body.previewSha256 }));
  assert.equal(response.status, 200);
  assert.equal(response.body.recap.citations[0].sourcePath, 'README.md');
  assert.equal(recapCalls, 1);

  const altered = structuredClone(previewResponse.body.preview);
  altered.sources = [];
  const alteredResponse = await invoke(app, 'POST', '/api/projects/project-local/local-recap', JSON.stringify({ question, preview: altered, previewSha256: previewResponse.body.previewSha256 }));
  assert.equal(alteredResponse.status, 409);
  assert.equal(recapCalls, 1);
});

test('local recap output rejects invented source IDs and requires citations', () => {
  const preview = { sources: [{ id: 'document:readme', label: 'README', kind: 'readme_excerpt', revision: 1, text: 'approved text' }] };
  assert.throws(() => validateLocalRecap({ answer: 'Unsupported.', citations: [{ sourceId: 'document:secret', claim: 'Nope.' }] }, preview), LocalRecapValidationError);
  assert.throws(() => validateLocalRecap({ answer: 'Uncited.', citations: [] }, preview), LocalRecapValidationError);
  assert.equal(typeof recapPreviewHash(preview), 'string');
});

test('local recap permits several distinct claims cited to the same displayed source', () => {
  const preview = { sources: [{ id: 'document:readme', label: 'README', kind: 'readme_excerpt', revision: 1, text: 'approved text' }] };
  const recap = validateLocalRecap({ answer: 'Two claims are supported.', citations: [
    { sourceId: 'document:readme', claim: 'First supported claim.' },
    { sourceId: 'document:readme', claim: 'Second supported claim.' },
  ] }, preview);
  assert.equal(recap.citations.length, 2);
});
