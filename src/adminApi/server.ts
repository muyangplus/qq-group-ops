import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";

import { PermissionLevel, PlatformLevel } from "../core/enums.js";
import { getLogger, type Logger } from "../core/logger.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import { DEFAULT_GROUP_ID } from "../services/groupConfig.js";
import { adminLoginUrl, machineTokenAllows, type AdminApiConfig, type AdminApiMachineToken } from "./config.js";
import { AdminApiRequestError } from "./errors.js";
import { WindowRateLimiter } from "./rateLimit.js";
import type { AdminApiPermissionsView } from "./permissions.js";
import { SessionStore, type AdminSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 通过会话鉴权后挂上的会话（`preHandler` 里注入）。 */
    adminSession?: AdminSession | undefined;
    /** 通过机器令牌鉴权时挂上的 scope（E1-e）。 */
    adminMachineScopes?: readonly string[] | undefined;
    /** 通过机器令牌鉴权时的审计 actor（`machine:<前缀>`，不暴露完整令牌）。 */
    adminMachineActor?: string | undefined;
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
  /**
   * 写端点（E1-d）：审批 / 规则 / 活动状态 / 名单导出。未装配时对应端点回 503。
   *
   * 只有机器人进程内的回环监听口会装配它；`pnpm admin:api` 只读巡检模式不装配。
   */
  writers?: AdminApiWriters | undefined;
  /** 权限画像（E2-d）：给 `/auth/me` 附带，前端据此隐藏入口（服务端仍强校验）。 */
  permissionsOf?: ((userId: string) => Promise<AdminApiPermissionsView>) | undefined;
  /**
   * 只读端点的门槛（E1-g）：取该账号的只读范围。未装配时按「已登录管理员」全量放行
   * （只读巡检模式与单元测试走这条路），装配后每个只读端点都按下面的口径裁剪或 403。
   */
  readAccessOf?: ((userId: string) => Promise<AdminApiReadAccess>) | undefined;
  /** 只读权限被拒时写审计（E1-b 第 9 条）；未装配时只留日志。 */
  auditDenied?: ((input: AdminApiDeniedInput) => void) | undefined;
}

/** 只读范围：平台档 + 各群的生效档位（`describePermissions` 的输出形状）。 */
export interface AdminApiReadAccess {
  platformLevel: number;
  groups: Array<{ groupId: string; level: number }>;
}

/** 权限拒绝的审计输入（只读端点与写端点共用一种形状）。 */
export interface AdminApiDeniedInput {
  actorId: string;
  /** 路由模板，例如 `GET /api/audit`。 */
  route: string;
  reason: string;
  /** 相关群；平台级动作为空串。 */
  groupId: string;
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
  /** `group_configs` + `group_settings` 合并出的**覆盖字段**（没有覆盖时为 null）。 */
  override: Record<string, unknown> | null;
  /** `group_settings` 的键值覆盖（关键词等扩展字段）。 */
  settings: Array<{ key: string; value: string }>;
  /**
   * 合并全局默认后的**生效配置**（只读巡检模式不提供：它没有内存态服务）。
   *
   * 写端点校验「我改的到底生效成什么」要靠它；缺省时前端只展示覆盖字段。
   */
  effective?: Record<string, unknown> | undefined;
}

export interface AdminApiReaders {
  pending(): Promise<AdminApiPendingItem[]>;
  rules(groupId: string): Promise<AdminApiRulesView>;
  /** 通知话题：默认门槛 + 订阅人数（订「全部群」与按群订阅分开）。 */
  notifyTopics(): Promise<AdminApiNotifyTopic[]>;
  /** 活动列表（含报名人数；群卡片广播目标在机器人侧管理）。 */
  activities(): Promise<AdminApiActivityItem[]>;
}

/** 通过 / 拒绝入群申请后的回执。 */
export interface AdminApiJoinDecision {
  requestId: string;
  groupId: string;
  status: string;
  message: string;
}

/** 规则写回执。 */
export interface AdminApiRuleUpdateResult {
  groupId: string;
  /** `global` = 写的是全局默认规则（`__default__`）。 */
  locale: "global" | "group";
  fields: string[];
  message: string;
}

/** 活动状态变更回执。 */
export interface AdminApiActivityResult {
  activityId: string;
  code: string;
  groupId: string;
  status: string;
  message: string;
}

/** 活动名单 CSV。 */
export interface AdminApiCsvExport {
  filename: string;
  csv: string;
  rows: number;
  /** 是否含学号 / 班级 / 学院等隐私列。 */
  full: boolean;
}

/** 活动状态写动作。 */
export type AdminApiActivityAction = "open" | "close" | "cancel";

/**
 * 写端点（E1-d）。
 *
 * HTTP 层只做「取参数 → 调 writer → 序列化」，权限判据、领域服务调用与审计都在
 * writer 里（见 `backend.ts`）：这条边界让 HTTP 层不必重复实现业务规则，
 * 也让「只读巡检模式」（不装 writers）天然写不了任何东西。
 */
export interface AdminApiWriters {
  approveJoin(requestId: string, actorId: string): Promise<AdminApiJoinDecision>;
  rejectJoin(
    requestId: string,
    actorId: string,
    reason: string,
  ): Promise<AdminApiJoinDecision>;
  updateRule(
    groupId: string,
    field: string,
    value: string,
    actorId: string,
  ): Promise<AdminApiRuleUpdateResult>;
  setActivityStatus(
    code: string,
    action: AdminApiActivityAction,
    actorId: string,
  ): Promise<AdminApiActivityResult>;
  exportActivityCsv(
    code: string,
    actorId: string,
    options: { full: boolean },
  ): Promise<AdminApiCsvExport>;
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
      // 审计 actor：机器令牌用前缀（完整令牌绝不进审计 / 日志 / 数据库）
      request.adminMachineActor = `machine:${machine.token.slice(0, 8)}`;
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

  // ------------------------------------------------------------------ 只读端点（E1-c）
  //
  // 只读门槛（E1-g）：平台级信息要平台超管 240；群级数据按「本群档位」裁剪或拒绝
  // （审核员 120 = 能看，群管理员 130 = 能改）。机器令牌（运维自己配的服务凭据）视为
  // 平台级只读；未装配 `readAccessOf` 时全量放行（只读巡检模式与单测）。

  /** 审计 actor：会话用户；机器令牌用 `machine:<前缀>`（完整令牌不进日志 / 数据库）。 */
  const actorOf = (request: FastifyRequest): string =>
    request.adminSession?.userId ?? request.adminMachineActor ?? "unknown";

  /** 取本次请求的只读范围；`undefined` = 不限制（机器令牌 / 未装配）。 */
  const readAccessOf = async (
    request: FastifyRequest,
  ): Promise<AdminApiReadAccess | undefined> => {
    if (request.adminMachineScopes !== undefined || !options.readAccessOf) {
      return undefined;
    }
    const userId = request.adminSession?.userId;
    return userId ? await options.readAccessOf(userId) : undefined;
  };

  const levelIn = (access: AdminApiReadAccess, groupId: string): number =>
    access.groups.find((group) => group.groupId === groupId)?.level ?? 0;

  /** 平台超管（或未装配）→ 不裁剪；否则返回裁剪依据。 */
  const scopeOf = (
    access: AdminApiReadAccess | undefined,
  ): AdminApiReadAccess | undefined =>
    access && access.platformLevel < PlatformLevel.GlobalSuperAdmin
      ? access
      : undefined;

  const denyRead = (
    request: FastifyRequest,
    route: string,
    reason: string,
    groupId = "",
  ): void => {
    const actorId = actorOf(request);
    log.warn("admin api read denied", { actorId, route, reason, groupId });
    options.auditDenied?.({ actorId, route, reason, groupId });
  };

  /** 平台级只读端点：非平台超管 403（返回 false = 已回过响应）。 */
  const allowPlatformRead = async (
    request: FastifyRequest,
    reply: FastifyReply,
    route: string,
  ): Promise<boolean> => {
    const access = await readAccessOf(request);
    if (!access || access.platformLevel >= PlatformLevel.GlobalSuperAdmin) {
      return true;
    }
    denyRead(request, route, "需要平台超级管理员（240）");
    await reply
      .code(403)
      .send(errorBody("forbidden", "权限不足：需要平台超级管理员。"));
    return false;
  };

  /** 群级只读端点：本群档位不够 403（返回 false = 已回过响应）。 */
  const allowGroupRead = async (
    request: FastifyRequest,
    reply: FastifyReply,
    route: string,
    groupId: string,
    required: number,
  ): Promise<boolean> => {
    const access = await readAccessOf(request);
    if (!access || levelIn(access, groupId) >= required) {
      return true;
    }
    denyRead(request, route, `需要本群档位 ${required}`, groupId);
    await reply
      .code(403)
      .send(errorBody("forbidden", "权限不足：本群权限不够。"));
    return false;
  };

  /** 只读状态（E1-c）：入口给数据库与迁移信息，server 补版本 / 运行时长 / 会话数。 */
  app.get("/api/status", async (request, reply) => {
    if (!(await allowPlatformRead(request, reply, "GET /api/status"))) {
      return reply;
    }
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

  /** 只读审计记录（E1-c）：按群 / 操作人 / 动作过滤 + 分页；全量只有平台超管能看。 */
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

    const scope = scopeOf(await readAccessOf(request));
    if (scope) {
      // 非平台超管：必须指明群，且按该群档位判定（与 `/audit` 一样是审核员 120 起）
      if (group === undefined) {
        return reply
          .code(400)
          .send(
            errorBody(
              "bad_request",
              "需要 ?group=<群 ID>：只有平台超级管理员能查全量审计。",
            ),
          );
      }
      if (
        !(await allowGroupRead(
          request,
          reply,
          "GET /api/audit",
          group,
          PermissionLevel.Moderator,
        ))
      ) {
        return reply;
      }
    }

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

  /**
   * 待审批入群申请（E1-c）：状态为 pending，可按群过滤 + 分页。
   *
   * 非平台超管只看得到**自己够审核员（120）的群**（与指令层 `/pending` 同口径）；
   * 通过 / 拒绝按钮另外要群管理员 130（由写端点判定）。
   */
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

    const scope = scopeOf(await readAccessOf(request));
    const all = await readers.pending();
    const visible =
      scope === undefined
        ? all
        : all.filter(
            (item) =>
              levelIn(scope, item.groupId) >= PermissionLevel.Moderator,
          );
    const filtered =
      group === undefined
        ? visible
        : visible.filter((item) => item.groupId === group);
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  /**
   * 某个群的规则覆盖（E1-c）：只读原始覆盖行 + 合并后的生效值。
   *
   * `group` 用**内部群 ID**（`/auth/me` 给的就是它），不接受 `#群短码`；
   * 全局规则（`__default__`）只有平台超管能读，单群要审核员 120（与 `/rules` 查看口径一致）。
   */
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
        .send(errorBody("bad_request", "需要 ?group=<群 ID>。"));
    }
    if (group === DEFAULT_GROUP_ID) {
      if (!(await allowPlatformRead(request, reply, "GET /api/rules"))) {
        return reply;
      }
    } else if (
      !(await allowGroupRead(
        request,
        reply,
        "GET /api/rules",
        group,
        PermissionLevel.Moderator,
      ))
    ) {
      return reply;
    }
    return readers.rules(group);
  });

  /** 通知话题概览（E1-c）：默认门槛与订阅人数，供后台展示；话题门槛是平台级配置。 */
  app.get("/api/notify/topics", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    if (!(await allowPlatformRead(request, reply, "GET /api/notify/topics"))) {
      return reply;
    }
    return { topics: await readers.notifyTopics() };
  });

  /** 活动列表（E1-c）：可选按群 / 状态过滤 + 分页；非平台超管只看得见自己的群（120 起）。 */
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

    const scope = scopeOf(await readAccessOf(request));
    const all = await readers.activities();
    const visible =
      scope === undefined
        ? all
        : all.filter(
            (item) => levelIn(scope, item.groupId) >= PermissionLevel.Moderator,
          );
    const filtered = visible.filter(
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

  // ------------------------------------------------------------------ 写端点（E1-d）
  //
  // 统一形状：取路径 / 请求体参数 → 调 `writers` → 原样序列化领域层回执。
  // 权限判据（本群群管理员 130 / 平台超管 240）、领域服务调用与审计都在 writer 里；
  // writer 抛 `AdminApiRequestError` 时由下面的 errorHandler 映射成 400/403/404/409。

  /** 通过入群申请（复用 `JoinApprovalService`，官方接口成功后才落地本地状态）。 */
  app.post("/api/pending/:requestId/approve", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { requestId } = request.params as { requestId: string };
    const result = await writers.approveJoin(requestId, actorOf(request));
    return { ok: true, ...result };
  });

  /** 拒绝入群申请：请求体 `{ reason }`（可空，空 = 官方默认文案）。 */
  app.post("/api/pending/:requestId/reject", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { requestId } = request.params as { requestId: string };
    const body = (request.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : "";
    const result = await writers.rejectJoin(requestId, actorOf(request), reason);
    return { ok: true, ...result };
  });

  /** 写规则：`{ group, field, value }`；非法值整体拒绝（不会写半套）。 */
  app.put("/api/rules", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(
          errorBody(
            "bad_request",
            "需要 group（群 ID / #群短码 / 全局用 __default__）。",
          ),
        );
    }
    const field = typeof body.field === "string" ? body.field.trim() : "";
    if (field.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 field（规则字段名）。"));
    }
    if (typeof body.value !== "string") {
      return reply
        .code(400)
        .send(errorBody("bad_request", "value 必须是字符串（清空用空串）。"));
    }
    const result = await writers.updateRule(
      group,
      field,
      body.value,
      actorOf(request),
    );
    return { ok: true, ...result };
  });

  const ACTIVITY_ACTIONS = new Set(["open", "close", "cancel"]);

  /** 活动状态：`POST /api/activities/:code/open|close|cancel`。 */
  app.post("/api/activities/:code/:action", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code, action } = request.params as { code: string; action: string };
    if (!ACTIVITY_ACTIONS.has(action)) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "动作只能是 open / close / cancel。"));
    }
    const result = await writers.setActivityStatus(
      code,
      action as "open" | "close" | "cancel",
      actorOf(request),
    );
    return { ok: true, ...result };
  });

  /**
   * 活动名单 CSV：默认**脱敏**（清空学号 / 班级 / 学院），`?full=1` 才带隐私列。
   *
   * 两种都要求本群群管理员并写审计；响应带 UTF-8 BOM，Excel 直接打开不乱码。
   */
  app.get("/api/activities/:code/export.csv", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code } = request.params as { code: string };
    const query = request.query as Record<string, unknown>;
    const full = queryString(query.full) === "1";
    const result = await writers.exportActivityCsv(code, actorOf(request), {
      full,
    });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="${result.filename}"`,
    );
    // BOM：没有它 Excel 会按本地编码猜，中文列名直接乱码
    return reply.send(`\uFEFF${result.csv}`);
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
    // 领域层给的判定（权限不足 / 参数非法 / 不存在 / 已被处理）：按原状态码回，不打日志噪声
    if (error instanceof AdminApiRequestError) {
      log.info("admin api request rejected", {
        status: error.statusCode,
        error: error.errorCode,
      });
      return reply
        .code(error.statusCode)
        .send(errorBody(error.errorCode, error.message));
    }
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
