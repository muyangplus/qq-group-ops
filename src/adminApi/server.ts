import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { getLogger, type Logger } from "../core/logger.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import { adminLoginUrl, type AdminApiConfig } from "./config.js";
import { WindowRateLimiter } from "./rateLimit.js";
import { SessionStore, type AdminSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 通过鉴权后挂上的会话（`preHandler` 里注入）。 */
    adminSession?: AdminSession | undefined;
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
      return reply
        .code(401)
        .send(errorBody("unauthorized", "请先登录：在机器人私信里发送 /admin login。"));
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

  app.get("/auth/me", async (request) => ({
    userId: request.adminSession?.userId ?? null,
    expiresAt: new Date(
      (request.adminSession?.lastSeenAt ?? now().getTime()) + config.sessionTtlMs,
    ).toISOString(),
  }));

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
