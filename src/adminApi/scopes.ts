/**
 * 管理 API 机器令牌的 scope 表（E1-e 扩展）。
 *
 * 三档通配 + 按域细分：
 * - `*` = 全部；`read` / `write` = 该族的全部端点（**老 token 行为不变**）；
 * - `read:<域>` / `write:<域>` = 只给这一块：例如 CI 只查待审批就给 `read:join`，
 *   只发通知就给 `write:notify`。
 *
 * 每个端点在这里显式声明自己的域：**没登记的端点回落到粗粒度 `read` / `write`**，
 * 于是「新加端点忘了登记」的表现是「细粒度 token 访问不了」而不是「意外放行」——
 * 失败方向是关的（fail-closed），要放开就得显式登记或给粗粒度 scope。
 */

/** 域标识（scope 里冒号后的部分）。 */
export type AdminApiScopeDomain =
  | "join"
  | "audit"
  | "punish"
  | "blacklist"
  | "appeal"
  | "rule"
  | "notify"
  | "activity"
  | "alias"
  | "settings"
  | "reports"
  | "status"
  | "perm";

export interface AdminApiScopeDomainMeta {
  domain: AdminApiScopeDomain;
  /** 中文说明（报错与文档用）。 */
  label: string;
  /** 这个域有没有写操作（决定要不要生成 `write:<域>`）。 */
  writable: boolean;
  /** 是否只给平台超管（文档提示用）。 */
  platformOnly: boolean;
}

export const ADMIN_API_SCOPE_DOMAINS: readonly AdminApiScopeDomainMeta[] = [
  { domain: "join", label: "入群申请（查看 / 审批 / 同步）", writable: true, platformOnly: false },
  { domain: "audit", label: "审计记录（查看 / 导出）", writable: false, platformOnly: false },
  { domain: "punish", label: "处罚记录与处罚动作", writable: true, platformOnly: false },
  { domain: "blacklist", label: "黑名单（本群 / 全局）", writable: true, platformOnly: false },
  { domain: "appeal", label: "申诉队列与复核", writable: true, platformOnly: false },
  { domain: "rule", label: "群规则（含关键词 / 恢复继承）", writable: true, platformOnly: false },
  { domain: "notify", label: "通知（门槛 / 测试推送 / 投递记录）", writable: true, platformOnly: false },
  { domain: "activity", label: "活动（列表 / 状态 / 创建 / 字段 / 发布群）", writable: true, platformOnly: false },
  { domain: "alias", label: "别名表", writable: true, platformOnly: true },
  { domain: "settings", label: "配置（热改项）", writable: true, platformOnly: true },
  { domain: "reports", label: "统计报表", writable: false, platformOnly: false },
  { domain: "status", label: "状态 / 周期任务 / 运维健康", writable: false, platformOnly: true },
  { domain: "perm", label: "权限授予 / 撤销", writable: true, platformOnly: true },
];

/** 全部合法 scope（配置校验用）。 */
export const ADMIN_API_KNOWN_SCOPES: readonly string[] = [
  "*",
  "read",
  "write",
  ...ADMIN_API_SCOPE_DOMAINS.map((meta) => `read:${meta.domain}`),
  ...ADMIN_API_SCOPE_DOMAINS.filter((meta) => meta.writable).map(
    (meta) => `write:${meta.domain}`,
  ),
];

const KNOWN = new Set(ADMIN_API_KNOWN_SCOPES);

export function isKnownScope(scope: string): boolean {
  return KNOWN.has(scope);
}

/** 人类可读的 scope 清单（配置报错里列出来，省得去翻文档）。 */
export function describeKnownScopes(): string {
  return ADMIN_API_KNOWN_SCOPES.join(" / ");
}

export interface AdminApiRouteScope {
  /** HTTP 方法（大写；`*` 匹配全部）。 */
  method: string;
  /** Fastify 的路由模式（`request.routeOptions.url`）。 */
  url: string;
  /** 这个端点要求的 scope（可以是细粒度，也可以是 `read` / `write`）。 */
  scope: string;
}

/**
 * 端点 → scope 的登记表。
 *
 * 只登记「有明确域」的端点；`/auth/me`、`/auth/logout` 这类认证端点不在此表，
 * 走下面的粗粒度回落（读 `read` / 写 `write`）。
 */
export const ADMIN_API_ROUTE_SCOPES: readonly AdminApiRouteScope[] = [
  // 只读
  { method: "GET", url: "/api/status", scope: "read:status" },
  { method: "GET", url: "/api/tasks", scope: "read:status" },
  { method: "GET", url: "/api/health", scope: "read:status" },
  { method: "GET", url: "/api/settings", scope: "read:settings" },
  { method: "GET", url: "/api/pending", scope: "read:join" },
  { method: "GET", url: "/api/audit", scope: "read:audit" },
  { method: "GET", url: "/api/audit/export.csv", scope: "read:audit" },
  { method: "GET", url: "/api/rules", scope: "read:rule" },
  { method: "GET", url: "/api/notify/topics", scope: "read:notify" },
  { method: "GET", url: "/api/notify/deliveries", scope: "read:notify" },
  { method: "GET", url: "/api/punishments", scope: "read:punish" },
  { method: "GET", url: "/api/blacklist", scope: "read:blacklist" },
  { method: "GET", url: "/api/appeals", scope: "read:appeal" },
  { method: "GET", url: "/api/aliases", scope: "read:alias" },
  { method: "GET", url: "/api/reports", scope: "read:reports" },
  { method: "GET", url: "/api/reports/export.csv", scope: "read:reports" },
  { method: "GET", url: "/api/activities", scope: "read:activity" },
  { method: "GET", url: "/api/activities/fields", scope: "read:activity" },
  { method: "GET", url: "/api/activities/:code/export.csv", scope: "read:activity" },

  // 写
  { method: "POST", url: "/api/join/sync", scope: "write:join" },
  { method: "POST", url: "/api/pending/:requestId/approve", scope: "write:join" },
  { method: "POST", url: "/api/pending/:requestId/reject", scope: "write:join" },
  { method: "PUT", url: "/api/rules", scope: "write:rule" },
  { method: "POST", url: "/api/rules/keywords", scope: "write:rule" },
  { method: "POST", url: "/api/rules/reset-fields", scope: "write:rule" },
  { method: "POST", url: "/api/rules/reset", scope: "write:rule" },
  { method: "PUT", url: "/api/notify/levels", scope: "write:notify" },
  { method: "POST", url: "/api/notify/levels/reset", scope: "write:notify" },
  { method: "POST", url: "/api/notify/test", scope: "write:notify" },
  { method: "POST", url: "/api/punishments/:code/:action", scope: "write:punish" },
  { method: "POST", url: "/api/blacklist", scope: "write:blacklist" },
  { method: "DELETE", url: "/api/blacklist/:userId", scope: "write:blacklist" },
  { method: "POST", url: "/api/appeals/:code/:decision", scope: "write:appeal" },
  { method: "POST", url: "/api/activities", scope: "write:activity" },
  { method: "PUT", url: "/api/activities/:code", scope: "write:activity" },
  { method: "POST", url: "/api/activities/:code/groups", scope: "write:activity" },
  { method: "DELETE", url: "/api/activities/:code/groups/:group", scope: "write:activity" },
  { method: "POST", url: "/api/activities/:code/:action", scope: "write:activity" },
  { method: "PUT", url: "/api/aliases", scope: "write:alias" },
  { method: "DELETE", url: "/api/aliases/:alias", scope: "write:alias" },
  { method: "PUT", url: "/api/settings", scope: "write:settings" },
  { method: "DELETE", url: "/api/settings/:key", scope: "write:settings" },
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 某个请求要求的 scope：先查登记表，查不到回落到 `read` / `write`。
 *
 * 回落是**故意 fail-closed** 的：细粒度 token 没有粗粒度 `read` / `write`，
 * 所以没登记的新端点对它是拒绝的 —— 要么登记，要么给粗粒度 scope。
 */
export function requiredScopeFor(method: string, route: string): string {
  const upper = method.toUpperCase();
  const hit = ADMIN_API_ROUTE_SCOPES.find(
    (rule) => rule.url === route && (rule.method === "*" || rule.method === upper),
  );
  if (hit) {
    return hit.scope;
  }
  return READ_METHODS.has(upper) ? "read" : "write";
}
