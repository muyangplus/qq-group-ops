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
  group: AdminApiEntityRef;
}

export interface AdminApiActivityResult {
  activityId: string;
  code: string;
  groupId: string;
  status: string;
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

  /** 同步官方入群申请队列（写但幂等；本群 120）。 */
  syncJoinRequests: (group: string): Promise<AdminApiJoinSyncResult> =>
    api.post<AdminApiJoinSyncResult>("/api/join/sync", { group }),

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
};
