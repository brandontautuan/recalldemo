ALTER TABLE context_documents ADD COLUMN is_truncated INTEGER NOT NULL DEFAULT 0 CHECK (is_truncated IN (0, 1));
