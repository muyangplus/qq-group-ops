import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

import { getLogger, type Logger } from "../core/logger.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import { adminLoginUrl, machineTokenAllows, type AdminApiConfig, type AdminApiMachineToken } from "./config.js";
import { WindowRateLimiter } from "./rateLimit.js";
import type { AdminApiPermissionsView } from "./permissions.js";
import { SessionStore, type AdminSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 通过会话鉴权后挂上的会话（`preHandler` 里注入）。 */
    adminSession?: AdminSession | undefined;
    /** 通过机器令牌鉴权时挂上的 scope（E1-e）。 */
    adminMachineScopes?: readonly string[] | undefined;
  }
}

export const ADMIN_SESSION_COOKIE = "admin_session";
/** 兑换端点按 IP 的限流（防探测；比会话限流更严）。 */
export const TOKEN_EXCHANGE_PER_MINUTE = 10;

export interface AdminApiServerOptions {
  config: AdminApiConfig;
  tokens: AdminTokenRepository;
  sessions?: SessionStore | undefined;
  limiter?: WindowRateLimiter | undefined;
  exchangeLimiter?: WindowRateLimiter | undefined;
  now?: (() => Date) | undefined;
  logger?: Logger | undefined;
  version?: string | undefined;
  uptimeMs?: (() => number) | undefined;
  /**
   * 只读状态来源（E1-c）：数据库类型与启动期迁移问题数由入口注入；
   * 会话数等本进程信息由 server 自己补。
   */
  statusProvider?: (() => Promise<AdminApiStatusExtra> | AdminApiStatusExtra) | undefined;
  /** 审计记录读取器（E1-c `/api/audit`）；未装配时该端点回 503。 */
  auditReader?: AdminApiAuditReader | undefined;
  /** 只读数据源（E1-c）：待审批与规则覆盖。未装配时对应端点回 503。 */
  readers?: AdminApiReaders | undefined;
  /** 权限画像（E2-d）：给 `/auth/me` 附带，前端据此隐藏入口（服务端仍强校验）。 */
  permissionsOf?: ((userId: string) => Promise<AdminApiPermissionsView>) | undefined;
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

/** 审计数据源：入口用仓储实现（`persistence.audit.findAll()`）。 */
export interface AdminApiAuditReader {
  list(): Promise<AdminApiAuditRecord[]>;
}

/** 待审批申请（`/api/pending`）。 */
export interface AdminApiPendingItem {
  requestId: string;
  groupId: string;
  userId: string;
  reason: string;
  createdAt: string;
}

/** 某个群的规则覆盖（`/api/rules`）：原始覆盖行，合并生效值的逻辑在机器人侧。 */
export interface AdminApiRulesView {
  groupId: string;
  /** `group_configs` 的覆盖行（没有覆盖时为 null）。 */
  override: Record<string, unknown> | null;
  /** `group_settings` 的键值覆盖（关键词等扩展字段）。 */
  settings: Array<{ key: string; value: string }>;
}

export interface AdminApiReaders {
  pending(): Promise<AdminApiPendingItem[]>;
  rules(groupId: string): Promise<AdminApiRulesView>;
  /** 通知话题：默认门槛 + 订阅人数（订「全部群」与按群订阅分开）。 */
  notifyTopics(): Promise<AdminApiNotifyTopic[]>;
  /** 活动列表（含报名人数；群卡片广播目标在机器人侧管理）。 */
  activities(): Promise<AdminApiActivityItem[]>;
}

export interface AdminApiActivityItem {
  activityId: string;
  /** 活动短码（展示用）。 */
  code: string;
  title: string;
  groupId: string;
  status: string;
  capacity?: number | undefined;
  registered: number;
  createdAt: string;
}

export interface AdminApiNotifyTopic {
  topic: string;
  label: string;
  /** 全局默认门槛（实际门槛可能被 `__default__.notifyTopicLevels` 覆盖）。 */
  defaultLevel: number;
  /** 订「全部群」的人数。 */
  allScope: number;
  /** 按具体群订阅的行数（同一人可订多个群）。 */
  groupScopes: number;
}

/** 入口能提供、server 自己算不出来的那部分状态。 */
export interface AdminApiStatusExtra {
  database: string;
  migrationIssues: number;
  /** 当前未用且未过期的登录令牌数。 */
  activeTokens?: number | undefined;
}

export interface AdminApiServer {
  app: FastifyInstance;
  sessions: SessionStore;
  limiter: WindowRateLimiter;
  /** 拼登录链接（`PUBLIC_BASE_URL` 未配置时 undefined，只给令牌）。 */
  loginUrl: (token: string) => string | undefined;
}

/**
 * 管理 API 的 HTTP 层（E1-a，认证方案 B2）。
 *
 * 公开端点只有两个：`GET /healthz` 与 `POST /auth/token`（兑换一次性令牌），
 * 其余一律要求会话 cookie；写操作额外要求 `X-Admin-Request: 1`（CSRF）。
 * 日志只记方法 / 路由 / 状态 / 耗时 / actor，**不记 cookie 与令牌**。
 */
export function buildAdminApiServer(options: AdminApiServerOptions): AdminApiServer {
  const log = options.logger ?? getLogger("admin-api");
  const config = options.config;
  const sessions =
    options.sessions ??
    new SessionStore({ secret: config.sessionSecret, ttlMs: config.sessionTtlMs });
  const limiter =
    options.limiter ??
    new WindowRateLimiter({ limitPerWindow: config.rateLimitPerMinute });
  const exchangeLimiter =
    options.exchangeLimiter ??
    new WindowRateLimiter({ limitPerWindow: TOKEN_EXCHANGE_PER_MINUTE });
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();

  const app = Fastify({
    logger: false,
    // 路由级日志由下面的 onResponse 统一打（Fastify 自带的会打全量请求体）
    disableRequestLogging: true,
    // 反代后面才拿得到真实 IP；默认部署本来就在 127.0.0.1，trustProxy 只影响 IP 判定
    trustProxy: true,
  });

  app.addHook("onResponse", async (request, reply) => {
    log.info("admin api request", {
      method: request.method,
      route: (request.routeOptions?.url ?? request.url).split("?")[0],
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      actor: request.adminSession?.userId ?? null,
    });
  });

  app.get("/healthz", async () => ({
    ok: true,
    version: options.version ?? "unknown",
    uptimeMs: options.uptimeMs?.() ?? Date.now() - startedAt,
  }));

  app.post("/auth/token", async (request, reply) => {
    if (!exchangeLimiter.allow(`ip:${request.ip}`)) {
      return reply
        .code(429)
        .send(errorBody("rate_limited", "请求过于频繁，请稍后再试。"));
    }
    if (!hasCsrfHeader(request)) {
      return reply
        .code(403)
        .send(errorBody("csrf", "缺少 X-Admin-Request: 1 请求头。"));
    }
    const body = (request.body ?? {}) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    const userId = await options.tokens.redeem(token, now());
    if (!userId) {
      log.warn("admin api token rejected", { ip: request.ip });
      return reply.code(401).send(
        errorBody(
          "invalid_token",
          "令牌无效、已使用或已过期；请在机器人私信里重新用 /admin login 获取。",
        ),
      );
    }
    const { cookieValue, session } = sessions.create(userId);
    reply.header("set-cookie", sessionCookie(cookieValue, config));
    log.info("admin api login", { userId, ip: request.ip });
    return {
      userId: session.userId,
      expiresAt: new Date(session.createdAt + config.sessionTtlMs).toISOString(),
    };
  });

  app.addHook("preHandler", async (request, reply) => {
    const route = (request.routeOptions?.url ?? request.url).split("?")[0] ?? "";
    // 公开端点：健康检查与令牌兑换
    if (route === "/healthz" || route === "/auth/token") {
      return;
    }
    const session = sessions.touch(
      readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE),
    );
    if (!session) {
      // 没有会话 cookie：试机器令牌（E1-e）——`Authorization: Bearer <token>`
      const bearer = readBearerToken(request.headers.authorization);
      const machine = bearer === undefined
        ? undefined
        : findMachineToken(config.machineTokens, bearer, now());
      if (!machine) {
        return reply.code(401).send(
          errorBody("unauthorized", "请先登录：在机器人私信里发送 /admin login。"),
        );
      }
      const requiredScope = isWriteMethod(request.method) ? "write" : "read";
      if (!machineTokenAllows(machine, requiredScope, now())) {
        log.warn("admin api machine token scope denied", {
          scope: requiredScope,
          route,
        });
        return reply.code(403).send(
          errorBody(
            "forbidden",
            `这个机器令牌没有 \`${requiredScope}\` 权限（当前：${machine.scopes.join("|")}）。`,
          ),
        );
      }
      if (!limiter.allow(`token:${machine.token.slice(0, 8)}`)) {
        return reply
          .code(429)
          .send(errorBody("rate_limited", "请求过于频繁，请稍后再试。"));
      }
      request.adminMachineScopes = machine.scopes;
      // 机器令牌不涉及 cookie，因此不需要 CSRF 头
      return;
    }
    if (!limiter.allow(session.id)) {
      return reply
        .code(429)
        .send(errorBody("rate_limited", "请求过于频繁，请稍后再试。"));
    }
    if (isWriteMethod(request.method) && !hasCsrfHeader(request)) {
      return reply
        .code(403)
        .send(errorBody("csrf", "写操作必须带 X-Admin-Request: 1 请求头。"));
    }
    (request as FastifyRequest).adminSession = session;
  });

  app.get("/auth/me", async (request) => {
    const userId = request.adminSession?.userId ?? null;
    const permissions =
      userId !== null && options.permissionsOf
        ? await options.permissionsOf(userId)
        : undefined;
    return {
      userId,
      expiresAt: new Date(
        (request.adminSession?.lastSeenAt ?? now().getTime()) + config.sessionTtlMs,
      ).toISOString(),
      ...(permissions !== undefined ? { permissions } : {}),
    };
  });

  /** 只读状态（E1-c）：入口给数据库与迁移信息，server 补版本 / 运行时长 / 会话数。 */
  app.get("/api/status", async () => {
    const extra = options.statusProvider ? await options.statusProvider() : undefined;
    return {
      version: options.version ?? "unknown",
      uptimeMs: options.uptimeMs?.() ?? Date.now() - startedAt,
      database: extra?.database ?? "unknown",
      migrationIssues: extra?.migrationIssues ?? 0,
      activeTokens: extra?.activeTokens ?? 0,
      sessions: sessions.size,
    };
  });

  /** 只读审计记录（E1-c）：按群 / 操作人 / 动作过滤 + 分页。 */
  app.get("/api/audit", async (request, reply) => {
    const reader = options.auditReader;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "审计数据源未装配（缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const group = queryString(query.group);
    const actor = queryString(query.actor);
    const action = queryString(query.action);

    const all = await reader.list();
    const filtered = all.filter(
      (record) =>
        (group === undefined || record.groupId === group) &&
        (actor === undefined || record.actorId === actor) &&
        (action === undefined || record.action === action),
    );
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  /** 待审批入群申请（E1-c）：状态为 pending，可按群过滤 + 分页。 */
  app.get("/api/pending", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const group = queryString(query.group);

    const all = await readers.pending();
    const filtered =
      group === undefined ? all : all.filter((item) => item.groupId === group);
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  /** 某个群的规则覆盖（E1-c）：只读原始覆盖行，生效值合并逻辑在机器人侧。 */
  app.get("/api/rules", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    const group = queryString((request.query as Record<string, unknown>).group);
    if (group === undefined) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 ?group=<群ID 或 #群短码>。"));
    }
    return readers.rules(group);
  });

  /** 通知话题概览（E1-c）：默认门槛与订阅人数，供后台展示。 */
  app.get("/api/notify/topics", async (_request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    return { topics: await readers.notifyTopics() };
  });

  /** 活动列表（E1-c）：可选按群 / 状态过滤 + 分页。 */
  app.get("/api/activities", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const group = queryString(query.group);
    const status = queryString(query.status);

    const all = await readers.activities();
    const filtered = all.filter(
      (item) =>
        (group === undefined || item.groupId === group) &&
        (status === undefined || item.status === status),
    );
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    sessions.destroy(readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE));
    reply.header("set-cookie", sessionCookie("", config, 0));
    log.info("admin api logout", { userId: request.adminSession?.userId ?? null });
    return { ok: true };
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send(errorBody("not_found", "没有这个接口。")),
  );
  app.setErrorHandler(async (error, _request, reply) => {
    log.warn("admin api error", { error: String(error) });
    return reply.code(500).send(errorBody("internal_error", "服务内部错误。"));
  });

  return {
    app,
    sessions,
    limiter,
    loginUrl: (token: string) => adminLoginUrl(config, token),
  };
}

function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

function queryString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveQueryInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hasCsrfHeader(request: FastifyRequest): boolean {
  return request.headers["x-admin-request"] === "1";
}

function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

/** 从 `Authorization: Bearer <token>` 里取令牌。 */
export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/** 用常量时间比较找出匹配的机器令牌（避免按字符提前返回的时序差异）。 */
export function findMachineToken(
  tokens: readonly AdminApiMachineToken[],
  candidate: string,
  now: Date = new Date(),
): AdminApiMachineToken | undefined {
  let matched: AdminApiMachineToken | undefined;
  for (const token of tokens) {
    if (machineTokenAllows(token, "read", now) || machineTokenAllows(token, "write", now)) {
      if (tokensEqual(token.token, candidate)) {
        matched = token;
      }
    }
  }
  return matched;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `maxAgeSeconds = 0` 表示清 cookie（登出）。 */
export function sessionCookie(
  value: string,
  config: AdminApiConfig,
  maxAgeSeconds = Math.floor(config.sessionTtlMs / 1000),
): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
