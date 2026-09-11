/** SQLite persistence for reviewed project context, immutable selections, and migration integrity. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './context-seed.js';

const defaultMigrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
const migrationPattern = /^(\d+)_([a-z0-9_]+)\.sql$/;
const checksum = (content) => crypto.createHash('sha256').update(content).digest('hex');

export class ContextSelectionIntegrityError extends Error {
  constructor(id) {
    super(`Context selection ${id} failed its integrity check.`);
    this.name = 'ContextSelectionIntegrityError';
  }
}

const readMigrations = (directory) => {
  const migrations = fs.readdirSync(directory)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = filename.match(migrationPattern);
      if (!match) throw new Error(`Invalid migration filename: ${filename}`);
      const content = fs.readFileSync(path.join(directory, filename), 'utf8');
      if (!content.trim()) throw new Error(`Migration is empty: ${filename}`);
      return { version: Number(match[1]), name: match[2], filename, content, checksum: checksum(content) };
    })
    .sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));
  const versions = new Set();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) throw new Error(`Invalid migration version: ${migration.filename}`);
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
};

export class ProjectContextStore {
  constructor(databasePath, { migrationsDirectory = defaultMigrationsDirectory } = {}) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) throw new Error('DATABASE_PATH must be a non-empty path.');
    this.databasePath = databasePath === ':memory:' ? databasePath : path.resolve(databasePath);
    this.migrationsDirectory = migrationsDirectory;
    if (this.databasePath !== ':memory:') fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  // Checksums make edited historical migrations fail loudly instead of silently changing an existing database's model.
  migrate() {
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;`);
    const applied = new Map(this.database.prepare('SELECT version, name, checksum FROM schema_migrations').all().map((row) => [row.version, row]));
    const migrations = readMigrations(this.migrationsDirectory);
    const newlyApplied = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.version} does not match ${migration.filename}.`);
        }
        continue;
      }
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        this.database.exec(migration.content);
        this.database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
        this.database.exec('COMMIT;');
        newlyApplied.push(migration.version);
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw new Error(`Migration ${migration.filename} failed: ${error.message}`, { cause: error });
      }
    }
    return newlyApplied;
  }

  schemaVersion() {
    const row = this.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    return row?.version ?? 0;
  }

  ingestSeed(manifest, { dryRun = false } = {}) {
    const summary = Object.fromEntries(['projects', 'repositories', 'documents', 'workItems'].map((resource) => [resource, { inserted: 0, updated: 0, unchanged: 0 }]));
    const projectSelect = this.database.prepare('SELECT * FROM projects WHERE id = ?');
    const repositorySelect = this.database.prepare('SELECT * FROM repositories WHERE id = ?');
    const documentSelect = this.database.prepare('SELECT * FROM context_documents WHERE id = ?');
    const workItemSelect = this.database.prepare('SELECT * FROM work_items WHERE id = ?');
    const count = (resource, action) => { summary[resource][action] += 1; };
    const changed = (existing, values) => Object.entries(values).some(([field, value]) => existing[field] !== value);
    const requireNewer = (label, incoming, existing) => {
      if (incoming < existing) throw new Error(`${label} is older than the stored record.`);
      if (incoming === existing) throw new Error(`${label} changed without a newer updatedAt timestamp.`);
    };

    this.database.exec('BEGIN IMMEDIATE;');
    try {
      for (const project of manifest.projects) {
        const projectValues = {
          slug: project.slug, name: project.name, description: project.description,
          terminology_json: canonicalJson(project.terminology), ticket_format_json: canonicalJson(project.ticketFormat),
          is_active: project.isActive ? 1 : 0,
          created_at: project.createdAt, updated_at: project.updatedAt,
        };
        const existingProject = projectSelect.get(project.id);
        if (!existingProject) {
          this.database.prepare('INSERT INTO projects (id, slug, name, description, terminology_json, ticket_format_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(project.id, ...Object.values(projectValues));
          count('projects', 'inserted');
        } else if (!changed(existingProject, projectValues)) count('projects', 'unchanged');
        else {
          if (existingProject.created_at !== project.createdAt) throw new Error(`Project ${project.id} cannot change createdAt.`);
          requireNewer(`Project ${project.id}`, project.updatedAt, existingProject.updated_at);
          this.database.prepare('UPDATE projects SET slug = ?, name = ?, description = ?, terminology_json = ?, ticket_format_json = ?, is_active = ?, updated_at = ? WHERE id = ?')
            .run(project.slug, project.name, project.description, projectValues.terminology_json, projectValues.ticket_format_json, project.isActive ? 1 : 0, project.updatedAt, project.id);
          count('projects', 'updated');
        }

        for (const repository of project.repositories) {
          const values = {
            project_id: project.id, name: repository.name, remote_url: repository.remoteUrl, default_branch: repository.defaultBranch,
            metadata_json: canonicalJson(repository.metadata), created_at: repository.createdAt, updated_at: repository.updatedAt,
          };
          const existing = repositorySelect.get(repository.id);
          if (!existing) {
            this.database.prepare('INSERT INTO repositories (id, project_id, name, remote_url, default_branch, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(repository.id, ...Object.values(values));
            count('repositories', 'inserted');
          } else if (!changed(existing, values)) count('repositories', 'unchanged');
          else {
            if (existing.created_at !== repository.createdAt) throw new Error(`Repository ${repository.id} cannot change createdAt.`);
            requireNewer(`Repository ${repository.id}`, repository.updatedAt, existing.updated_at);
            this.database.prepare('UPDATE repositories SET project_id = ?, name = ?, remote_url = ?, default_branch = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
              .run(project.id, repository.name, repository.remoteUrl, repository.defaultBranch, values.metadata_json, repository.updatedAt, repository.id);
            count('repositories', 'updated');
          }
        }

        for (const document of project.documents) {
          const contentSha256 = checksum(document.content);
          const values = {
            project_id: project.id, repository_id: document.repositoryId, kind: document.kind, title: document.title,
            source_path: document.sourcePath, content: document.content, content_sha256: contentSha256, revision: document.revision,
            selection_priority: document.selectionPriority, is_active: document.isActive ? 1 : 0,
            created_at: document.createdAt, updated_at: document.updatedAt,
          };
          const existing = documentSelect.get(document.id);
          if (!existing) {
            this.database.prepare('INSERT INTO context_documents (id, project_id, repository_id, kind, title, source_path, content, content_sha256, revision, selection_priority, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(document.id, ...Object.values(values));
            count('documents', 'inserted');
          } else if (!changed(existing, values)) count('documents', 'unchanged');
          else {
            if (existing.created_at !== document.createdAt) throw new Error(`Document ${document.id} cannot change createdAt.`);
            if (document.revision <= existing.revision) throw new Error(`Document ${document.id} changed without a higher revision.`);
            this.database.prepare('UPDATE context_documents SET project_id = ?, repository_id = ?, kind = ?, title = ?, source_path = ?, content = ?, content_sha256 = ?, revision = ?, selection_priority = ?, is_active = ?, updated_at = ? WHERE id = ?')
              .run(project.id, document.repositoryId, document.kind, document.title, document.sourcePath, document.content, contentSha256, document.revision, document.selectionPriority, document.isActive ? 1 : 0, document.updatedAt, document.id);
            count('documents', 'updated');
          }
        }

        for (const workItem of project.workItems) {
          const values = {
            project_id: project.id, external_key: workItem.externalKey, title: workItem.title, description: workItem.description,
            status: workItem.status, priority: workItem.priority, selection_priority: workItem.selectionPriority,
            labels_json: canonicalJson(workItem.labels), source_url: workItem.sourceUrl, updated_at: workItem.updatedAt,
          };
          const existing = workItemSelect.get(workItem.id);
          if (!existing) {
            this.database.prepare('INSERT INTO work_items (id, project_id, external_key, title, description, status, priority, selection_priority, labels_json, source_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(workItem.id, ...Object.values(values));
            count('workItems', 'inserted');
          } else if (!changed(existing, values)) count('workItems', 'unchanged');
          else {
            requireNewer(`Work item ${workItem.id}`, workItem.updatedAt, existing.updated_at);
            this.database.prepare('UPDATE work_items SET project_id = ?, external_key = ?, title = ?, description = ?, status = ?, priority = ?, selection_priority = ?, labels_json = ?, source_url = ?, updated_at = ? WHERE id = ?')
              .run(project.id, workItem.externalKey, workItem.title, workItem.description, workItem.status, workItem.priority, workItem.selectionPriority, values.labels_json, workItem.sourceUrl, workItem.updatedAt, workItem.id);
            count('workItems', 'updated');
          }
        }
      }
      this.database.exec(dryRun ? 'ROLLBACK;' : 'COMMIT;');
      return summary;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  listProjects() {
    return this.database.prepare('SELECT id, slug, name, description, updated_at AS updatedAt FROM projects WHERE is_active = 1 ORDER BY name, id').all().map((project) => ({
      ...project,
      localRepositories: this.database.prepare('SELECT id, name, approved_files_json AS approvedFilesJson FROM repositories WHERE project_id = ? AND local_path IS NOT NULL ORDER BY id').all(project.id)
        .map(({ approvedFilesJson, ...repository }) => {
          const latest = this.database.prepare('SELECT id, status, commit_version AS commitVersion, source_fingerprint AS sourceFingerprint, created_at AS createdAt, approved_at AS approvedAt FROM context_ingestions WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1').get(repository.id) ?? null;
          return { ...repository, configured: true, approvedFiles: JSON.parse(approvedFilesJson), latestIngestion: latest };
        }),
    }));
  }

  localRepositoriesRequireApproval(projectId) {
    const repositories = this.database.prepare('SELECT id FROM repositories WHERE project_id = ? AND local_path IS NOT NULL').all(projectId);
    return repositories.some((repository) => !this.database.prepare("SELECT 1 FROM context_ingestions WHERE repository_id = ? AND status = 'approved'").get(repository.id));
  }

  approvedContextIngestion(repositoryId) {
    const row = this.database.prepare("SELECT id FROM context_ingestions WHERE repository_id = ? AND status = 'approved' ORDER BY approved_at DESC LIMIT 1").get(repositoryId);
    return row ? this.getContextIngestion(row.id) : null;
  }

  createLocalProject({ slug, name, description, repositoryPath, approvedFiles }) {
    const projectId = `project-${slug}`;
    const repositoryId = `repo-${slug}`;
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare('INSERT INTO projects (id, slug, name, description, terminology_json, ticket_format_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(projectId, slug, name, description, '{}', JSON.stringify({ requiredSections: ['Summary', 'Acceptance criteria', 'Evidence'] }), now, now);
      this.database.prepare('INSERT INTO repositories (id, project_id, name, remote_url, default_branch, metadata_json, created_at, updated_at, local_path, approved_files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(repositoryId, projectId, slug, 'https://local.invalid/not-configured', 'unknown', JSON.stringify({ source: 'approved_local_repository' }), now, now, repositoryPath, JSON.stringify(approvedFiles));
      this.database.exec('COMMIT;');
      return this.getProject(projectId);
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  getProject(id) {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id, slug: row.slug, name: row.name, description: row.description,
      terminology: JSON.parse(row.terminology_json), ticketFormat: JSON.parse(row.ticket_format_json),
      isActive: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getProjectBundle(projectId) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const repositories = this.database.prepare('SELECT * FROM repositories WHERE project_id = ? ORDER BY id').all(projectId).map((row) => ({
      id: row.id, projectId: row.project_id, name: row.name, remoteUrl: row.remote_url, defaultBranch: row.default_branch,
      metadata: JSON.parse(row.metadata_json), localPath: row.local_path, approvedFiles: JSON.parse(row.approved_files_json), createdAt: row.created_at, updatedAt: row.updated_at,
    }));
    const documents = this.database.prepare('SELECT * FROM context_documents WHERE project_id = ? ORDER BY selection_priority, id').all(projectId).map((row) => ({
      id: row.id, projectId: row.project_id, repositoryId: row.repository_id, kind: row.kind, title: row.title,
      sourcePath: row.source_path, content: row.content, contentSha256: row.content_sha256, revision: row.revision,
      selectionPriority: row.selection_priority, isActive: Boolean(row.is_active), ingestionId: row.ingestion_id,
      lineStart: row.line_start, lineEnd: row.line_end, truncated: Boolean(row.is_truncated), approvedAt: row.approved_at, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
    const workItems = this.database.prepare('SELECT * FROM work_items WHERE project_id = ? ORDER BY selection_priority, updated_at DESC, id').all(projectId).map((row) => ({
      id: row.id, projectId: row.project_id, externalKey: row.external_key, title: row.title, description: row.description,
      status: row.status, priority: row.priority, selectionPriority: row.selection_priority, labels: JSON.parse(row.labels_json),
      sourceUrl: row.source_url, updatedAt: row.updated_at,
    }));
    return { project, repositories, documents, workItems };
  }

  projectInventory(projectId) {
    const bundle = this.getProjectBundle(projectId);
    if (!bundle) return null;
    return {
      project: bundle.project,
      sources: [
        ...bundle.repositories.map((repository) => ({ id: `repository:${repository.id}`, kind: 'repository_metadata', label: repository.name, revision: repository.updatedAt, active: true })),
        ...bundle.documents.map((document) => ({ id: `document:${document.id}`, kind: document.kind, label: document.title, revision: document.revision, active: document.isActive, sourcePath: document.sourcePath })),
        ...bundle.workItems.map((workItem) => ({ id: `work-item:${workItem.id}`, kind: 'work_item_snapshot', label: workItem.externalKey ? `${workItem.externalKey}: ${workItem.title}` : workItem.title, revision: workItem.updatedAt, active: !['cancelled', 'canceled', 'closed', 'done', 'resolved'].includes(workItem.status) })),
      ],
    };
  }

  saveContextSelection({ meetingId, projectId, selection, contentSha256, createdAt = new Date().toISOString() }) {
    const id = crypto.randomUUID();
    const selectionJson = canonicalJson(selection);
    if (selection.project?.id !== projectId) throw new Error('Context selection project does not match the requested project.');
    if (checksum(selectionJson) !== contentSha256) throw new Error('Context selection hash does not match its snapshot.');
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`INSERT INTO meeting_project_context (meeting_id, project_id, selected_at) VALUES (?, ?, ?)
        ON CONFLICT(meeting_id) DO UPDATE SET project_id = excluded.project_id, selected_at = excluded.selected_at`)
        .run(meetingId, projectId, createdAt);
      this.database.prepare('INSERT INTO context_selections (id, meeting_id, analysis_id, project_id, selection_json, content_sha256, character_count, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
        .run(id, meetingId, projectId, selectionJson, contentSha256, selection.characterCount, createdAt);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
    return { ...selection, id, meetingId, analysisId: null, projectId, contentSha256, createdAt, approvedAt: null };
  }

  getContextSelection(id) {
    const row = this.database.prepare('SELECT * FROM context_selections WHERE id = ?').get(id);
    if (!row) return null;
    const selection = JSON.parse(row.selection_json);
    if (checksum(canonicalJson(selection)) !== row.content_sha256
      || selection.project?.id !== row.project_id
      || selection.characterCount !== row.character_count) throw new ContextSelectionIntegrityError(id);
    return { ...selection, id: row.id, meetingId: row.meeting_id, analysisId: row.analysis_id, projectId: row.project_id, contentSha256: row.content_sha256, createdAt: row.created_at, approvedAt: row.approved_at };
  }

  approveContextSelection(id, meetingId) {
    const approvedAt = new Date().toISOString();
    const update = this.database.prepare('UPDATE context_selections SET approved_at = ? WHERE id = ? AND meeting_id = ? AND approved_at IS NULL AND analysis_id IS NULL')
      .run(approvedAt, id, meetingId);
    return Number(update.changes) === 1 ? this.getContextSelection(id) : null;
  }

  contextSelectionUsesCurrentIngestions(selection) {
    return selection.sources.every((source) => {
      if (!source.ingestionId) return true;
      return Boolean(this.database.prepare("SELECT 1 FROM context_ingestions WHERE id = ? AND status = 'approved'").get(source.ingestionId));
    });
  }

  linkContextSelectionToAnalysis(id, analysisId) {
    const update = this.database.prepare('UPDATE context_selections SET analysis_id = ? WHERE id = ? AND analysis_id IS NULL AND approved_at IS NOT NULL').run(analysisId, id);
    if (Number(update.changes) !== 1) return false;
    return true;
  }

  releaseContextSelectionFromAnalysis(id, analysisId) {
    // A failed provider run creates no reviewable artifact, so retain the approved snapshot for an explicit retry.
    const update = this.database.prepare('UPDATE context_selections SET analysis_id = NULL WHERE id = ? AND analysis_id = ?').run(id, analysisId);
    return Number(update.changes) === 1;
  }


  stageRepositoryIngestion({ projectId, repositoryId, scan }) {
    const existing = this.database.prepare("SELECT id FROM context_ingestions WHERE project_id = ? AND repository_id = ? AND source_fingerprint = ? AND status IN ('pending_review', 'approved') ORDER BY created_at DESC LIMIT 1")
      .get(projectId, repositoryId, scan.sourceFingerprint);
    if (existing) return this.getContextIngestion(existing.id);
    const id = crypto.randomUUID();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare('INSERT INTO context_ingestions (id, project_id, repository_id, status, commit_version, source_fingerprint, tracked_files_json, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(id, projectId, repositoryId, 'pending_review', scan.commitVersion, scan.sourceFingerprint, JSON.stringify(scan.trackedFiles), scan.scannedAt);
      const insert = this.database.prepare('INSERT INTO context_documents (id, project_id, repository_id, kind, title, source_path, content, content_sha256, revision, selection_priority, is_active, created_at, updated_at, ingestion_id, line_start, line_end, approved_at, is_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, NULL, ?)');
      scan.documents.forEach((document, index) => insert.run(crypto.randomUUID(), projectId, repositoryId, document.kind, document.title, document.sourcePath, document.content, document.contentSha256, 100 + index, scan.scannedAt, scan.scannedAt, id, document.lineStart, document.lineEnd, document.truncated ? 1 : 0));
      this.database.exec('COMMIT;');
      return this.getContextIngestion(id);
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  getContextIngestion(id) {
    const row = this.database.prepare('SELECT * FROM context_ingestions WHERE id = ?').get(id);
    if (!row) return null;
    const documents = this.database.prepare('SELECT id, kind, title, source_path AS sourcePath, content, content_sha256 AS contentSha256, line_start AS lineStart, line_end AS lineEnd, is_truncated AS isTruncated FROM context_documents WHERE ingestion_id = ? ORDER BY selection_priority, id').all(id)
      .map(({ isTruncated, ...document }) => ({ ...document, truncated: Boolean(isTruncated) }));
    return { id: row.id, projectId: row.project_id, repositoryId: row.repository_id, status: row.status, commitVersion: row.commit_version, sourceFingerprint: row.source_fingerprint, trackedFiles: JSON.parse(row.tracked_files_json), createdAt: row.created_at, approvedAt: row.approved_at, documents };
  }

  approveContextIngestion(id, projectId) {
    const ingestion = this.getContextIngestion(id);
    if (!ingestion || ingestion.projectId !== projectId || ingestion.status !== 'pending_review') return null;
    const approvedAt = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare("UPDATE context_ingestions SET status = 'superseded' WHERE project_id = ? AND repository_id = ? AND status = 'approved'").run(projectId, ingestion.repositoryId);
      this.database.prepare('UPDATE context_documents SET is_active = 0 WHERE project_id = ? AND repository_id = ? AND ingestion_id IS NOT NULL').run(projectId, ingestion.repositoryId);
      this.database.prepare("UPDATE context_ingestions SET status = 'approved', approved_at = ? WHERE id = ?").run(approvedAt, id);
      this.database.prepare('UPDATE context_documents SET is_active = 1, approved_at = ? WHERE ingestion_id = ?').run(approvedAt, id);
      const repository = this.database.prepare('SELECT metadata_json FROM repositories WHERE id = ?').get(ingestion.repositoryId);
      this.database.prepare('UPDATE repositories SET metadata_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...JSON.parse(repository.metadata_json), commitVersion: ingestion.commitVersion, trackedFiles: ingestion.trackedFiles }), approvedAt, ingestion.repositoryId);
      this.database.exec('COMMIT;');
      return this.getContextIngestion(id);
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  beginAnalysisRun({ id, meetingId, projectId = null, contextSelectionId = null }) {
    this.database.prepare("INSERT INTO analysis_runs (id, meeting_id, project_id, context_selection_id, status, provider, created_at) VALUES (?, ?, ?, ?, 'running', 'groq', ?)")
      .run(id, meetingId, projectId, contextSelectionId, new Date().toISOString());
  }

  finishAnalysisRun(id, { status, model = null, errorCode = null }) {
    this.database.prepare('UPDATE analysis_runs SET status = ?, model = ?, error_code = ?, completed_at = ? WHERE id = ?')
      .run(status, model, errorCode, new Date().toISOString(), id);
  }

  close() {
    this.database.close();
  }
}
