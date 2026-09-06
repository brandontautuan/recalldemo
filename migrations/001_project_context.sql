CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  terminology_json TEXT NOT NULL CHECK (json_valid(terminology_json)),
  ticket_format_json TEXT NOT NULL CHECK (json_valid(ticket_format_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
) STRICT;

CREATE TABLE context_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  repository_id TEXT REFERENCES repositories(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('project_metadata', 'readme_excerpt', 'repository_metadata', 'work_item_snapshot')),
  title TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  selection_priority INTEGER NOT NULL DEFAULT 0 CHECK (selection_priority >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  external_key TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  selection_priority INTEGER NOT NULL DEFAULT 0 CHECK (selection_priority >= 0),
  labels_json TEXT NOT NULL CHECK (json_valid(labels_json)),
  source_url TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, external_key)
) STRICT;

CREATE TABLE meeting_project_context (
  meeting_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  selected_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_selections (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  analysis_id TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  character_count INTEGER NOT NULL CHECK (character_count >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX repositories_project_id_idx ON repositories(project_id);
CREATE INDEX context_documents_project_active_idx ON context_documents(project_id, is_active, selection_priority, id);
CREATE INDEX work_items_project_status_idx ON work_items(project_id, status, selection_priority, updated_at, id);
CREATE INDEX context_selections_meeting_idx ON context_selections(meeting_id, created_at);
CREATE INDEX context_selections_analysis_idx ON context_selections(analysis_id) WHERE analysis_id IS NOT NULL;
