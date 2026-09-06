import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { ProjectContextStore } from '../src/context-db.js';
import { mockFixture } from '../src/mock-data.js';
import { RepositoryContextError, scanApprovedRepository } from '../src/repository-context.js';
import { JsonStore } from '../src/store.js';

const temporaryRepository = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-approved-root-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'project');
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'README.md'), '# Project\n\nArchitecture overview.\nService boundary.\n');
  fs.writeFileSync(path.join(repository, 'docs', 'operations.md'), '# Operations\n\nRetry policy.\n');
  fs.writeFileSync(path.join(repository, '.env'), 'SECRET=not-for-context\n');
  fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored.md\n.env\n');
  fs.writeFileSync(path.join(repository, 'ignored.md'), 'Ignored documentation.\n');
  for (const args of [['init'], ['config', 'user.email', 'test@example.test'], ['config', 'user.name', 'Test'], ['add', 'README.md', 'docs/operations.md', '.gitignore'], ['commit', '-m', 'fixture']]) {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, repository };
};

const invoke = async (app, method, url, body = '', headers = {}) => {
  const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers });
  const response = { statusCode: null, body: '', writeHead(statusCode) { this.statusCode = statusCode; }, end(value = '') { this.body += value; } };
  await app(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

test('scanner reads only explicit bounded documents and produces a reproducible fingerprint', (context) => {
  const { root, repository } = temporaryRepository(context);
  const options = { repositoryPath: repository, approvedFiles: ['docs/operations.md', 'README.md'], allowedRoots: [root], maximumFileCharacters: 40 };
  const first = scanApprovedRepository(options);
  const second = scanApprovedRepository(options);
  assert.deepEqual(first.documents.map(({ sourcePath, lineStart, lineEnd, truncated }) => ({ sourcePath, lineStart, lineEnd, truncated })), [
    { sourcePath: 'docs/operations.md', lineStart: 1, lineEnd: 3, truncated: false },
    { sourcePath: 'README.md', lineStart: 1, lineEnd: 3, truncated: true },
  ]);
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
  assert.match(first.commitVersion, /^[a-f0-9]{40}$/);
  assert.equal(first.trackedFiles.includes('ignored.md'), false);
  assert.equal(first.trackedFiles.includes('.env'), false);
  assert.equal(first.documents.some((document) => document.content.includes('SECRET=')), false);
});

test('scanner rejects traversal, secrets, symlinks, oversized files, and repositories outside approved roots', (context) => {
  const { root, repository } = temporaryRepository(context);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-outside-root-'));
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'README.md'), 'Outside');
  fs.symlinkSync(path.join(outside, 'README.md'), path.join(repository, 'linked.md'));
  assert.throws(() => scanApprovedRepository({ repositoryPath: repository, approvedFiles: ['../README.md'], allowedRoots: [root] }), RepositoryContextError);
  assert.throws(() => scanApprovedRepository({ repositoryPath: repository, approvedFiles: ['.env'], allowedRoots: [root] }), /secrets/);
  assert.throws(() => scanApprovedRepository({ repositoryPath: repository, approvedFiles: ['linked.md'], allowedRoots: [root] }), /escapes/);
  assert.throws(() => scanApprovedRepository({ repositoryPath: repository, approvedFiles: ['README.md'], allowedRoots: [root], maximumFileBytes: 5 }), /exceeds/);
  assert.throws(() => scanApprovedRepository({ repositoryPath: outside, approvedFiles: ['README.md'], allowedRoots: [root] }), /outside/);
});

test('local project API stages reviewable context and activates it only after approval', async (context) => {
  const { root, repository } = temporaryRepository(context);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-local-project-api-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contextStore = new ProjectContextStore(path.join(directory, 'context.sqlite'));
  contextStore.migrate();
  context.after(() => contextStore.close());
  const store = new JsonStore(path.join(directory, 'store.json'));
  store.seedMock(mockFixture);
  const adminToken = 'local-test-admin-token';
  const adminHeaders = { 'x-project-context-admin-token': adminToken };
  const config = createConfig({ RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', PROJECT_REPOSITORY_ROOTS: root, PROJECT_CONTEXT_ADMIN_TOKEN: adminToken });
  const neverExternal = new Proxy({}, { get: () => async () => { throw new Error('external call not expected'); } });
  const app = createApp({ config, contextStore, store, recall: neverExternal, analysis: neverExternal });

  const projectRequest = JSON.stringify({ slug: 'local-project', name: 'Local Project', description: 'Approved local repository context.', repositoryPath: repository, approvedFiles: ['README.md', 'docs/operations.md'] });
  assert.equal((await invoke(app, 'POST', '/api/projects/local', projectRequest)).status, 401);
  const created = await invoke(app, 'POST', '/api/projects/local', projectRequest, adminHeaders);
  assert.equal(created.status, 201);
  const projects = await invoke(app, 'GET', '/api/projects');
  const project = projects.body.projects.find((item) => item.id === 'project-local-project');
  assert.equal(project.localRepositories[0].configured, true);
  assert.equal('localPath' in project.localRepositories[0], false, 'absolute repository paths must not be returned to the browser');

  const scanned = await invoke(app, 'POST', '/api/projects/project-local-project/repositories/repo-local-project/scan', '', adminHeaders);
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.ingestion.status, 'pending_review');
  assert.deepEqual(scanned.body.ingestion.documents.map((document) => document.sourcePath), ['docs/operations.md', 'README.md']);
  assert.equal(contextStore.getProjectBundle(project.id).documents.filter((document) => document.isActive).length, 0);

  const approved = await invoke(app, 'POST', `/api/projects/${project.id}/ingestions/${scanned.body.ingestion.id}/approve`, '', adminHeaders);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.ingestion.status, 'approved');
  assert.equal(contextStore.getProjectBundle(project.id).documents.filter((document) => document.isActive).length, 2);

  const preview = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: project.id }));
  assert.equal(preview.status, 201);
  fs.appendFileSync(path.join(repository, 'README.md'), 'Changed after approval.\n');
  const stale = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/context-preview', JSON.stringify({ projectId: project.id }));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed after approval/);

  const rescanned = await invoke(app, 'POST', '/api/projects/project-local-project/repositories/repo-local-project/scan', '', adminHeaders);
  assert.equal(rescanned.status, 201);
  assert.notEqual(rescanned.body.ingestion.sourceFingerprint, scanned.body.ingestion.sourceFingerprint);
  assert.equal((await invoke(app, 'POST', `/api/projects/${project.id}/ingestions/${rescanned.body.ingestion.id}/approve`, '', adminHeaders)).status, 200);
  assert.equal(contextStore.getContextIngestion(scanned.body.ingestion.id).status, 'superseded');
  assert.equal(contextStore.getContextSelection(preview.body.contextSelection.id).sources.some((source) => source.ingestionId === scanned.body.ingestion.id), true);
  assert.equal((await invoke(app, 'POST', `/api/meetings/mock-architecture-review/context-preview/${preview.body.contextSelection.id}/approve`)).status, 200);
  const obsoleteAnalysis = await invoke(app, 'POST', '/api/meetings/mock-architecture-review/analyze', JSON.stringify({ contextSelectionId: preview.body.contextSelection.id }));
  assert.equal(obsoleteAnalysis.status, 409);
  assert.match(obsoleteAnalysis.body.error, /superseded/);
});
