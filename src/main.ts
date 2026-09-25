import { NativeWebSocketFactory } from "./adapters/nativeWebSocketFactory.js";
import { QQOfficialEventMapper } from "./adapters/qqOfficialEventMapper.js";
import { QQOfficialGateway } from "./adapters/qqOfficialGateway.js";
import { isRateLimitedError } from "./adapters/qqOfficial.js";
import { hasQqCredentials, loadSettings } from "./config.js";
import { instrumentEventGateway } from "./core/instrumentation.js";
import { closeLogging, configureLogging, getLogger } from "./core/logger.js";
import { retryWithBackoff } from "./core/retry.js";
import { loadEnvFile } from "./env.js";
import { attachGateway } from "./gatewayRunner.js";
import { connectPersistence } from "./persistence.js";
import { createRuntime } from "./runtime.js";
import { ActivityReminderService } from "./services/activityReminder.js";
import { RetentionService } from "./services/retention.js";

/** 启动阶段命中限流时的固定冷却时间。 */
const RATE_LIMIT_STARTUP_COOLDOWN_MS = 60_000;

async function main(): Promise<void> {
  loadEnvFile();
  const settings = loadSettings();
  configureLogging({
    level: settings.logLevel,
    file: settings.logFile,
    console: settings.logConsole,
    color: settings.logColor,
  });
  const log = getLogger("main");

  const persistence = await connectPersistence(settings);
  const runtime = createRuntime(
    settings,
    persistence
      ? {
          repositories: {
            audit: persistence.audit,
            joinRequests: persistence.joinRequests,
            groupConfigs: persistence.groupConfigs,
            groupSettings: persistence.groupSettings,
            identityBindings: persistence.identityBindings,
            groupMessageModes: persistence.groupMessageModes,
            permissions: persistence.permissions,
            activities: persistence.activities,
            activityDetails: persistence.activityDetails,
            activityWaitlist: persistence.activityWaitlist,
            activitySettings: persistence.activitySettings,
            activitySubscriptions: persistence.activitySubscriptions,
            activityNotifications: persistence.activityNotifications,
            activityGroups: persistence.activityGroups,
            notificationSubscriptions: persistence.notificationSubscriptions,
            notificationDeliveries: persistence.notificationDeliveries,
            blacklist: persistence.blacklist,
            punishments: persistence.punishments,
            appeals: persistence.appeals,
            shortCodes: persistence.shortCodes,
            userProfiles: persistence.userProfiles,
            classAliases: persistence.classAliases,
            menuDeliveries: persistence.menuDeliveries,
          },
        }
      : {},
  );
  if (persistence) {
    await runtime.load();
  }

  const retention = new RetentionService(
    runtime.auditLog,
    runtime.joinAudit,
    {
      auditLogRetentionDays: settings.auditLogRetentionDays,
      joinRequestRetentionDays: settings.auditLogRetentionDays,
      joinRequestTtlDays: settings.joinRequestTtlDays,
    },
    runtime.notifications,
    runtime.activityNotifications,
    runtime.punishments,
    runtime.appeals,
  );

  // C3 活动定时提醒：周期扫描 `activity_settings.remindAt`，到点在所有绑定群广播一次
  const activityReminder = new ActivityReminderService({
    activity: runtime.activity,
    notifications: runtime.activityNotifications,
    intervalMs: settings.activityRemindIntervalMs,
  });

  log.info("qq-group-ops Node.js runtime");
  log.info("configuration loaded", {
    qqCredentialsConfigured: hasQqCredentials(settings),
    runtimeMode: runtime.mode,
    databaseDriver: persistence?.driver ?? "memory",
    rawMessageRetentionDays: settings.rawMessageRetentionDays,
    auditLogRetentionDays: settings.auditLogRetentionDays,
    logLevel: settings.logLevel,
    logFile: settings.logFile,
  });

  if (runtime.mode === "fake") {
    log.warn("fake mode: official WebSocket gateway not started");
    await runtime.flush();
    await persistence?.close();
    await closeLogging();
    return;
  }

  await retention.runOnce();
  retention.start();
  await activityReminder.runOnce();
  activityReminder.start();

  const gateway = instrumentEventGateway(
    new QQOfficialGateway({
      api: runtime.api,
      createSocket: (url) => new NativeWebSocketFactory(url).create(),
      mapper: new QQOfficialEventMapper(),
      onHello: (heartbeatIntervalMs) => {
        log.debug("gateway hello", { heartbeatIntervalMs });
      },
      onReady: () => {
        log.info("gateway ready: bot authenticated");
      },
      onError: (error) => {
        log.error("gateway error", { error: formatError(error) });
      },
      onReconnect: (info) => {
        log.warn("gateway reconnect scheduled", {
          attempt: info.attempt,
          delayMs: info.delayMs,
          reason: info.reason,
          rateLimited: info.rateLimited,
        });
      },
      onGroupMessageMode: (groupId, enabled) => {
        runtime.groupMessageMode.setEnabled(groupId, enabled);
        void runtime.flush();
        log.info("group full-message mode changed", { groupId, enabled });
      },
    }),
    log,
  );

  const cacheStatus = await runtime.api.cacheStatus?.();
  log.info("bot cache status", {
    ...cacheStatus,
    cacheFile: settings.qqBotCacheFile || "（仅内存）",
  });

  try {
    await retryWithBackoff(() => attachGateway(runtime, gateway), {
      maxAttempts: 3,
      initialDelayMs: 2_000,
      maxDelayMs: 15_000,
      label: "gateway-start",
      // 命中限流时不要按指数退避硬打，改用较长的固定冷却。
      delayFor: (error) =>
        isRateLimitedError(error) ? RATE_LIMIT_STARTUP_COOLDOWN_MS : undefined,
      onRetry: (info) => {
        log.warn("gateway start failed, retrying", {
          attempt: info.attempt,
          delayMs: info.delayMs,
          rateLimited: isRateLimitedError(info.error),
          error: formatError(info.error),
        });
      },
    });
  } catch (error) {
    if (isRateLimitedError(error)) {
      throw new Error(
        "QQ 开放平台接口触发频率限制，已多次重试仍失败。\n" +
          "请等待 1-2 分钟后重新启动；access token 与网关地址已缓存，" +
          "下次启动不会再请求 /gateway。",
        { cause: error },
      );
    }
    throw error;
  }
  log.info("official WebSocket gateway started");

  const shutdown = async (): Promise<void> => {
    retention.stop();
    await gateway.stop();
    await runtime.flush();
    await persistence?.close();
    await closeLogging();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
