import { NativeWebSocketFactory } from "./adapters/nativeWebSocketFactory.js";
import type { EventGateway } from "./adapters/eventGateway.js";
import { QQOfficialEventMapper } from "./adapters/qqOfficialEventMapper.js";
import { QQOfficialGateway } from "./adapters/qqOfficialGateway.js";
import { WebhookEventGateway } from "./adapters/webhookEventGateway.js";
import { isRateLimitedError } from "./adapters/qqOfficial.js";
import { hasQqCredentials, loadSettings, type Settings } from "./config.js";
import { instrumentEventGateway } from "./core/instrumentation.js";
import { closeLogging, configureLogging, getLogger } from "./core/logger.js";
import { formatDisplayTime } from "./core/timeFormat.js";
import { retryWithBackoff } from "./core/retry.js";
import { loadEnvFile } from "./env.js";
import { attachGateway } from "./gatewayRunner.js";
import { connectPersistence } from "./persistence.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { renderCard } from "./services/cardTemplate.js";
import { ActivityReminderService } from "./services/activityReminder.js";
import { AppealWatcher } from "./services/appealWatcher.js";
import { RetentionService } from "./services/retention.js";

/** 启动阶段命中限流时的固定冷却时间。 */
const RATE_LIMIT_STARTUP_COOLDOWN_MS = 60_000;

const log = getLogger("main");

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
      rawMessageRetentionDays: settings.rawMessageRetentionDays,
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

  // §B8 申诉值班轮转：超时未处理的申诉转给下一位审核员（管理员本来就全通知）
  const appealWatcher = new AppealWatcher(
    runtime.moderationNotifier,
    runtime.appeals,
    runtime.punishments,
    { intervalMs: settings.appealForwardIntervalMs },
  );

  log.info("qq-group-ops Node.js runtime");
  log.info("configuration loaded", {
    qqCredentialsConfigured: hasQqCredentials(settings),
    runtimeMode: runtime.mode,
    databaseDriver: persistence?.driver ?? "memory",
    rawMessageRetentionDays: settings.rawMessageRetentionDays,
    auditLogRetentionDays: settings.auditLogRetentionDays,
    appealHoldMinutes: settings.appealHoldMinutes,
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
  appealWatcher.start();

  const gateway: EventGateway = instrumentEventGateway(
    settings.eventMode === "webhook"
      ? buildWebhookGateway(settings, runtime)
      : new QQOfficialGateway({
          api: runtime.api,
          createSocket: (url) => new NativeWebSocketFactory(url).create(),
          mapper: new QQOfficialEventMapper({
            onUnhandledEvent: (info) => {
              void alertUnknownEvent(runtime, info);
            },
          }),
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
  log.info("event gateway started", { mode: settings.eventMode });

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

/**
 * §D5：装配 Webhook 事件通道（`EVENT_MODE=webhook`）。
 *
 * 与 WebSocket 网关**二选一**：两条通道同时开会把同一条事件消费两次。
 * 密钥用于 Ed25519 验签（官方回调签名 + `op=13` URL 校验握手），
 * 缺省取机器人密钥 `QQ_BOT_CLIENT_SECRET`，可用 `WEBHOOK_SECRET` 单独覆盖。
 */
function buildWebhookGateway(
  settings: Settings,
  runtime: ReturnType<typeof createRuntime>,
): WebhookEventGateway {
  if (settings.webhookSecret.length === 0) {
    throw new Error(
      "EVENT_MODE=webhook 需要 WEBHOOK_SECRET（或 QQ_BOT_CLIENT_SECRET）来校验回调签名",
    );
  }
  return new WebhookEventGateway({
    secret: settings.webhookSecret,
    port: settings.webhookPort,
    host: settings.webhookHost,
    path: settings.webhookPath,
    mapper: new QQOfficialEventMapper({
      onUnhandledEvent: (info) => {
        void alertUnknownEvent(runtime, info);
      },
    }),
    keyDerivation: settings.webhookKeyDerivation,
    signContent: settings.webhookSignContent,
  });
}

/**
 * 未知事件类型：私信全部**全局超管**（每种类型只通知一次，由 mapper 去重）。
 *
 * 内容含类型、顶层字段名与**截断后的 payload**（用户确认要原文，便于直接判断怎么映射）——
 * 注意 payload 里可能含用户 openid / 发言内容，只发给超管。
 */
async function alertUnknownEvent(
  runtime: Runtime,
  info: { eventType: string; payload: unknown },
): Promise<void> {
  const admins = runtime.permissions.listSuperAdmins();
  if (admins.length === 0) {
    log.warn("unhandled official event but no super admin to notify", {
      eventType: info.eventType,
    });
    return;
  }
  const payload =
    typeof info.payload === "string"
      ? info.payload
      : (() => {
          try {
            return JSON.stringify(info.payload) ?? String(info.payload);
          } catch {
            return String(info.payload);
          }
        })();
  const card = renderCard({
    title: "未知事件类型",
    lines: [
      `**事件类型**：${info.eventType}`,
      `**顶层字段**：${
        info.payload && typeof info.payload === "object"
          ? Object.keys(info.payload as Record<string, unknown>)
              .slice(0, 20)
              .join("、")
          : "（非对象）"
      }`,
      `**时间**：${formatDisplayTime(new Date())}`,
      "",
      "**原始 payload（截断 800 字）**：",
      payload.length > 800 ? `${payload.slice(0, 800)}…` : payload,
    ],
    footer: ["该事件类型目前没有被机器人处理；如需支持请告知开发者。"],
  });
  for (const userId of admins) {
    await runtime.notifications.sendPrivateCard(userId, card);
  }
  log.info("unhandled official event alerted", {
    eventType: info.eventType,
    admins: admins.length,
  });
}
