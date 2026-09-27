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
import { escapeCardText, renderCard } from "./services/cardTemplate.js";
import { ActivityReminderService } from "./services/activityReminder.js";
import { AppealWatcher } from "./services/appealWatcher.js";
import { RetentionService } from "./services/retention.js";

/** 启动阶段命中限流时的固定冷却时间。 */
const RATE_LIMIT_STARTUP_COOLDOWN_MS = 60_000;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取第一个非空字符串字段（官方不同事件的下划线写法不完全一致）。 */
function firstString(
  data: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

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
 * 机器人/群成员变动：
 *
 * - `GROUP_ADD_ROBOT` = **机器人被拉进群**；
 * - `GROUP_DEL_ROBOT` = **机器人被移出群**（带 `op_member_openid` 操作人）；
 * - `GROUP_MEMBER_ADD` = **群成员加入**（payload 只有 `group_openid` + `member_openid`，
 *   没有操作人字段）—— **不是**「机器人入群」：机器人自己入群走 `GROUP_ADD_ROBOT`。
 *   ⚠️ 待真机核对：若把机器人拉进测试群时也收到 `GROUP_MEMBER_ADD`（机器人也是成员），
 *   说明它还会因机器人入群触发，届时应只在 `member_openid` 不是机器人时按「成员加入」处理。
 */
const BOT_MEMBERSHIP_EVENTS: Record<
  string,
  "added" | "removed" | "member_added"
> = {
  GROUP_ADD_ROBOT: "added",
  GROUP_DEL_ROBOT: "removed",
  GROUP_MEMBER_ADD: "member_added",
};

/**
 * 未处理事件类型：私信全部**全局超管**（每类型一次，由 mapper 去重）。
 *
 * 其中「机器人入群 / 被移出群」单独出卡（`GROUP_ADD_ROBOT` / `GROUP_MEMBER_ADD` /
 * `GROUP_DEL_ROBOT`），标题与正文写清楚是入群还是退群，不再报「未知事件」。
 *
 * 内容含类型、顶层字段名与**截断后的 payload**（用户确认要原文，便于直接判断怎么映射）——
 * 注意 payload 里可能含用户 openid / 发言内容，只发给超管；文本一律过 `escapeCardText`
 * （真机踩过：JSON 里的成对下划线被 Markdown 当斜体吃掉，`scene_param` 显示成 `sceneparam`）。
 */
async function alertUnknownEvent(
  runtime: Runtime,
  info: { eventType: string; payload: unknown },
): Promise<void> {
  const admins = runtime.permissions.listSuperAdmins();
  const membership = BOT_MEMBERSHIP_EVENTS[info.eventType];
  if (admins.length === 0) {
    log.warn("no super admin to notify official event", {
      eventType: info.eventType,
      membership,
    });
    return;
  }
  const data = isRecordLike(info.payload) ? info.payload : undefined;
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
  const keys = data ? Object.keys(data).slice(0, 20) : [];
  const groupId = data
    ? firstString(data, "group_openid", "groupopenid")
    : undefined;
  const operator = data
    ? firstString(data, "op_member_openid", "member_openid", "openid")
    : undefined;
  const payloadLine = escapeCardText(payload, 800);

  const lines = membership
    ? [
        `**事件类型**：${info.eventType}`,
        ...(groupId
          ? [
              `**群**：${
                runtime.identityMap.getGroupNumber(groupId) ?? groupId
              }`,
            ]
          : []),
        ...(operator ? [`**相关成员**：${operator}`] : []),
        `**时间**：${formatDisplayTime(new Date())}`,
        "",
        `**顶层字段**：${escapeCardText(keys.join("、"))}`,
        "",
        "**原始 payload（截断 800 字）**：",
        payloadLine,
      ]
    : [
        `**事件类型**：${info.eventType}`,
        `**顶层字段**：${escapeCardText(keys.length > 0 ? keys.join("、") : "（非对象）")}`,
        `**时间**：${formatDisplayTime(new Date())}`,
        "",
        "**原始 payload（截断 800 字）**：",
        payloadLine,
      ];
  const card = renderCard({
    title:
      membership === "added"
        ? "机器人入群"
        : membership === "removed"
          ? "机器人被移出群"
          : membership === "member_added"
            ? "群成员加入"
            : "未知事件类型",
    lines,
    footer: [
      membership === "added" || membership === "removed"
        ? "如需配置本群规则 / 推送，请在群内发送 /status 或 /rules 查看当前状态。"
        : membership === "member_added"
          ? "群成员加入事件可用于迎新（欢迎语 / 提示看群规）；需要启用请告知开发者。"
          : "该事件类型目前没有被机器人处理；如需支持请告知开发者。",
    ],
  });
  for (const userId of admins) {
    await runtime.notifications.sendPrivateCard(userId, card);
  }
  log.info("official event alerted", {
    eventType: info.eventType,
    membership,
    admins: admins.length,
  });
}
