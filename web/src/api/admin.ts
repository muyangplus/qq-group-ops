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

export interface AdminApiRuleUpdateResult {
  groupId: string;
  locale: "global" | "group";
  fields: string[];
  message: string;
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

  audit: (params: {
    page?: number | undefined;
    pageSize?: number | undefined;
    group?: string | undefined;
    actor?: string | undefined;
    action?: string | undefined;
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
};
