import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ProjectContextStore } from '../src/context-db.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, 'migrations');
const temporaryDirectory = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-context-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('creates the project-context schema and reapplies migrations idempotently', (context) => {
  const databasePath = path.join(temporaryDirectory(context), 'context.sqlite');
  const store = new ProjectContextStore(databasePath);
  assert.deepEqual(store.migrate(), [1, 2, 3, 4]);
  assert.equal(store.schemaVersion(), 4);
  assert.deepEqual(store.migrate(), []);
  store.close();

  const database = new DatabaseSync(databasePath);
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  for (const table of ['analysis_runs', 'context_documents', 'context_ingestions', 'context_selections', 'meeting_project_context', 'projects', 'repositories', 'schema_migrations', 'work_items']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  const indexes = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map((row) => row.name);
  assert.ok(indexes.includes('context_documents_project_active_idx'));
  assert.ok(indexes.includes('context_selections_meeting_idx'));
  database.close();
});

test('enforces foreign keys, document kinds, JSON, hashes, and priorities', (context) => {
  const store = new ProjectContextStore(path.join(temporaryDirectory(context), 'context.sqlite'));
  store.migrate();
  const database = store.database;
  assert.throws(() => database.prepare("INSERT INTO repositories (id, project_id, name, remote_url, default_branch, metadata_json, created_at, updated_at) VALUES ('repo', 'missing', 'Repo', 'https://example.test/repo', 'main', '{}', 'now', 'now')").run(), /FOREIGN KEY/);
  database.prepare("INSERT INTO projects (id, slug, name, description, terminology_json, ticket_format_json, created_at, updated_at) VALUES ('project', 'project', 'Project', 'Description', '{}', '{}', 'now', 'now')").run();
  assert.throws(() => database.prepare("INSERT INTO context_documents (id, project_id, repository_id, kind, title, source_path, content, content_sha256, revision, selection_priority, is_active, created_at, updated_at) VALUES ('doc', 'project', NULL, 'unknown', 'Doc', 'README.md', 'Text', ?, 1, 0, 1, 'now', 'now')").run('a'.repeat(64)), /CHECK constraint/);
  assert.throws(() => database.prepare("INSERT INTO work_items VALUES ('work', 'project', 'ENG-1', 'Title', 'Description', 'open', NULL, -1, '[]', NULL, 'now')").run(), /CHECK constraint/);
  assert.throws(() => database.prepare("INSERT INTO work_items VALUES ('work', 'project', 'ENG-1', 'Title', 'Description', 'open', NULL, 0, 'not-json', NULL, 'now')").run(), /CHECK constraint/);
  store.close();
});

test('detects migration checksum changes and duplicate versions', (context) => {
  const directory = temporaryDirectory(context);
  const customMigrations = path.join(directory, 'migrations');
  fs.mkdirSync(customMigrations);
  fs.writeFileSync(path.join(customMigrations, '001_first.sql'), 'CREATE TABLE first_table (id TEXT PRIMARY KEY) STRICT;');
  const store = new ProjectContextStore(path.join(directory, 'context.sqlite'), { migrationsDirectory: customMigrations });
  store.migrate();
  fs.writeFileSync(path.join(customMigrations, '001_first.sql'), 'CREATE TABLE changed_table (id TEXT PRIMARY KEY) STRICT;');
  assert.throws(() => store.migrate(), /does not match/);
  fs.writeFileSync(path.join(customMigrations, '001_duplicate.sql'), 'SELECT 1;');
  assert.throws(() => store.migrate(), /Duplicate migration version/);
  store.close();
});

test('rolls back a failed migration without advancing the schema version', (context) => {
  const directory = temporaryDirectory(context);
  const customMigrations = path.join(directory, 'migrations');
  fs.mkdirSync(customMigrations);
  fs.writeFileSync(path.join(customMigrations, '001_first.sql'), 'CREATE TABLE first_table (id TEXT PRIMARY KEY) STRICT;');
  fs.writeFileSync(path.join(customMigrations, '002_broken.sql'), 'CREATE TABLE rolled_back (id TEXT); INVALID SQL;');
  const store = new ProjectContextStore(path.join(directory, 'context.sqlite'), { migrationsDirectory: customMigrations });
  assert.throws(() => store.migrate(), /002_broken\.sql failed/);
  assert.equal(store.schemaVersion(), 1);
  const rolledBack = store.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'rolled_back'").get();
  assert.equal(rolledBack, undefined);
  store.close();
});

test('rejects an unavailable database path', (context) => {
  const directory = temporaryDirectory(context);
  const blockingFile = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockingFile, 'blocked');
  assert.throws(() => new ProjectContextStore(path.join(blockingFile, 'context.sqlite')));
});

test('smoke startup migrates in memory and leaves the configured database path untouched', (context) => {
  const databasePath = path.join(temporaryDirectory(context), 'should-not-exist.sqlite');
  const execution = spawnSync(process.execPath, ['src/server.js', '--smoke'], {
    cwd: repositoryRoot,
    env: { ...process.env, RECALL_REGION: 'us-west-2', MOCK_MODE: 'true', DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /GET \/ handler returned 200/);
  assert.equal(fs.existsSync(databasePath), false);
});
