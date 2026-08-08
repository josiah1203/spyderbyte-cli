-- Durable product project aggregate metadata. The append-only event stream remains the
-- projection source, while this row provides an authoritative point read for commands.
CREATE TABLE IF NOT EXISTS projects (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  project_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, project_id)
);
