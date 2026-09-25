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

-- 班级/学院/专业别名表：把习惯写法映射到班级库里的规范名（全局生效，人工维护）。
CREATE TABLE IF NOT EXISTS class_aliases (
  alias TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('class', 'college', 'major')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_message_modes (
  group_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('all', 'at_only')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 私信「首次交互推一次主菜单」的去重记录：正式启动入库，dev 启动只记内存。
CREATE TABLE IF NOT EXISTS menu_deliveries (
  user_id TEXT PRIMARY KEY,
  pushed_at TIMESTAMPTZ NOT NULL
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

-- 活动候补名单：名额满了之后按报名顺序排队，有人取消时自动递补第一位。
CREATE TABLE IF NOT EXISTS activity_waitlist (
  activity_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (activity_id, user_id)
);

CREATE INDEX IF NOT EXISTS activity_waitlist_activity_idx
  ON activity_waitlist (activity_id, created_at ASC);

-- 活动扩展设置（键值）：@全体、私信通知发起人、报名截止时间等；
-- 用独立键值表承载新增项，避免对老表做 ALTER（与 group_settings 同一套经验）。
CREATE TABLE IF NOT EXISTS activity_settings (
  activity_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, key)
);

-- 按群订阅「新活动通知」：只推送订阅者
CREATE TABLE IF NOT EXISTS activity_subscriptions (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- 活动通知去重 + 每人每日计数
CREATE TABLE IF NOT EXISTS activity_notifications (
  activity_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- kind: published | changed | cancelled | promoted | full
  -- 满员广播（full）也复用本表去重：user_id 写 group:<群ID> 伪接收者，每个群一次。
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (activity_id, user_id, kind)
);

CREATE INDEX IF NOT EXISTS activity_notifications_user_idx
  ON activity_notifications (user_id, created_at DESC);

-- 活动绑定群（§B4）：一个活动可绑定多个群，发布与满员广播都打到全部绑定群。
-- activities.group_id 仍是「归属群」（创建地 / 权限依据），绑定关系是发布目标集合。
CREATE TABLE IF NOT EXISTS activity_groups (
  activity_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (activity_id, group_id)
);

CREATE INDEX IF NOT EXISTS activity_groups_group_idx
  ON activity_groups (group_id, created_at ASC);
`.trim();
