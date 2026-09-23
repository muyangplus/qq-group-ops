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

CREATE TABLE IF NOT EXISTS group_settings (
  group_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, setting_key)
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

CREATE TABLE IF NOT EXISTS permission_grants (
  scope TEXT NOT NULL CHECK (scope IN ('super_admin', 'group_admin', 'moderator')),
  group_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, group_id, user_id)
);

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  group_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (group_id, request_id, user_id)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_created_idx
  ON notification_deliveries (created_at);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  student_id TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  college TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS short_codes (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'join_request')),
  target_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (kind, target_id)
);

CREATE TABLE IF NOT EXISTS group_message_modes (
  group_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('all', 'at_only')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activities (
  activity_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  capacity INTEGER,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS activities_group_id_idx
  ON activities (group_id, created_at ASC);

CREATE TABLE IF NOT EXISTS activity_registrations (
  registration_id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities (activity_id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (activity_id, user_id)
);

CREATE INDEX IF NOT EXISTS activity_registrations_activity_idx
  ON activity_registrations (activity_id, created_at ASC);

CREATE TABLE IF NOT EXISTS activity_details (
  activity_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  group_number TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  allow_colleges TEXT NOT NULL DEFAULT '[]',
  deny_colleges TEXT NOT NULL DEFAULT '[]',
  allow_years TEXT NOT NULL DEFAULT '[]',
  deny_years TEXT NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`.trim();
