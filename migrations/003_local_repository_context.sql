ALTER TABLE repositories ADD COLUMN local_path TEXT;
ALTER TABLE repositories ADD COLUMN approved_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approved_files_json));

CREATE TABLE context_ingestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'superseded')),
  commit_version TEXT,
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  tracked_files_json TEXT NOT NULL CHECK (json_valid(tracked_files_json)),
  created_at TEXT NOT NULL,
  approved_at TEXT
) STRICT;

ALTER TABLE context_documents ADD COLUMN ingestion_id TEXT REFERENCES context_ingestions(id) ON DELETE RESTRICT;
ALTER TABLE context_documents ADD COLUMN line_start INTEGER CHECK (line_start IS NULL OR line_start >= 1);
ALTER TABLE context_documents ADD COLUMN line_end INTEGER CHECK (line_end IS NULL OR line_end >= line_start);
ALTER TABLE context_documents ADD COLUMN approved_at TEXT;
ALTER TABLE context_selections ADD COLUMN approved_at TEXT;

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  context_selection_id TEXT REFERENCES context_selections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  provider TEXT NOT NULL CHECK (provider = 'groq'),
  model TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX context_ingestions_project_created_idx ON context_ingestions(project_id, created_at);
CREATE INDEX context_documents_ingestion_idx ON context_documents(ingestion_id);
CREATE INDEX analysis_runs_meeting_created_idx ON analysis_runs(meeting_id, created_at);
