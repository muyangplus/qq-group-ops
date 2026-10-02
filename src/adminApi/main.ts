import { randomUUID } from "node:crypto";

import { closeLogging, configureLogging, getLogger } from "../core/logger.js";
import { AuditStatus } from "../core/enums.js";
import { loadSettings } from "../config.js";
import { loadEnvFile } from "../env.js";
import { connectPersistence } from "../persistence.js";
import { IdentityMapService } from "../services/identityMap.js";
import { ShortCodeService } from "../services/shortCodes.js";
import { buildNotifyTopicViews } from "./backend.js";
import { adminLoginUrl, loadAdminApiConfig } from "./config.js";
import { createAdminApiEntities } from "./entityRef.js";
import { describeListenFailure } from "./listenFailure.js";
import {
  describePermissions,
  loadAdminApiPermissions,
  type AdminApiPermissionsView,
} from "./permissions.js";
import { buildAdminApiServer } from "./server.js";

/**
 * 管理 API 的**只读巡检入口**（E1，认证方案 B2；E1-d 起降级为只读）。
 *
 * 写操作（审批 / 改规则 / 活动状态 / 名单导出）只在**机器人进程内**的那个回环监听口上
 * （`src/adminApi/host.ts`，见 docs/ADMIN-API.md §2）：那里才有机器人的内存态服务图。
 * 这个独立进程只读仓储，用于「不想重启机器人、只想看状态 / 审计」的场景——
 * 它注册的写端点一律回 503。
 *
 * 启动：`pnpm admin:api`（需要先 `pnpm build`，或开发时用 `tsx src/adminApi/main.ts`）。
 * 未开启（`ADMIN_API_ENABLED` 非 true）时**什么都不做**，不监听端口。
 */
async function main(): Promise<void> {
  // 和 `src/main.ts` 一样先读 `.env`：否则「在应用目录里跑 pnpm admin:api」会看不到
  // 任何配置（进程环境变量本来就有优先级，真实存在的变量不会被覆盖）。
  loadEnvFile();
  const settings = loadSettings();
  configureLogging({
    level: settings.logLevel,
    file: settings.logFile,
    console: settings.logConsole,
    color: settings.logColor,
  });
  const log = getLogger("admin-api");
  const config = loadAdminApiConfig();
  if (!config.enabled) {
    log.info("admin api disabled", { hint: "ADMIN_API_ENABLED 未开启，未监听任何端口。" });
    await closeLogging();
    return;
  }

  const persistence = await connectPersistence(settings);
  if (!persistence) {
    throw new Error(
      "管理 API 需要数据库：DATABASE_URL=memory 时无法签发/兑换登录令牌。",
    );
  }

  // 展示层：只读巡检进程也能把「群号 / QQ号 / 短码」解出来 —— 靠的是同一批表
  // （`identity_bindings` + `short_codes`），不另造口径。
  const identityMap = new IdentityMapService(persistence.identityBindings);
  const shortCodes = new ShortCodeService(persistence.shortCodes);
  await Promise.all([identityMap.reload(), shortCodes.load()]);
  const entities = createAdminApiEntities({
    qqOf: (userId) => identityMap.getQq(userId),
    groupNumberOf: (groupId) => identityMap.getGroupNumber(groupId),
    // 只查不造：巡检进程不该顺手给历史数据发短码
    shortCodeOf: (kind, targetId) => shortCodes.existingCode(kind, targetId),
  });

  // 权限画像（E2-d）：与机器人共用两轴模型；每次请求重新加载（授权表很小）。
  // 群集合 = 授权行里的群 ∪ 有规则覆盖的群（这台进程没有内存态的群列表）。
  const viewFor = async (userId: string): Promise<AdminApiPermissionsView> => {
    const permissions = await loadAdminApiPermissions(persistence.permissions);
    if (!permissions) {
      return { platformLevel: 0, groups: [] };
    }
    const [grants, configs] = await Promise.all([
      persistence.permissions.findAll(),
      persistence.groupConfigs.findAll(),
    ]);
    const groupIds = [
      ...grants.map((grant) => grant.groupId).filter((groupId) => groupId.length > 0),
      ...configs.map((row) => row.groupId),
    ];
    return describePermissions(permissions, userId, groupIds, entities);
  };

  const server = buildAdminApiServer({
    config,
    tokens: persistence.adminTokens,
    version: process.env.npm_package_version ?? "unknown",
    uptimeMs: () => Math.round(process.uptime() * 1000),
    // 只读巡检模式也能把管理前台托管起来（同一个 ADMIN_API_WEB_DIR 开关）
    webRoot: config.webDir,
    // 只读状态（E1-c）：数据库类型 + 启动期迁移问题数（问题详情在机器人侧 /status proc）
    statusProvider: async () => ({
      database: persistence.driver,
      migrationIssues: persistence.migration.issues.length,
      activeTokens: await persistence.adminTokens.countActive(),
    }),
    // 只读审计（E1-c）：直接读审计表（保留期由 RetentionService 控制，量级有上限）
    auditReader: {
      list: async () =>
        (await persistence.audit.findAll()).map((record) => ({
          recordId: record.recordId,
          groupId: record.groupId,
          actorId: record.actorId,
          action: record.action,
          status: record.status,
          reason: record.reason,
          createdAt: record.createdAt.toISOString(),
          group: entities.group(record.groupId),
          actor: entities.user(record.actorId),
          ...(record.targetUserId !== undefined
            ? {
                targetUserId: record.targetUserId,
                target: entities.user(record.targetUserId),
              }
            : {}),
        })),
    },
    // 只读数据源（E1-c）：待审批申请与规则覆盖
    readers: {
      pending: async () =>
        (await persistence.joinRequests.findAll())
          .filter((request) => request.status === "pending")
          .map((request) => ({
            requestId: request.requestId,
            groupId: request.groupId,
            userId: request.userId,
            reason: request.reason,
            createdAt: request.createdAt.toISOString(),
            group: entities.group(request.groupId),
            applicant: entities.user(request.userId),
            request: entities.request(request.requestId),
          })),
      rules: async (groupId: string) => {
        const overrides = await persistence.groupConfigs.findAll();
        const settings = await persistence.groupSettings.findAll();
        return {
          groupId,
          group: entities.group(groupId),
          override:
            (overrides.find((row) => row.groupId === groupId) as unknown as
              | Record<string, unknown>
              | undefined) ?? null,
          settings: settings
            .filter((row) => row.groupId === groupId)
            .map((row) => ({ key: row.key, value: row.value })),
        };
      },
      notifyTopics: async () =>
        buildNotifyTopicViews(
          await persistence.notificationSubscriptions.findAll(),
        ),
      // 身份映射只读：直接读绑定表（巡检进程也看得到「什么时候绑的」）
      identities: async () => {
        const rows = await persistence.identityBindings.findAll();
        const item = (row: {
          kind: "user" | "group";
          officialId: string;
          externalId: string;
          createdAt?: Date | undefined;
          updatedAt?: Date | undefined;
        }) => ({
          officialId: row.officialId,
          entity:
            row.kind === "user"
              ? entities.user(row.officialId)
              : entities.group(row.officialId),
          externalId: row.externalId,
          ...(row.createdAt !== undefined
            ? { createdAt: row.createdAt.toISOString() }
            : {}),
          ...(row.updatedAt !== undefined
            ? { updatedAt: row.updatedAt.toISOString() }
            : {}),
        });
        return {
          users: rows.filter((row) => row.kind === "user").map(item),
          groups: rows.filter((row) => row.kind === "group").map(item),
        };
      },
      activities: async () => {
        const [activities, details, registrations, groupRows] = await Promise.all([
          persistence.activities.findActivities(),
          persistence.activityDetails.findAll(),
          persistence.activities.findRegistrations(),
          persistence.activityGroups.findAll(),
        ]);
        const groupsOf = new Map<string, string[]>();
        for (const row of groupRows) {
          const list = groupsOf.get(row.activityId) ?? [];
          list.push(row.groupId);
          groupsOf.set(row.activityId, list);
        }
        const codeOf = new Map(
          details.map((detail) => [detail.activityId, detail.code]),
        );
        const registeredOf = new Map<string, number>();
        for (const registration of registrations) {
          registeredOf.set(
            registration.activityId,
            (registeredOf.get(registration.activityId) ?? 0) + 1,
          );
        }
        return activities.map((activity) => ({
          activityId: activity.activityId,
          code: codeOf.get(activity.activityId) ?? "",
          title: activity.title,
          groupId: activity.groupId,
          status: activity.status,
          ...(activity.capacity !== undefined
            ? { capacity: activity.capacity }
            : {}),
          registered: registeredOf.get(activity.activityId) ?? 0,
          createdAt: activity.createdAt.toISOString(),
          group: entities.group(activity.groupId),
          // 发布群绑定在 `activity_groups` 表里（只读巡检也读得到）；
          // 没有任何绑定行时与 `ActivityService.listBoundGroups` 一致，回落到归属群。
          boundGroups: (() => {
            const bound = [...(groupsOf.get(activity.activityId) ?? [])].sort();
            const groups = bound.length > 0 ? bound : [activity.groupId];
            return groups
              .filter((groupId) => groupId.length > 0)
              .map((groupId) => entities.group(groupId));
          })(),
          ...(activity.closeAt !== undefined
            ? { closeAt: activity.closeAt.toISOString() }
            : {}),
        }));
      },
    },
    // 权限画像（E2-d）与只读门槛（E1-g）共用同一份视图
    permissionsOf: (userId: string) => viewFor(userId),
    // 顶栏展示名：只读巡检进程也把 QQ号 / 短码解出来（同一批表）
    userRefOf: (userId: string) => entities.user(userId),
    // 只读巡检模式也按同一套门槛：能登进来不等于能看全量数据
    readAccessOf: (userId: string) => viewFor(userId),
    // 只读巡检进程没有内存态审计存储，直接写审计表
    auditDenied: (input) => {
      persistence.audit.append({
        recordId: randomUUID(),
        groupId: input.groupId,
        actorId: input.actorId,
        action: "admin_api:denied",
        status: AuditStatus.Rejected,
        reason: `${input.route} ${input.reason}`,
        createdAt: new Date(),
      });
    },
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    log.info("admin api shutting down", { signal });
    await server.app.close().catch(() => undefined);
    await persistence.close().catch(() => undefined);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 监听失败要说清「谁占了端口、写操作还能不能用」，别只丢一句 EADDRINUSE 就退出
  try {
    await server.app.listen({ host: config.host, port: config.port });
  } catch (error) {
    log.error("管理 API 监听失败，已退出", {
      error: error instanceof Error ? error.message : String(error),
      hint: describeListenFailure({
        error,
        host: config.host,
        port: config.port,
        who: "inspect",
      }),
    });
    await shutdown("listen-failed");
    process.exitCode = 1;
    return;
  }
  log.info("admin api listening", {
    host: config.host,
    port: config.port,
    secureCookie: config.cookieSecure,
    loginUrl: config.publicBaseUrl.length > 0,
    mode: "readonly",
  });
  log.warn(
    "只读巡检模式：写端点（审批 / 规则 / 活动 / 导出）未装配，调用会回 503；" +
      "写操作请用机器人进程内的那个监听口。",
  );
  if (config.publicBaseUrl.length === 0) {
    log.warn(
      "ADMIN_API_PUBLIC_BASE_URL 未配置：/admin login 只会给出令牌，登录页需要手工粘贴。",
    );
  } else {
    // 只打一条示例，说明链接形状（真令牌在私信里，不落日志）
    log.info("admin api login link shape", {
      example: adminLoginUrl(config, "<token>"),
    });
  }
}

main().catch(async (error: unknown) => {
  getLogger("admin-api").error("admin api failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  await closeLogging().catch(() => undefined);
  process.exitCode = 1;
});
