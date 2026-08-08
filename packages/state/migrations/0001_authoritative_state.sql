-- PostgreSQL/SQLite-compatible authoritative metadata schema.
-- JSON values are stored as text so both adapters exercise the same repository contract.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS workspaces (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, workspace_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)
);

CREATE TABLE IF NOT EXISTS commands (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, command_id)
);

CREATE TABLE IF NOT EXISTS command_deduplication (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  command_id TEXT NOT NULL,
  result_json TEXT,
  reserved_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workflows (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  workflow_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, workflow_id)
);

CREATE TABLE IF NOT EXISTS workflow_plans (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  plan_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, workflow_id, plan_version)
);

CREATE TABLE IF NOT EXISTS invocations (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  invocation_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, invocation_id)
);

CREATE TABLE IF NOT EXISTS invocation_attempts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  attempt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, invocation_id, attempt)
);

CREATE TABLE IF NOT EXISTS agent_reports (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, report_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  current_version INTEGER NOT NULL CHECK (current_version >= 0),
  logical_state TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, artifact_id)
);

-- Content bytes live in object storage. These rows are the tenant-scoped CAS
-- metadata and make staged-object cleanup/reconciliation observable.
CREATE TABLE IF NOT EXISTS artifact_content_objects (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  retention_until TEXT,
  PRIMARY KEY (tenant_id, workspace_id, content_hash),
  UNIQUE (tenant_id, workspace_id, object_key)
);

CREATE TABLE IF NOT EXISTS artifact_staged_uploads (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  staged_upload_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (tenant_id, workspace_id, staged_upload_id)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  creator_json TEXT NOT NULL,
  invocation_id TEXT,
  state TEXT NOT NULL,
  schema_name TEXT,
  retention_until TEXT,
  published_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, artifact_id, version),
  FOREIGN KEY (tenant_id, workspace_id, content_hash)
    REFERENCES artifact_content_objects (tenant_id, workspace_id, content_hash)
);

-- Lifecycle status is mutable metadata about an immutable publication row. Keeping it in a
-- separate table lets stale/superseded transitions be recorded without mutating artifact_versions.
CREATE TABLE IF NOT EXISTS artifact_version_states (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, artifact_id, version),
  FOREIGN KEY (tenant_id, workspace_id, artifact_id, version)
    REFERENCES artifact_versions (tenant_id, workspace_id, artifact_id, version)
);

CREATE TABLE IF NOT EXISTS artifact_lineage_edges (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_artifact_id TEXT NOT NULL,
  parent_version INTEGER NOT NULL CHECK (parent_version >= 1),
  child_artifact_id TEXT NOT NULL,
  child_version INTEGER NOT NULL CHECK (child_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, parent_artifact_id, parent_version, child_artifact_id, child_version),
  FOREIGN KEY (tenant_id, workspace_id, parent_artifact_id, parent_version)
    REFERENCES artifact_versions (tenant_id, workspace_id, artifact_id, version),
  FOREIGN KEY (tenant_id, workspace_id, child_artifact_id, child_version)
    REFERENCES artifact_versions (tenant_id, workspace_id, artifact_id, version)
);

CREATE TABLE IF NOT EXISTS approvals (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  approval_json TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, approval_id),
  UNIQUE (tenant_id, workspace_id, action_digest)
);

CREATE TABLE IF NOT EXISTS budgets (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  budget_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, budget_id)
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  reservation_json TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, reservation_id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  usage_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, usage_id)
);

CREATE TABLE IF NOT EXISTS agent_registrations (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  registration_json TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS domain_events (
  stream_sequence INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
  event_name TEXT NOT NULL,
  event_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (tenant_id, workspace_id, event_id),
  UNIQUE (tenant_id, workspace_id, aggregate_type, aggregate_id, aggregate_version)
);

CREATE TABLE IF NOT EXISTS transactional_outbox (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  event_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_by TEXT,
  claim_expires_at TEXT,
  PRIMARY KEY (tenant_id, workspace_id, outbox_id),
  UNIQUE (tenant_id, workspace_id, event_id)
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_name TEXT NOT NULL,
  stream_sequence INTEGER NOT NULL CHECK (stream_sequence >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, projection_name)
);

CREATE TABLE IF NOT EXISTS side_effect_receipts (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, receipt_id),
  UNIQUE (tenant_id, workspace_id, effect_key)
);

CREATE TABLE IF NOT EXISTS audit_records (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  event_id TEXT,
  actor_json TEXT NOT NULL,
  action TEXT NOT NULL,
  target_json TEXT NOT NULL,
  result TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, audit_id)
);
