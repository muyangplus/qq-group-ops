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
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  join_audit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  auto_approve_join BOOLEAN NOT NULL DEFAULT FALSE,
  word_filter_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  export_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  raw_message_retention_days INTEGER NOT NULL DEFAULT 0,
  mute_duration_seconds INTEGER NOT NULL DEFAULT 600,
  warning_message TEXT NOT NULL DEFAULT '请遵守群规，不要发送违规内容。',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_keywords (
  group_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (group_id, keyword)
);
`.trim();
