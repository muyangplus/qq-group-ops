export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_records (
  record_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_user_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_records_group_id_idx
  ON audit_records (group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS join_requests (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  reviewer_id TEXT
);

CREATE INDEX IF NOT EXISTS join_requests_group_status_idx
  ON join_requests (group_id, status, created_at);

CREATE TABLE IF NOT EXISTS group_configs (
  group_id TEXT PRIMARY KEY,
  enabled BOOLEAN,
  join_audit_enabled BOOLEAN,
  auto_approve_join BOOLEAN,
  word_filter_enabled BOOLEAN,
  export_enabled BOOLEAN,
  raw_message_retention_days INTEGER,
  mute_duration_seconds INTEGER,
  warning_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_keywords (
  group_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (group_id, keyword)
);

CREATE TABLE IF NOT EXISTS identity_bindings (
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group')),
  official_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, official_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_bindings_kind_external_idx
  ON identity_bindings (kind, external_id);
`.trim();
