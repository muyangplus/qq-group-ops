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
