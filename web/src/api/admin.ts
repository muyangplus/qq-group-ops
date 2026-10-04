import { api } from "@/api/client";

/**
 * 管理 API 的类型化封装（E2-c）。
 *
 * 形状与 `src/adminApi/server.ts` 的返回体一一对应；页面只调这里的函数，
 * 不直接拼 URL —— 端点变更时改一处即可（守卫测试会检查页面里的端点字符串）。
 */

export interface AdminApiStatus {
  version: string;
  uptimeMs: number;
  database: string;
  migrationIssues: number;
  activeTokens: number;
  sessions: number;
}

/**
 * 管理面里一个实体（人 / 群 / 申请）的展示信息。
 *
 * 口径：**选择与交互优先出绑定号（QQ号 / 群号），其次短码，完整官方长码只在「详情」里出现**。
 * `officialId` 同时也是过滤器/写端点要用的值，所以两样都留着。
 */
export interface AdminApiEntityRef {
  kind: "user" | "group" | "request";
  /** 完整官方 id（openid / group_openid / join_request_id）。 */
  officialId: string;
  /** 展示文本：绑定号 → 短码 → 截断后的官方 id。 */
  label: string;
  /** 绑定号（QQ 号 / 群号）。 */
  externalId?: string;
  /** 短码（含 `#`）。 */
  shortCode?: string;
}

export interface AdminApiPendingItem {
  requestId: string;
  /** 内部群 id（`?group=` 过滤器用它）；展示用 `group`。 */
  groupId: string;
  /** 申请人 openid（写端点用它）；展示用 `applicant`。 */
  userId: string;
  reason: string;
  createdAt: string;
  group: AdminApiEntityRef;
  applicant: AdminApiEntityRef;
  request: AdminApiEntityRef;
}

export interface AdminApiPage<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface AdminApiAuditRecord {
  recordId: string;
  /** 内部群 id；展示用 `group`。 */
  groupId: string;
  /** 操作人 openid；展示用 `actor`。 */
  actorId: string;
  action: string;
  status: string;
  reason: string;
  createdAt: string;
  /** 操作对象 openid（处罚 / 审批的目标）；平台级动作没有。 */
  targetUserId?: string;
  group: AdminApiEntityRef;
  actor: AdminApiEntityRef;
  target?: AdminApiEntityRef;
}

export interface AdminApiRulesView {
  groupId: string;
  /** 群展示信息；全局默认群的 `officialId` 是 `__default__`。 */
  group: AdminApiEntityRef;
  override: Record<string, unknown> | null;
  settings: Array<{ key: string; value: string }>;
  /** 合并全局默认后的生效配置（只读巡检模式不提供）。 */
  effective?: Record<string, unknown>;
}

/** 一次改多项里单条字段的 diff（生效值的 旧值 → 新值）。 */
export interface AdminApiRuleChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface AdminApiRuleUpdateResult {
  groupId: string;
  locale: "global" | "group";
  fields: string[];
  /** 逐字段 diff（单字段也是长度 1）：界面用它做「改了什么」的回执。 */
  changes: AdminApiRuleChange[];
  message: string;
}

/** 覆盖率总览的一行（`GET /api/rules/overrides`，平台超管 240）。 */
export interface AdminApiRuleOverrideItem {
  groupId: string;
  group: AdminApiEntityRef;
  /** 该群显式覆盖的字段（按持久化顺序）。 */
  fields: string[];
  /** 字段展示名（与 `fields` 一一对应）。 */
  labels: string[];
  fieldCount: number;
}

export interface AdminApiRuleOverridesView {
  items: AdminApiRuleOverrideItem[];
  totalGroups: number;
  totalFields: number;
}

export interface AdminApiJoinDecision {
  requestId: string;
  groupId: string;
  status: string;
  message: string;
}

export interface AdminApiActivityItem {
  activityId: string;
  code: string;
  title: string;
  /** 内部群 id；展示用 `group`。 */
  groupId: string;
  status: string;
  capacity?: number;
  registered: number;
  createdAt: string;
  /** 报名截止时间（ISO）；未设置时缺省。 */
  closeAt?: string;
  group: AdminApiEntityRef;
  /** 发布 / 广播目标群；没有任何绑定行时回落到归属群，至少一项。 */
  boundGroups: AdminApiEntityRef[];
}

export interface AdminApiActivityResult {
  activityId: string;
  code: string;
  groupId: string;
  status: string;
  message: string;
}

/** 活动创建 / 绑定 / 解绑的写结果（`activity` 是回读后的最新快照）。 */
export interface AdminApiActivityWriteResult {
  activity: AdminApiActivityItem;
  boundGroups: AdminApiEntityRef[];
  message: string;
}

/** 活动字段目录（`GET /api/activities/fields`）：与指令层 `/activity set` 同一份字段表。 */
export interface AdminApiActivitySettingField {
  /** 规范字段名（提交给后端的就是它）。 */
  field: string;
  label: string;
  kind:
    | "text"
    | "textarea"
    | "number"
    | "link"
    | "datetime"
    | "toggle"
    | "list"
    | "years"
    | "mode";
  /** 指令层也接受的别名（含中文）。 */
  aliases: string[];
  /** 能否用 `clear` 清空 / 复位。 */
  clearable: boolean;
  hint: string;
  /** 改完是否会私信已报名 / 候补者。 */
  notifiesParticipants: boolean;
}

/** 改活动字段的结果（`PUT /api/activities/:code`）。 */
export interface AdminApiActivityUpdateResult {
  activity: AdminApiActivityItem;
  field: string;
  fieldLabel: string;
  before: string;
  after: string;
  message: string;
}

export type AdminApiActivityAction = "open" | "close" | "cancel";

/** 报表：每天一行（含 0 行，时序连续）。 */
export interface AdminApiReportDailyPoint {
  /** 本地日期 `YYYY-MM-DD`。 */
  date: string;
  events: number;
  approvals: number;
  rejections: number;
  expired: number;
  punishments: number;
  registrations: number;
  deliveries: number;
}

export interface AdminApiReportTotals {
  events: number;
  approvals: number;
  rejections: number;
  expired: number;
  punishments: number;
  registrations: number;
  waitlist: number;
  deliveries: number;
  deliveryFailed: number;
  newActivities: number;
  openActivities: number;
}

export interface AdminApiReportGroupRow {
  groupId: string;
  group: AdminApiEntityRef;
  events: number;
  approvals: number;
  rejections: number;
  punishments: number;
  registrations: number;
  deliveries: number;
}

export interface AdminApiReportActivityRow {
  code: string;
  title: string;
  status: string;
  registered: number;
  /** 期间新增报名数（报表核心指标）。 */
  registeredInRange: number;
  waitlist: number;
  capacity?: number;
  full: boolean;
  createdAt: string;
}

/** 统计报表（`GET /api/reports`）：四块口径见 docs/DECISIONS.md 的 ADR-0059。 */
export interface AdminApiReportsView {
  range: { days: number; from: string; to: string };
  group?: AdminApiEntityRef;
  groups: AdminApiReportGroupRow[];
  daily: AdminApiReportDailyPoint[];
  totals: AdminApiReportTotals;
  activities: AdminApiReportActivityRow[];
}

/** 一条身份映射（`GET /api/identities`，只读）。 */
export interface AdminApiIdentityItem {
  /** 内部 ID（openid / group_openid）。 */
  officialId: string;
  /** 展示信息：QQ号 / 群号。 */
  entity: AdminApiEntityRef;
  externalId: string;
  /** 首次绑定 / 最近改绑；老库或纯内存实现没有时缺省。 */
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminApiIdentitiesView {
  users: AdminApiIdentityItem[];
  groups: AdminApiIdentityItem[];
}

/** 权限成员（一条授权指向的人）。 */
export interface AdminApiPermissionMember {
  userId: string;
  user: AdminApiEntityRef;
}

/** 一个角色在某个范围内的成员（全局超管没有群）。 */
export interface AdminApiPermissionRoleList {
  role: string;
  roleLabel: string;
  members: AdminApiPermissionMember[];
}

export interface AdminApiPermissionGroupSummary {
  groupId: string;
  group: AdminApiEntityRef;
}

/** 权限总览（`GET /api/permissions`，平台超管 240）。 */
export interface AdminApiPermissionGrantsView {
  groups: AdminApiPermissionGroupSummary[];
  /** 全局角色（当前只有 `super`）。 */
  global: AdminApiPermissionRoleList[];
  group?: { group: AdminApiEntityRef; roles: AdminApiPermissionRoleList[] };
}

/** 授予 / 撤销的回执（`POST /api/permissions`）。 */
export interface AdminApiPermissionChangeResult {
  action: "grant" | "revoke";
  role: string;
  roleLabel: string;
  group?: AdminApiEntityRef;
  target: AdminApiEntityRef;
  /** 是否真的改动了（重复授予 / 撤销本来就没有的授权 → false）。 */
  changed: boolean;
  /** 改完之后该角色的成员（界面直接替换）。 */
  members: AdminApiPermissionMember[];
  message: string;
}

/** 处罚记录（`/api/punishments`，只读）。 */
export interface AdminApiPunishmentItem {
  recordId: string;
  /** 短码（含 `#`）：指令层说的「处罚短码」。 */
  code: string;
  groupId: string;
  group: AdminApiEntityRef;
  userId: string;
  target: AdminApiEntityRef;
  actorId: string;
  actor: AdminApiEntityRef;
  /** `keyword` / `manual` / `card`。 */
  source: string;
  ruleReason: string;
  /** 触发消息原文；空串 = 未保留原文。 */
  messageExcerpt: string;
  /** 动作摘要（人看的）：`撤回消息 + 禁言 600 秒`。 */
  actions: string;
  detail: string;
  status: "active" | "released";
  createdAt: string;
  updatedAt: string;
}

/** 黑名单条目（`/api/blacklist`，只读）。 */
export interface AdminApiBlacklistEntry {
  scope: "group" | "global";
  groupId: string;
  group?: AdminApiEntityRef;
  userId: string;
  user: AdminApiEntityRef;
  reason: string;
  actorId: string;
  actor: AdminApiEntityRef;
  source: string;
  createdAt: string;
}

export interface AdminApiBlacklistView {
  groupId: string;
  group: AdminApiEntityRef;
  entries: AdminApiBlacklistEntry[];
  globalEntries: AdminApiBlacklistEntry[];
  /** `false` = 没给全局列表（权限不够）。 */
  globalVisible: boolean;
}

/** 申诉记录（`/api/appeals`，只读）。 */
export interface AdminApiAppealItem {
  appealId: string;
  code: string;
  punishmentId: string;
  punishmentCode: string;
  groupId: string;
  group: AdminApiEntityRef;
  userId: string;
  appellant: AdminApiEntityRef;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  reviewerId: string;
  reviewer?: AdminApiEntityRef;
  note: string;
  createdAt: string;
  reviewedAt?: string;
  /** 仅 pending 有意义：还剩多少分钟超时转派（负数 = 已超时）。 */
  holdRemainingMinutes?: number;
  overdue: boolean;
}

export interface AdminApiAppealsView {
  items: AdminApiAppealItem[];
  holdMinutes: number;
  pendingCount: number;
}

/** 申请人资料摘要（`/api/pending` 每项附带；学号默认脱敏）。 */
export interface AdminApiProfileSummary {
  name: string;
  studentId: string;
  className: string;
  college: string;
  year: string;
}

/** 入群申请同步结果（`POST /api/join/sync`）。 */
export interface AdminApiJoinSyncResult {
  groupId: string;
  group: AdminApiEntityRef;
  fetched: number;
  pending: number;
  message: string;
}

/** 通知话题（`/api/notify/topics`）：默认 / 当前门槛与订阅计数。 */
export interface AdminApiNotifyTopic {
  topic: string;
  label: string;
  /** 一句话说明这个话题什么时候推（与机器人卡片同一份文案）。 */
  hint: string;
  /** 全局默认门槛。 */
  defaultLevel: number;
  /** **当前生效**门槛（`/notify level` 改的就是它）。 */
  level: number;
  allScope: number;
  groupScopes: number;
}

/** 改门槛 / 恢复默认的返回：人话摘要 + 全部话题的新状态（界面整体替换）。 */
export interface AdminApiNotifyLevelResult {
  topics: AdminApiNotifyTopic[];
  message: string;
}

export interface AdminApiNotifyTestResult {
  ok: boolean;
  message: string;
}

/** 规则关键词批量增删的结果。 */
export interface AdminApiRuleKeywordsResult {
  /** 改完之后的**完整**关键词表（已 trim、去重、排序）。 */
  keywords: string[];
  added: string[];
  removed: string[];
  /** 被跳过的词与原因（已存在 / 不存在 / 超长 / 空）—— 界面要如实显示。 */
  skipped: Array<{ word: string; reason: string }>;
  message: string;
}

/** 恢复继承（字段级 / 整群）的结果。 */
export interface AdminApiRuleResetResult {
  groupId: string;
  scope: "fields" | "all";
  fields: string[];
  /** 清完之后仍在覆盖的字段（界面据此刷新「覆盖中」标记）。 */
  overriddenFields: string[];
  message: string;
}

/** 别名表条目。 */
export interface AdminApiAliasItem {
  alias: string;
  target: string;
  /** `class` 班级 / `college` 学院 / `major` 专业。 */
  kind: string;
}

export interface AdminApiAliasResult {
  ok: boolean;
  message: string;
  aliases: AdminApiAliasItem[];
}

/** 通知投递记录（`/api/notify/deliveries`，只读）。 */
export interface AdminApiDeliveryItem {
  groupId: string;
  group: AdminApiEntityRef;
  requestId: string;
  userId: string;
  recipient: AdminApiEntityRef;
  status: string;
  detail: string;
  createdAt: string;
}

export interface AdminApiDeliveriesView {
  total: number;
  page: number;
  pageSize: number;
  items: AdminApiDeliveryItem[];
  /** 按状态汇总（一眼看「失败多少」）。 */
  counts: Array<{ status: string; count: number }>;
}

/** 运维只读（`/api/health`）。 */
export interface AdminApiHealthView {
  process: {
    runningVersion: string;
    diskVersion: string;
    uptimeMs: number;
    startedAt: string;
    pid: number;
    node: string;
    platform: string;
    arch: string;
    rss: number;
    heapUsed: number;
    heapTotal: number;
    mode: string;
  };
  database: {
    driver: string;
    migrationIssues: Array<{ step: string; error: string }>;
  };
  queue: { pending: number; failures: number; lastError?: string };
  notify: { subscribers: number; deliveries: number };
  modules: Array<{ key: string; label: string; state: string; error?: string }>;
  restart: {
    failure?: { reason: string; at?: string; code?: number };
    rollback?: { reason: string; at: string };
    brokenBuild: boolean;
  };
  /**
   * 部署状态（ADR-0065）：当前生效版本 + 可回滚版本。
   *
   * 没装配安装器 / 没有上一个包时不带这个字段（页面据此隐藏「回滚到上一版本」按钮）。
   */
  deploy?: AdminApiDeployState;
}

/** 部署状态（`/api/health` 的 `deploy`）：`rollbackVersion` 就是「回滚到上一版本」的目标。 */
export interface AdminApiDeployState {
  /** 当前生效的版本（`data/deploy-state.json` 的 `appliedVersion`）。 */
  appliedVersion: string;
  /** 可回滚到的版本；没有就不带这个字段。 */
  rollbackVersion?: string;
}

/** 回滚回执：`vX → vY` + 人话结果（与机器人 `/status proc` 回执同一份口径）。 */
export interface AdminApiDeployRollbackResult {
  ok: boolean;
  fromVersion: string;
  toVersion: string;
  message: string;
}

/** 订阅关系只读的一行（`GET /api/notify/subscriptions`，平台超管 240）。 */
export interface AdminApiNotifySubscriptionItem {
  userId: string;
  /** 展示口径：QQ号 → 短码 → 截断后的 openid（完整 id 在「详情」）。 */
  user: AdminApiEntityRef;
  topic: string;
  topicLabel: string;
  /** `all` = 「我担任审核员的所有群」；`group` = 某个具体群。 */
  scope: "all" | "group";
  groupId?: string;
  group?: AdminApiEntityRef;
  /** 现在的角色还够不够这个门槛：**订阅了也可能收不到**。 */
  eligible: boolean;
  /** 不够门槛时的人话原因（够的话空串）。 */
  reason: string;
}

export interface AdminApiNotifySubscriptionsView {
  /** 每个话题的订阅计数（与话题表那一列同一口径）。 */
  counts: AdminApiNotifyTopic[];
  total: number;
  page: number;
  pageSize: number;
  items: AdminApiNotifySubscriptionItem[];
}

/** 一枚「未用登录令牌」按成员聚合后的一行（`GET /api/tokens`，平台超管 240）。 */
export interface AdminApiTokenItem {
  userId: string;
  /** 展示口径：QQ号 → 短码 → 截断后的 openid（完整 openid 走「详情」）。 */
  user: AdminApiEntityRef;
  /** 该成员手上还有几张**未用且未过期**的登录令牌。 */
  count: number;
  /** 最早一张的签发时间（ISO）。 */
  createdAt: string;
  /** 最晚一张的到期时间（ISO）。 */
  expiresAt: string;
}

export interface AdminApiTokensView {
  /** 未用且未过期的登录令牌总数（与 `/api/status` 的 `activeTokens` 同口径）。 */
  total: number;
  items: AdminApiTokenItem[];
  /** `.env`（`ADMIN_API_TOKENS`）里的机器令牌：只报 scope 与到期，**不回传密钥**。 */
  machine: Array<{ scopes: string[]; expiresAt?: string }>;
}

/** 吊销未用登录令牌的结果。 */
export interface AdminApiTokenRevokeResult {
  userId: string;
  user: AdminApiEntityRef;
  /** 作废了几张（0 = 本来就没有未用的登录令牌）。 */
  revoked: number;
  message: string;
}

/** 一条定时发言（`GET /api/scheduled-announcements?group=`，本群群管 130）。 */
export interface AdminApiAnnouncementItem {
  id: string;
  /** 内部群 ID（详情行里给完整值，列表用 `group`）。 */
  groupId: string;
  group: AdminApiEntityRef;
  /** cron 原文（标准 5 段，本地时区）。 */
  cron: string;
  /** 解析不了时的原因（正常时缺省）。 */
  cronError?: string;
  enabled: boolean;
  mode: "text" | "card";
  title: string;
  text: string;
  quote?: string;
  buttons: Array<{ label: string; command: string; reply: boolean }>;
  reference: boolean;
  /** 后五次执行时间（`YYYY-MM-DD HH:mm`，本地时区）。 */
  nextTimes: string[];
  lastFiredAt?: string;
  createdBy: AdminApiEntityRef;
  createdAt: string;
  updatedBy?: AdminApiEntityRef;
  updatedAt: string;
}

/** 定时发言列表（外加总开关与每小时上限，页面据此提示）。 */
export interface AdminApiAnnouncementsView {
  items: AdminApiAnnouncementItem[];
  total: number;
  /** 总开关（热配置）：关着时任务照旧保留，但一条都不会触发。 */
  enabled: boolean;
  hourlyLimit: number;
}

/** 定时发言的新建 / 修改入参（只传要改的字段）。 */
export interface AdminApiAnnouncementInput {
  mode?: "text" | "card";
  title?: string;
  text?: string;
  quote?: string;
  reference?: boolean;
  buttons?: Array<{ label: string; command: string; reply?: boolean }>;
}

/** 定时发言写回执（增 / 改 / 启停 / 删 / 试发）。 */
export interface AdminApiAnnouncementResult {
  ok: boolean;
  message: string;
  announcement?: AdminApiAnnouncementItem;
  announcements: AdminApiAnnouncementsView;
}

/** 降级模块「重试加载」的结果（运维写，平台超管 240）。 */
export interface AdminApiModuleRetryResult {  module: { key: string; label: string; state: string; error?: string };
  /** 重试后是否恢复（`state === "ready"`）；仍失败时原因在 `module.error` 与 `message`。 */
  recovered: boolean;
  message: string;
}

/** 处罚动作的结果（与指令层 `/punish …` 同一服务）。 */
export interface AdminApiPunishmentActionResult {
  ok: boolean;
  /** 领域服务给的人话结果（成功摘要或失败原因）。 */
  message: string;
  punishment: AdminApiPunishmentItem;
  /** 拉黑动作：被一并移出的群数（全局拉黑会影响所有绑定群）。 */
  kickedGroups?: number;
  /** 处置即回应申诉：本次连带判定为「已通过」的申诉条数。 */
  acceptedAppeals: number;
}

/** 黑名单增删的结果。 */
export interface AdminApiBlacklistResult {
  action: "add" | "remove";
  ok: boolean;
  message: string;
  scope: "group" | "global";
  groupId: string;
  userId: string;
  /** 被移出的群数（本群 0/1，全局可能多个）。 */
  kickedGroups: number;
}

/** 申诉复核的结果。 */
export interface AdminApiAppealDecisionResult {
  appeal: AdminApiAppealItem;
  decision: "accepted" | "rejected";
  /** 人话摘要：通过时说明对处罚做了什么。 */
  message: string;
}

export type AdminApiPunishmentAction = "release" | "mute" | "kick" | "blacklist";

/** 周期任务监测里的一个任务（`/api/tasks`）。 */
export interface AdminApiTaskItem {
  name: string;
  /** 自己的工作间隔（毫秒）；`0` = 每轮都跑。 */
  minIntervalMs: number;
  /** 启动时那一次是否也跑。 */
  runOnStart: boolean;
  /** 依赖模块是否可用；`false` = 这一轮会被整轮跳过（降级闸门）。 */
  enabled: boolean;
  /** 上次执行时刻（ISO）；从没跑过缺省。 */
  lastRunAt?: string;
  /** 下次最早可能执行的时刻（ISO）；调度器停着时缺省。 */
  nextRunAt?: string;
}

export interface AdminApiTasksView {
  /** 统一扫描周期（毫秒）；`0` = 所有周期任务都停着。 */
  intervalMs: number;
  started: boolean;
  tasks: AdminApiTaskItem[];
  /** 待生效的部署（发现新版本、宽限期内）。 */
  deploy?: {
    targetVersion: string;
    currentVersion: string;
    detectedAt: string;
    deadlineAt: string;
  };
}

/** 一项可热改配置（`/api/settings`）。 */
export interface AdminApiSettingItem {
  key: string;
  envKey: string;
  label: string;
  unit: string;
  value: number | boolean | string;
  /** 给人看的一行（复用 `/config` 的 describe）。 */
  display: string;
  /** `env` = 用 `.env` 默认值；`override` = 已被后台 / `/config` 改过。 */
  source: "env" | "override";
}

/** `.env` 只读项（密钥类不回传值）。 */
export interface AdminApiEnvItem {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  value?: string;
}

export interface AdminApiSettingsView {
  settings: AdminApiSettingItem[];
  env: AdminApiEnvItem[];
  /** 启动加载时发现的问题（坏值 / 未知键）。 */
  issues: string[];
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}

export const adminApi = {
  status: (): Promise<AdminApiStatus> => api.get<AdminApiStatus>("/api/status"),

  /** 周期任务监测（平台超管 240）。 */
  tasks: (): Promise<AdminApiTasksView> =>
    api.get<AdminApiTasksView>("/api/tasks"),

  /** 配置视图（平台超管 240）：可改的热改项 + `.env` 只读项。 */
  settings: (): Promise<AdminApiSettingsView> =>
    api.get<AdminApiSettingsView>("/api/settings"),

  /** 运维只读（平台超管 240）：进程细节 / 模块健康 / 写队列 / 恢复现场。 */
  health: (): Promise<AdminApiHealthView> =>
    api.get<AdminApiHealthView>("/api/health"),

  /**
   * 登录令牌只读（平台超管 240）：谁手上还有**未用**的登录链接（按成员聚合，不含任何哈希）。
   *
   * 机器令牌（`.env`）也在同一份响应里，但只报把数与 scope、不回传密钥。
   */
  tokens: (): Promise<AdminApiTokensView> =>
    api.get<AdminApiTokensView>("/api/tokens"),

  /**
   * 立刻作废某成员手上**全部未用**的登录令牌（平台超管 240）。
   *
   * 用途：`/admin login` 的链接发错了人，不必等 TTL；**已建立的会话不受影响**。
   */
  revokeTokens: (
    user: string,
  ): Promise<{ ok: boolean; result: AdminApiTokenRevokeResult }> =>
    api.post<{ ok: boolean; result: AdminApiTokenRevokeResult }>(
      "/api/tokens/revoke",
      { user },
    ),

  /**
   * 重试加载一个降级模块（平台超管 240；幂等）：与机器人 `/status proc` 的「重试加载」
   * 是同一个领域入口，只重跑该模块的 `load()`，不动数据、不重启进程。
   */
  retryModule: (
    key: string,
  ): Promise<{ ok: boolean; result: AdminApiModuleRetryResult }> =>
    api.post<{ ok: boolean; result: AdminApiModuleRetryResult }>(
      `/api/health/modules/${encodeURIComponent(key)}/retry`,
    ),

  /**
   * 回滚到上一个版本（ADR-0065；平台超管 240）。
   *
   * 与机器人 `/status proc` 卡片上的「回滚上一版」是**同一个安装器**：
   * 重新应用 `data/packages/` 里的上一个包（指纹自证 → 整目录替换 → 重启）。
   * 「没得回滚」不是 HTTP 错误，靠 `result.ok === false` + 原话表达。
   */
  rollbackDeploy: (): Promise<{ ok: boolean; result: AdminApiDeployRollbackResult }> =>
    api.post<{ ok: boolean; result: AdminApiDeployRollbackResult }>(
      "/api/deploy/rollback",
    ),

  /** 处罚记录（只读）：平台超管不传 group 看全量，其余人必须带 group。 */
  punishments: (params: {
    page?: number | undefined;
    pageSize?: number | undefined;
    group?: string | undefined;
    status?: string | undefined;
  } = {}): Promise<AdminApiPage<AdminApiPunishmentItem>> =>
    api.get(`/api/punishments${query(params)}`),

  /** 黑名单（只读）：本群一组 + 全局一组（全局那组只有平台超管拿得到）。 */
  blacklist: (groupId: string): Promise<AdminApiBlacklistView> =>
    api.get<AdminApiBlacklistView>(`/api/blacklist${query({ group: groupId })}`),

  /** 申诉队列（只读）。 */
  appeals: (params: {
    group?: string | undefined;
    status?: string | undefined;
  } = {}): Promise<AdminApiAppealsView> =>
    api.get<AdminApiAppealsView>(`/api/appeals${query(params)}`),

  /** 通知投递记录（只读）。 */
  deliveries: (params: {
    page?: number | undefined;
    pageSize?: number | undefined;
    group?: string | undefined;
    status?: string | undefined;
  } = {}): Promise<AdminApiDeliveriesView> =>
    api.get<AdminApiDeliveriesView>(`/api/notify/deliveries${query(params)}`),

  /** 通知话题（只读）：当前门槛 + 订阅计数 + 说明文案。 */
  notifyTopics: async (): Promise<AdminApiNotifyTopic[]> =>
    // 服务端回的是 `{ topics: [...] }`（与 `/api/aliases` 同一形状），这里拆包给页面用；
    // 以前直接当数组用，页面表格永远是空的。
    (await api.get<{ topics: AdminApiNotifyTopic[] }>("/api/notify/topics"))
      .topics,

  /**
   * 订阅关系只读（平台超管 240）：谁订了哪些话题、订的哪个范围、**现在够不够门槛**。
   *
   * `ineligible` = 只看「订了但当前收不到」的行（订阅后角色掉了 / 活动通知没绑 QQ 号）——
   * 这是「我说了怎么没通知」最直接的答案。
   */
  notifySubscriptions: (
    params: {
      topic?: string | undefined;
      group?: string | undefined;
      user?: string | undefined;
      ineligible?: boolean | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    } = {},
  ): Promise<AdminApiNotifySubscriptionsView> =>
    api.get<AdminApiNotifySubscriptionsView>(
      `/api/notify/subscriptions${query({
        topic: params.topic,
        group: params.group,
        user: params.user,
        ineligible: params.ineligible === true ? 1 : undefined,
        page: params.page,
        pageSize: params.pageSize,
      })}`,
    ),

  /** 改某个话题的门槛（平台超管 240；与 `/notify level` 同一份存储）。 */
  setNotifyLevel: (
    topic: string,
    level: number,
  ): Promise<{ ok: boolean } & AdminApiNotifyLevelResult> =>
    api.put<{ ok: boolean } & AdminApiNotifyLevelResult>("/api/notify/levels", {
      topic,
      level,
    }),

  /** 所有话题门槛恢复默认（平台超管 240）。 */
  resetNotifyLevels: (): Promise<{ ok: boolean } & AdminApiNotifyLevelResult> =>
    api.post<{ ok: boolean } & AdminApiNotifyLevelResult>(
      "/api/notify/levels/reset",
    ),

  /** 规则关键词逐条增删（可批量；单个词失败只进 skipped，不整批失败）。 */
  ruleKeywords: (
    group: string,
    action: "add" | "remove",
    words: string[],
  ): Promise<{ ok: boolean } & AdminApiRuleKeywordsResult> =>
    api.post<{ ok: boolean } & AdminApiRuleKeywordsResult>(
      "/api/rules/keywords",
      { group, action, words },
    ),

  /** 恢复继承：字段级（`fields`）或整群（`resetRuleGroup`）—— 不可逆，界面要二次确认。 */
  resetRuleFields: (
    group: string,
    fields: string[],
  ): Promise<{ ok: boolean } & AdminApiRuleResetResult> =>
    api.post<{ ok: boolean } & AdminApiRuleResetResult>(
      "/api/rules/reset-fields",
      { group, fields },
    ),

  resetRuleGroup: (
    group: string,
  ): Promise<{ ok: boolean } & AdminApiRuleResetResult> =>
    api.post<{ ok: boolean } & AdminApiRuleResetResult>("/api/rules/reset", {
      group,
    }),

  /** 别名表（平台超管 240）。 */
  aliases: (): Promise<{ aliases: AdminApiAliasItem[] }> =>
    api.get<{ aliases: AdminApiAliasItem[] }>("/api/aliases"),

  setAlias: (
    alias: string,
    target: string,
  ): Promise<{ ok: boolean } & AdminApiAliasResult> =>
    api.put<{ ok: boolean } & AdminApiAliasResult>("/api/aliases", {
      alias,
      target,
    }),

  removeAlias: (alias: string): Promise<{ ok: boolean } & AdminApiAliasResult> =>
    api.del<{ ok: boolean } & AdminApiAliasResult>(
      `/api/aliases/${encodeURIComponent(alias)}`,
    ),

  /** 给自己发一张测试卡（自助；测私聊推送通道是否通）。 */
  sendNotifyTest: (
    group?: string,
  ): Promise<{ ok: boolean; result: AdminApiNotifyTestResult }> =>
    api.post("/api/notify/test", group === undefined ? {} : { group }),

  /** 同步官方入群申请队列（写但幂等；本群 120）。 */
  syncJoinRequests: (group: string): Promise<AdminApiJoinSyncResult> =>
    api.post<AdminApiJoinSyncResult>("/api/join/sync", { group }),

  /**
   * 处罚动作（本群 120；`blacklist` 的 `scope=global` 要平台超管）。
   *
   * 与机器人里的 `/punish …` 完全同源：成功后会**连带把该处罚下待处理的申诉标为已通过**，
   * 并按指令层同一条通道发通知。
   */
  punish: (
    code: string,
    action: AdminApiPunishmentAction,
    body: {
      note?: string | undefined;
      seconds?: number | undefined;
      scope?: "group" | "global" | undefined;
      reason?: string | undefined;
    } = {},
  ): Promise<{ ok: boolean; result: AdminApiPunishmentActionResult }> =>
    api.post(
      `/api/punishments/${encodeURIComponent(code)}/${action}`,
      body,
    ),

  /** 加入黑名单（本群 120 / 全局 240；默认同时把人移出群）。 */
  addBlacklist: (body: {
    scope: "group" | "global";
    group?: string | undefined;
    userId: string;
    reason?: string | undefined;
  }): Promise<{ ok: boolean; result: AdminApiBlacklistResult }> =>
    api.post("/api/blacklist", body),

  /** 解除黑名单（本群 120 / 全局 240）。 */
  removeBlacklist: (params: {
    scope: "group" | "global";
    group?: string | undefined;
    userId: string;
  }): Promise<{ ok: boolean; result: AdminApiBlacklistResult }> =>
    api.del(
      `/api/blacklist/${encodeURIComponent(params.userId)}${query({
        scope: params.scope,
        group: params.group,
      })}`,
    ),

  /** 申诉复核（本群 120）：通过 = 撤销该处罚；两种结果都会私信申诉人。 */
  decideAppeal: (
    code: string,
    decision: "accept" | "reject",
    body: { note?: string | undefined } = {},
  ): Promise<{ ok: boolean; result: AdminApiAppealDecisionResult }> =>
    api.post(
      `/api/appeals/${encodeURIComponent(code)}/${decision}`,
      body,
    ),

  /**
   * 审计导出 CSV 的**同源下载地址**（靠 cookie 鉴权，所以直接用 `<a href>`）。
   *
   * `full=1` 不脱敏（要平台 240），默认把 actor / target 的 openid 打码。
   */
  auditExportUrl: (params: {
    group?: string | undefined;
    full?: boolean | undefined;
  } = {}): string =>
    `/api/audit/export.csv${query({
      group: params.group,
      full: params.full === true ? "1" : undefined,
    })}`,

  /** 改一项热改配置（立即生效，写审计）。 */
  updateSetting: (
    key: string,
    value: string | number | boolean,
  ): Promise<{ ok: boolean; setting: AdminApiSettingItem }> =>
    api.put<{ ok: boolean; setting: AdminApiSettingItem }>("/api/settings", {
      key,
      value,
    }),

  /** 把一项热改配置恢复成 `.env` 默认值。 */
  clearSetting: (
    key: string,
  ): Promise<{ ok: boolean; setting: AdminApiSettingItem }> =>
    api.del<{ ok: boolean; setting: AdminApiSettingItem }>(
      `/api/settings/${encodeURIComponent(key)}`,
    ),

  pending: (params: {
    page?: number | undefined;
    pageSize?: number | undefined;
    group?: string | undefined;
  } = {}): Promise<AdminApiPage<AdminApiPendingItem>> =>
    api.get(`/api/pending${query(params)}`),

  approveJoin: (requestId: string): Promise<AdminApiJoinDecision> =>
    api.post<AdminApiJoinDecision>(
      `/api/pending/${encodeURIComponent(requestId)}/approve`,
    ),

  rejectJoin: (
    requestId: string,
    reason: string,
  ): Promise<AdminApiJoinDecision> =>
    api.post<AdminApiJoinDecision>(
      `/api/pending/${encodeURIComponent(requestId)}/reject`,
      { reason },
    ),

  /**
   * 审计查询（只读）：群 / 操作人 / 操作对象 / 动作 / 状态 / 时间范围 + 分页。
   *
   * 操作人与操作对象按「人念得出来的名字」筛：内部 id、绑定的 QQ号、`#短码`、展示名都算命中；
   * 时间用 `YYYY-MM-DD`（本地日，`to` 含当天）或 ISO 时间，坏值服务端回 400。
   */
  audit: (params: {
    page?: number | undefined;
    pageSize?: number | undefined;
    group?: string | undefined;
    actor?: string | undefined;
    target?: string | undefined;
    action?: string | undefined;
    status?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  } = {}): Promise<AdminApiPage<AdminApiAuditRecord>> =>
    api.get(`/api/audit${query(params)}`),

  rules: (groupId: string): Promise<AdminApiRulesView> =>
    api.get<AdminApiRulesView>(`/api/rules${query({ group: groupId })}`),

  updateRule: (
    group: string,
    field: string,
    value: string,
  ): Promise<AdminApiRuleUpdateResult> =>
    api.put<AdminApiRuleUpdateResult>("/api/rules", { group, field, value }),

  /**
   * 一次改多项（平台超管 / 本群群管理员 130）。
   *
   * 服务端**先全部解析、再落库**：任一项不合法整体 400（不写半套）；
   * 回执带逐字段 diff（旧值 → 新值），界面拿它做回执。
   */
  updateRules: (
    group: string,
    updates: Array<{ field: string; value: string }>,
  ): Promise<AdminApiRuleUpdateResult> =>
    api.put<AdminApiRuleUpdateResult>("/api/rules", { group, updates }),

  /** 规则覆盖率总览（平台超管 240）：哪些群覆盖了哪些字段。 */
  ruleOverrides: (): Promise<AdminApiRuleOverridesView> =>
    api.get<AdminApiRuleOverridesView>("/api/rules/overrides"),

  /**
   * 定时发言列表（本群群管 130）：与群里 `/announce` 同一份数据，
   * 每项都带**后五次执行时间**。
   */
  announcements: (groupId: string): Promise<AdminApiAnnouncementsView> =>
    api.get<AdminApiAnnouncementsView>(
      `/api/scheduled-announcements${query({ group: groupId })}`,
    ),

  /** 新建一条定时发言（默认停用；形态 / 正文 / 按钮的校验与指令层同一份）。 */
  createAnnouncement: (
    group: string,
    cron: string,
    content: AdminApiAnnouncementInput,
  ): Promise<AdminApiAnnouncementResult> =>
    api.post<AdminApiAnnouncementResult>("/api/scheduled-announcements", {
      group,
      cron,
      ...content,
    }),

  /** 改一条（只传要改的：`cron` / `enabled` / 内容字段）。 */
  updateAnnouncement: (
    id: string,
    patch: AdminApiAnnouncementInput & { cron?: string; enabled?: boolean },
  ): Promise<AdminApiAnnouncementResult> =>
    api.put<AdminApiAnnouncementResult>(
      `/api/scheduled-announcements/${encodeURIComponent(id)}`,
      patch,
    ),

  /** 删除一条（不可逆；页面要二次确认）。 */
  removeAnnouncement: (id: string): Promise<AdminApiAnnouncementResult> =>
    api.del<AdminApiAnnouncementResult>(
      `/api/scheduled-announcements/${encodeURIComponent(id)}`,
    ),

  /** 立即发一条试试（真实发送，计入每小时上限）。 */
  sendAnnouncement: (id: string): Promise<AdminApiAnnouncementResult> =>
    api.post<AdminApiAnnouncementResult>(
      `/api/scheduled-announcements/${encodeURIComponent(id)}/send`,
    ),

  activities: (params: {
    page?: number | undefined;
    pageSize?: number | undefined;
    group?: string | undefined;
    status?: string | undefined;
  } = {}): Promise<AdminApiPage<AdminApiActivityItem>> =>
    api.get(`/api/activities${query(params)}`),

  setActivityStatus: (
    code: string,
    action: AdminApiActivityAction,
  ): Promise<AdminApiActivityResult> =>
    api.post<AdminApiActivityResult>(
      `/api/activities/${encodeURIComponent(code)}/${action}`,
    ),

  /** 活动字段目录：与指令层 `/activity set` 同一份字段表（登录即可读）。 */
  activitySettingFields: async (): Promise<AdminApiActivitySettingField[]> =>
    (
      await api.get<{ fields: AdminApiActivitySettingField[] }>(
        "/api/activities/fields",
      )
    ).fields,

  /**
   * 改一个活动字段：`field` / `value` 的写法与 `/activity set` 完全一致
   * （所以 `clear` 清空、中文别名、连带通知都照旧）。
   */
  updateActivityField: (
    code: string,
    field: string,
    value: string,
  ): Promise<AdminApiActivityUpdateResult> =>
    api.put<AdminApiActivityUpdateResult>(
      `/api/activities/${encodeURIComponent(code)}`,
      { field, value },
    ),

  /** 新建活动：只建草稿（不广播），并自动绑定创建群。 */
  createActivity: (group: string, title: string): Promise<AdminApiActivityWriteResult> =>
    api.post<AdminApiActivityWriteResult>("/api/activities", { group, title }),

  /** 绑定发布群；重复绑定是幂等空操作（消息会说明已绑过）。 */
  bindActivityGroup: (
    code: string,
    group: string,
  ): Promise<AdminApiActivityWriteResult> =>
    api.post<AdminApiActivityWriteResult>(
      `/api/activities/${encodeURIComponent(code)}/groups`,
      { group },
    ),

  /** 解绑发布群；解到没有任何绑定行时会回落到归属群。 */
  unbindActivityGroup: (
    code: string,
    group: string,
  ): Promise<AdminApiActivityWriteResult> =>
    api.del<AdminApiActivityWriteResult>(
      `/api/activities/${encodeURIComponent(code)}/groups/${encodeURIComponent(group)}`,
    ),

  /** 统计报表（E5）：平台超管不传 `group` 看全量，其余人必须带自己 ≥130 的群。 */
  reports: (params: {
    group?: string | undefined;
    days?: number | undefined;
  } = {}): Promise<AdminApiReportsView> =>
    api.get<AdminApiReportsView>(`/api/reports${query(params)}`),

  /**
   * 报表 CSV 是**下载**：同源链接直接带会话 cookie。
   * 默认脱敏（群只出展示标签）；`full=1` 会多一列内部群 ID，只有平台超管能下。
   */
  reportsExportUrl: (params: {
    group?: string | undefined;
    days?: number | undefined;
    full?: boolean | undefined;
  } = {}): string =>
    `/api/reports/export.csv${query({
      group: params.group,
      days: params.days,
      full: params.full === true ? "1" : undefined,
    })}`,

  /** 权限总览（平台超管 240）：全局超管 + 选定群的三个群内角色。 */
  permissions: (params: { group?: string | undefined } = {}): Promise<AdminApiPermissionGrantsView> =>
    api.get<AdminApiPermissionGrantsView>(`/api/permissions${query(params)}`),

  /** 身份映射只读（平台超管 240）：群号 ↔ 群 ID、QQ号 ↔ openid。 */
  identities: (): Promise<AdminApiIdentitiesView> =>
    api.get<AdminApiIdentitiesView>("/api/identities"),

  /** 授予 / 撤销角色（平台超管 240）：与指令层 `/perm` 同一个服务。 */
  setPermission: (input: {
    action: "grant" | "revoke";
    role: string;
    group?: string | undefined;
    userId: string;
  }): Promise<{ ok: boolean } & AdminApiPermissionChangeResult> =>
    api.post<{ ok: boolean } & AdminApiPermissionChangeResult>(
      "/api/permissions",
      input,
    ),
};
