import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectContextStore } from '../src/context-db.js';
import { ContextSeedValidationError, loadSeedManifest, normalizeSeedManifest, validateSeedManifest } from '../src/context-seed.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-context-seed-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const fixtureManifest = () => ({
  schemaVersion: 'project-context-seed/v1',
  projects: [{
    id: 'Project-Alpha', slug: 'Project-Alpha', name: '  Project   Alpha ', description: 'Line one.\r\nLine two.  ',
    terminology: { Zed: 'last', Alpha: 'first' }, ticketFormat: { required: ['Summary'] },
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    repositories: [{ id: 'Repo-Alpha', name: ' Alpha Repo ', remoteUrl: 'https://example.test/alpha#readme', defaultBranch: ' main ', metadata: { language: 'JavaScript' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }],
    documents: [{ id: 'Doc-Alpha', repositoryId: 'Repo-Alpha', kind: 'readme_excerpt', title: ' Overview ', sourcePath: 'docs\\overview.md', content: 'First line.  \r\nSecond line.\t', revision: 1, selectionPriority: 10, isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }],
    workItems: [{ id: 'Work-Alpha', externalKey: 'ALPHA-1', title: ' Add retries ', description: 'Bound retry behavior. ', status: ' OPEN ', priority: ' High ', selectionPriority: 20, labels: ['backend', ' reliability ', 'backend'], sourceUrl: 'https://example.test/issues/1#details', updatedAt: '2026-01-03T00:00:00Z' }],
  }],
});

const openStore = (context) => {
  const store = new ProjectContextStore(path.join(temporaryDirectory(context), 'context.sqlite'));
  store.migrate();
  return store;
};

test('normalizes seed content and calculates a deterministic manifest hash', () => {
  const first = normalizeSeedManifest(fixtureManifest());
  const second = normalizeSeedManifest(structuredClone(fixtureManifest()));
  assert.equal(first.contentSha256, second.contentSha256);
  assert.match(first.contentSha256, /^[a-f0-9]{64}$/);
  const [project] = first.manifest.projects;
  assert.equal(project.id, 'project-alpha');
  assert.equal(project.name, 'Project Alpha');
  assert.equal(project.description, 'Line one.\nLine two.');
  assert.equal(project.repositories[0].remoteUrl, 'https://example.test/alpha');
  assert.equal(project.documents[0].sourcePath, 'docs/overview.md');
  assert.equal(project.documents[0].content, 'First line.\nSecond line.');
  assert.deepEqual(project.workItems[0].labels, ['backend', 'reliability']);
});

test('dry-run rolls back and committed ingestion is idempotent', (context) => {
  const store = openStore(context);
  const { manifest } = normalizeSeedManifest(fixtureManifest());
  const dryRun = store.ingestSeed(manifest, { dryRun: true });
  assert.deepEqual(Object.values(dryRun).map((entry) => entry.inserted), [1, 1, 1, 1]);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 0);
  const committed = store.ingestSeed(manifest);
  assert.deepEqual(Object.values(committed).map((entry) => entry.inserted), [1, 1, 1, 1]);
  const repeated = store.ingestSeed(manifest);
  assert.deepEqual(Object.values(repeated).map((entry) => entry.unchanged), [1, 1, 1, 1]);
  const manifestWithoutChildren = structuredClone(manifest);
  manifestWithoutChildren.projects[0].repositories = [];
  manifestWithoutChildren.projects[0].documents = [];
  manifestWithoutChildren.projects[0].workItems = [];
  store.ingestSeed(manifestWithoutChildren);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM context_documents').get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM work_items').get().count, 1);
  store.close();
});

test('requires higher document revisions and newer timestamps for changed records', (context) => {
  const store = openStore(context);
  const original = fixtureManifest();
  store.ingestSeed(normalizeSeedManifest(original).manifest);

  const staleDocument = structuredClone(original);
  staleDocument.projects[0].documents[0].content = 'Changed without revision.';
  assert.throws(() => store.ingestSeed(normalizeSeedManifest(staleDocument).manifest), /without a higher revision/);

  const updated = structuredClone(original);
  updated.projects[0].documents[0].content = 'Changed with revision.';
  updated.projects[0].documents[0].revision = 2;
  updated.projects[0].documents[0].isActive = false;
  updated.projects[0].documents[0].updatedAt = '2026-01-04T00:00:00Z';
  updated.projects[0].workItems[0].description = 'Updated work item.';
  updated.projects[0].workItems[0].updatedAt = '2026-01-04T00:00:00Z';
  const summary = store.ingestSeed(normalizeSeedManifest(updated).manifest);
  assert.equal(summary.documents.updated, 1);
  assert.equal(summary.workItems.updated, 1);
  assert.equal(store.database.prepare("SELECT is_active FROM context_documents WHERE id = 'doc-alpha'").get().is_active, 0);

  const staleWorkItem = structuredClone(updated);
  staleWorkItem.projects[0].workItems[0].description = 'Conflicting same timestamp.';
  assert.throws(() => store.ingestSeed(normalizeSeedManifest(staleWorkItem).manifest), /newer updatedAt/);
  store.close();
});

test('rejects unsupported, duplicated, malformed, and oversized manifest fields', () => {
  const invalid = fixtureManifest();
  invalid.unexpected = true;
  invalid.projects[0].documents[0].kind = 'live_github_document';
  invalid.projects[0].documents[0].repositoryId = 'missing-repository';
  invalid.projects[0].workItems.push(structuredClone(invalid.projects[0].workItems[0]));
  invalid.projects[0].description = 'x'.repeat(10_001);
  invalid.projects[0].repositories[0].remoteUrl = 'https://token@example.test/private';
  invalid.projects[0].repositories[0].metadata = [];
  invalid.projects[0].workItems[0].updatedAt = 'not-a-date';
  assert.throws(() => validateSeedManifest(invalid), (error) => {
    assert.ok(error instanceof ContextSeedValidationError);
    assert.ok(error.issues.some((issue) => issue.includes('manifest.unexpected')));
    assert.ok(error.issues.some((issue) => issue.includes('kind is unsupported')));
    assert.ok(error.issues.some((issue) => issue.includes('same project')));
    assert.ok(error.issues.some((issue) => issue.includes('id is duplicated')));
    assert.ok(error.issues.some((issue) => issue.includes('at most 10000')));
    assert.ok(error.issues.some((issue) => issue.includes('embedded credentials')));
    assert.ok(error.issues.some((issue) => issue.includes('metadata must be an object')));
    assert.ok(error.issues.some((issue) => issue.includes('valid timestamp')));
    return true;
  });
  const wrongVersion = fixtureManifest();
  wrongVersion.schemaVersion = 'project-context-seed/v2';
  assert.throws(() => validateSeedManifest(wrongVersion), /schemaVersion/);
});

test('loads only bounded regular seed files outside the public directory', (context) => {
  const directory = temporaryDirectory(context);
  const seedPath = path.join(directory, 'seed.json');
  fs.writeFileSync(seedPath, JSON.stringify(fixtureManifest()));
  assert.equal(loadSeedManifest(seedPath).manifest.projects.length, 1);
  assert.throws(() => loadSeedManifest(seedPath, { maximumBytes: 10 }), /exceeds 10 bytes/);
  const linkPath = path.join(directory, 'seed-link.json');
  fs.symlinkSync(seedPath, linkPath);
  assert.throws(() => loadSeedManifest(linkPath), /symbolic link/);
  const publicDirectory = path.join(directory, 'public');
  fs.mkdirSync(publicDirectory);
  const publicSeed = path.join(publicDirectory, 'seed.json');
  fs.writeFileSync(publicSeed, JSON.stringify(fixtureManifest()));
  assert.throws(() => loadSeedManifest(publicSeed, { publicDirectory }), /public directory/);
});

test('rolls back every resource when a database conflict occurs', (context) => {
  const store = openStore(context);
  const initial = fixtureManifest();
  store.ingestSeed(normalizeSeedManifest(initial).manifest);
  const conflicting = fixtureManifest();
  conflicting.projects = [
    { ...structuredClone(conflicting.projects[0]), id: 'project-before-conflict', slug: 'before-conflict', repositories: [], documents: [], workItems: [] },
    { ...structuredClone(conflicting.projects[0]), id: 'project-conflict', repositories: [], documents: [], workItems: [] },
  ];
  assert.throws(() => store.ingestSeed(normalizeSeedManifest(conflicting).manifest), /UNIQUE constraint/);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'project-before-conflict'").get().count, 0);
  store.close();
});

test('seed command reports hashes and counts without printing corpus content', (context) => {
  const directory = temporaryDirectory(context);
  const seedPath = path.join(directory, 'seed.json');
  const databasePath = path.join(directory, 'context.sqlite');
  fs.writeFileSync(seedPath, JSON.stringify(fixtureManifest()));
  const execution = spawnSync(process.execPath, ['src/scripts/seed-context.js', '--dry-run'], {
    cwd: repositoryRoot,
    env: { ...process.env, PROJECT_CONTEXT_SEED_PATH: seedPath, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /"mode": "dry-run"/);
  assert.match(execution.stdout, /"manifestSha256": "[a-f0-9]{64}"/);
  assert.doesNotMatch(execution.stdout, /Bound retry behavior/);
  const store = new ProjectContextStore(databasePath);
  store.migrate();
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 0);
  store.close();
});
