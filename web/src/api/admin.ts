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

export interface AdminApiPendingItem {
  requestId: string;
  groupId: string;
  userId: string;
  reason: string;
  createdAt: string;
}

export interface AdminApiPage<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface AdminApiAuditRecord {
  recordId: string;
  groupId: string;
  actorId: string;
  action: string;
  status: string;
  reason: string;
  createdAt: string;
}

export interface AdminApiRulesView {
  groupId: string;
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
  groupId: string;
  status: string;
  capacity?: number;
  registered: number;
  createdAt: string;
}

export interface AdminApiActivityResult {
  activityId: string;
  code: string;
  groupId: string;
  status: string;
  message: string;
}

export type AdminApiActivityAction = "open" | "close" | "cancel";

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
