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
import { startupReportText } from "./services/commands/healthCommands.js";
import type { MigrationResult } from "./db/migrate.js";
import { ActivityReminderService } from "./services/activityReminder.js";
import { AppealWatcher } from "./services/appealWatcher.js";
import { RetentionService } from "./services/retention.js";
import { DEFAULT_RETENTION_INTERVAL_MS } from "./services/retention.js";
import { TickScheduler } from "./services/tickScheduler.js";
import { DeployWatcher } from "./services/deployWatcher.js";
import { NOTIFY_SCOPE_ALL, topicOfOfficialEvent } from "./services/notifyTopics.js";
import {
  restartDoneCard,
  takeRestartNotice,
  writeRestartNotice,
} from "./services/restartNotice.js";
import type { RestartRequestHandler } from "./services/restart.js";
import { appVersion, captureRunningVersion, onDiskVersion, runningVersionOf } from "./core/buildInfo.js";
import { encodeCallback } from "./services/callbackData.js";
import { spawnRespawnHelper } from "./services/respawn.js";
import { sendWelcome } from "./services/welcome.js";

/** 启动阶段命中限流时的固定冷却时间。 */
const RATE_LIMIT_STARTUP_COOLDOWN_MS = 60_000;

/** `/restart` 退出前的固定延迟：留时间把「正在重启」的回执卡片发出去。 */
const RESTART_EXIT_DELAY_MS = 2_000;

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
  // 先把「本进程运行的版本」固化下来：部署监测要拿它和磁盘版本比
  // （`appVersion()` 读磁盘，部署后会变成新版本，不固化就永远不会触发自动重启）。
  captureRunningVersion();
  configureLogging({
    level: settings.logLevel,
    file: settings.logFile,
    console: settings.logConsole,
    color: settings.logColor,
  });
  const log = getLogger("main");

  const persistence = await connectPersistence(settings);
  /**
   * `/restart` 的落点（在 `shutdown` 定义好之前先占位）：
   * 命令层只调用 `runtime.restart.request(...)`，真正退出由这里的优雅关闭负责。
   */
  let restartHandler: RestartRequestHandler | undefined;
  /**
   * 部署监测（P0）：检测到「磁盘版本 ≠ 运行版本」并稳定若干轮后，
   * 通知全部全局超管并计划自动重启。这里的闭包引用后面才创建的 `runtime`，
   * 但真正执行都在启动之后，所以是安全的。
   */
  const deployWatcher = new DeployWatcher({
    enabled: settings.autoRestartOnDeploy,
    checkIntervalMs: settings.deployCheckIntervalMs,
    delayMs: settings.deployRestartDelayMinutes * 60_000,
    runningVersion: runningVersionOf,
    onDiskVersion,
    recipients: () => runtime.permissions.listSuperAdmins(),
    notify: async (userId, card) => {
      await runtime.notifications.sendPrivateCard(userId, card);
    },
    requestRestart: (info) => runtime.restart.request(info),
  });
  const runtime = createRuntime(
    settings,
    {
      onRestartRequested: (info) => restartHandler?.(info),
      deploy: deployWatcher,
      ...(persistence
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
        : {}),
      migration: persistence?.migration,
    },
  );
  if (persistence) {
    await runtime.load();
  }
  // 层 1 / 层 3 的可见性：模块降级、迁移失败都私信超管（通知模块没起来就只留日志）
  await announceStartupReport(runtime, persistence?.migration);
  // 上次 `/restart` 留下的回执：给发起人私信一条「已重启」（说明进程管理器真的拉回来了）
  await announceRestartIfAny(runtime);

  const retention = new RetentionService(
    runtime.auditLog,
    runtime.joinAudit,
    {
      auditLogRetentionDays: settings.auditLogRetentionDays,
      joinRequestRetentionDays: settings.auditLogRetentionDays,
      rawMessageRetentionDays: settings.rawMessageRetentionDays,
    },
    runtime.notifications,
    runtime.activityNotifications,
    runtime.punishments,
    runtime.appeals,
  );

  // C3 活动定时提醒：每轮扫描 `activity_settings.remindAt`，到点在所有绑定群广播一次
  const activityReminder = new ActivityReminderService({
    activity: runtime.activity,
    notifications: runtime.activityNotifications,
  });

  // §B8 申诉值班轮转：超时未处理的申诉转给下一位审核员（管理员本来就全通知）
  const appealWatcher = new AppealWatcher(
    runtime.moderationNotifier,
    runtime.appeals,
    runtime.punishments,
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

  // 统一计时：全项目只跑一个定时器（`SCAN_INTERVAL_MS`，0 = 关闭所有周期任务）；
  // 各任务只声明自己的最小间隔，是否到点由调度器判断。
  const scheduler = new TickScheduler({ intervalMs: settings.scanIntervalMs });
  scheduler.register({
    name: "retention",
    minIntervalMs: DEFAULT_RETENTION_INTERVAL_MS,
    enabled: () =>
      runtime.health.isAllAvailable(["audit", "join", "notify", "sanction"]),
    run: async () => {
      await retention.runOnce();
    },
  });
  scheduler.register({
    name: "activity-reminder",
    enabled: () => runtime.health.isAvailable("activity"),
    run: async () => {
      await activityReminder.runOnce();
    },
  });
  scheduler.register({
    name: "appeal-watcher",
    // 启动时不扫（与旧行为一致：首次派发在 notifyAppeal 里完成）
    runOnStart: false,
    enabled: () => runtime.health.isAvailable("sanction"),
    run: async () => {
      await appealWatcher.runOnce();
    },
  });
  // 待审批申请 TTL：纯内存检查，每轮都跑（过期申请立刻从 /pending 消失）
  scheduler.register({
    name: "join-pending-ttl",
    enabled: () => runtime.health.isAvailable("join"),
    run: () => {
      runtime.joinAudit.expireStalePending();
    },
  });
  scheduler.register({
    name: "deploy-watcher",
    minIntervalMs: settings.deployCheckIntervalMs,
    run: async () => {
      await deployWatcher.runOnce();
    },
  });
  await scheduler.runOnce();
  scheduler.start();

  const gateway: EventGateway = instrumentEventGateway(
    settings.eventMode === "webhook"
      ? buildWebhookGateway(settings, runtime)
      : new QQOfficialGateway({
          api: runtime.api,
          createSocket: (url) => new NativeWebSocketFactory(url).create(),
          mapper: new QQOfficialEventMapper({
            onUnhandledEvent: (info) => {
              void handleOfficialEvent(runtime, info);
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
    scheduler.stop();
    deployWatcher.stop();
    await gateway.stop();
    await runtime.flush();
    await persistence?.close();
    await closeLogging();
    process.exit(0);
  };
  /**
   * `/restart` 的落点（**自我重启模式**）：先脱离会话拉起 `scripts/respawn.mjs`
   * （等旧 PID 消失 → 释放端口/句柄 → 启动新进程），确认助手已起来后写重启回执，
   * 再走与 SIGTERM 完全相同的优雅关闭并退出。
   *
   * 助手没起来就**不退出**：否则机器人就真的没了（命令层会收到 `false` 并回「重启失败」）。
   */
  restartHandler = (info) => {
    const respawn = spawnRespawnHelper({
      pid: process.pid,
      execPath: process.execPath,
      args: process.argv.slice(1),
    });
    if (!respawn.ok) {
      throw new Error(`重启助手启动失败：${respawn.detail}`);
    }
    writeRestartNotice({
      userId: info.requestedBy,
      requestedAt: new Date().toISOString(),
      version: appVersion(),
      mode: "respawn",
      reason: info.reason ?? "manual",
      ...(info.targetVersion !== undefined
        ? { targetVersion: info.targetVersion }
        : {}),
    });
    log.warn("restart requested: respawn helper armed", {
      requestedBy: info.requestedBy,
      reason: info.reason ?? "manual",
      delayMs: RESTART_EXIT_DELAY_MS,
    });
    setTimeout(() => {
      if (respawn.failed()) {
        // 助手在启动阶段就报错 → 撤销退出，并私信纠正刚才那张「正在重启」的回执
        log.error("restart aborted: respawn helper errored before exit");
        void notifyRestartAborted(runtime, info.requestedBy, respawn.detail);
        return;
      }
      void shutdown();
    }, RESTART_EXIT_DELAY_MS);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

/**
 * 「重启已取消」的私信：助手没起来 → 旧进程**没有退出**，必须告诉发起人别以为已经重启了。
 */
async function notifyRestartAborted(
  runtime: Runtime,
  userId: string,
  detail: string,
): Promise<void> {
  const card = renderCard({
    title: "重启已取消",
    lines: [
      "重启助手没能启动，**机器人仍在运行**（这次没有重启）。",
      `**原因**：${detail.length > 0 ? detail : "未知（详见启动日志）"}`,
      "",
      "可以稍后再试一次「确认重启」；如果一直这样，建议改用 docker compose / systemd / pm2 之类的守护方式。",
    ],
    rows: [
      [
        {
          id: "proc",
          label: "看看进程状态",
          callbackData: encodeCallback("status", "proc"),
        },
      ],
    ],
  });
  const result = await runtime.notifications.sendPrivateCard(userId, card);
  if (!result.ok) {
    getLogger("main").warn("restart-aborted notice not delivered", {
      userId,
      detail: result.detail,
    });
  }
}

/**
 * 启动时的「重启回执」：重启前会写一行文件，新进程起来后读走它并私信结果。
 *
 * - `manual`（指令点的）→ 发给发起人；
 * - `deploy`（部署监测自动重启）→ 发给**全部全局超管**，重点说清新旧版本。
 *
 * 投递失败只记日志：这只是一种自证手段，不能影响启动。
 */
async function announceRestartIfAny(runtime: Runtime): Promise<void> {
  const notice = takeRestartNotice();
  if (!notice) {
    return;
  }
  const card = restartDoneCard(notice, appVersion());
  const recipients =
    notice.reason === "deploy"
      ? runtime.permissions.listSuperAdmins()
      : [notice.userId];
  if (recipients.length === 0) {
    getLogger("main").warn("no recipient for restart notice", {
      reason: notice.reason ?? "manual",
    });
    return;
  }
  for (const userId of recipients) {
    const result = await runtime.notifications.sendPrivateCard(userId, card);
    if (!result.ok) {
      getLogger("main").warn("restart notice not delivered", {
        userId,
        detail: result.detail,
      });
    }
  }
}

/**
 * 启动报告：模块降级 / 数据迁移失败时私信订阅了「启动报告」话题的超管。
 *
 * 每一条都会在 `/status proc` 里常驻显示，这里只是主动告知；发送失败只记日志，
 * 通知模块自己就是降级模块时也无从发送（那种情况只剩日志与状态卡）。
 */
async function announceStartupReport(
  runtime: Runtime,
  migration: MigrationResult | undefined,
): Promise<void> {
  const degraded = runtime.health.degraded;
  const issues = migration?.issues ?? [];
  if (degraded.length === 0 && issues.length === 0) {
    return;
  }
  getLogger("main").warn("startup report: degraded state", {
    modules: degraded.map((status) => status.key),
    migrationSteps: issues.map((issue) => issue.step),
  });
  if (!runtime.health.isAllAvailable(["notify", "permissions"])) {
    getLogger("main").warn("startup report not delivered: notify unavailable");
    return;
  }
  const recipients = runtime.notifications.topicSubscribers("startup");
  if (recipients.length === 0) {
    getLogger("main").warn("startup report has no subscriber");
    return;
  }
  const text = startupReportText(runtime.health, migration);
  const card = renderCard({
    title: "启动报告",
    lines: text.split("\n"),
    rows: [
      [
        {
          id: "status",
          label: "查看状态",
          callbackData: encodeCallback("status", "proc"),
        },
      ],
    ],
  });
  for (const userId of recipients) {
    const result = await runtime.notifications.sendPrivateCard(userId, card);
    if (!result.ok) {
      getLogger("main").warn("startup report not delivered", {
        userId,
        detail: result.detail,
      });
    }
  }
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
        void handleOfficialEvent(runtime, info);
      },
    }),
  });
}

/**
 * 官方事件的统一入口（WS 与 Webhook 共用）：
 *
 * 1. `GROUP_MEMBER_ADD` → 先尝试**群内迎新**（`/rules set welcome on`，默认关）；
 * 2. 再按原有口径给全部全局超管出一张告警卡（每类型一次，由 mapper 去重）。
 */
async function handleOfficialEvent(
  runtime: Runtime,
  info: { eventType: string; payload: unknown },
): Promise<void> {
  if (info.eventType === "GROUP_MEMBER_ADD") {
    await maybeWelcomeMember(runtime, info.payload);
  }
  await alertUnknownEvent(runtime, info);
}

/** `GROUP_MEMBER_ADD` → 群内迎新（成员 openid 缺失或没开迎新时什么都不做）。 */
async function maybeWelcomeMember(
  runtime: Runtime,
  payload: unknown,
): Promise<void> {
  const data = isRecordLike(payload) ? payload : undefined;
  const groupId = data
    ? firstString(data, "group_openid", "groupopenid")
    : undefined;
  const memberId = data
    ? firstString(data, "member_openid", "memberopenid")
    : undefined;
  if (!groupId || !memberId) {
    return;
  }
  const outcome = await sendWelcome(
    { configStore: runtime.configStore, sender: runtime.richMessages },
    groupId,
    memberId,
  );
  if (outcome === "sent") {
    log.info("welcome sent", { groupId });
  }
}

/**
 * 机器人/群成员变动：
 *
 * - `GROUP_ADD_ROBOT` = **机器人被拉进群**；
 * - `GROUP_DEL_ROBOT` = **机器人被移出群**（带 `op_member_openid` 操作人）；
 * - `GROUP_MEMBER_ADD` = **群成员加入**（payload 只有 `group_openid` + `member_openid`，
 *   没有操作人字段）—— **不是**「机器人入群」：机器人自己入群走 `GROUP_ADD_ROBOT`。
 *   ⚠️ 待真机核对：若把机器人拉进测试群时也收到 `GROUP_MEMBER_ADD`（机器人也是成员），
 *   说明它还会因机器人入群触发；payload 里没有任何能识别「机器人自己」的字段，
 *   届时应由官方文档或实际 openid 对比来决定怎么挡（目前只记日志、不做猜测）。
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
 * 未处理事件类型：私信**订阅了该话题的人**（默认超管开，可退订；未知事件每类型一次）。
 *
 * 其中「机器人入群 / 被移出群 / 群成员加入 / 好友变动」各自对应一个话题，
 * 标题与正文写清楚发生了什么，不再报「未知事件」。
 *
 * 内容含类型、顶层字段名与**截断后的 payload**（用户确认要原文，便于直接判断怎么映射）——
 * 注意 payload 里可能含用户 openid / 发言内容，只发给订阅者；文本一律过 `escapeCardText`
 * （真机踩过：JSON 里的成对下划线被 Markdown 当斜体吃掉，`scene_param` 显示成 `sceneparam`）。
 */
async function alertUnknownEvent(
  runtime: Runtime,
  info: { eventType: string; payload: unknown },
): Promise<void> {
  const topic = topicOfOfficialEvent(info.eventType);
  const recipients = runtime.notifications.topicSubscribers(topic);
  if (recipients.length === 0) {
    // 没人订阅这类通知是正常状态（不是错误），只留 debug
    log.debug("no subscribers for official event", {
      eventType: info.eventType,
      topic,
    });
    return;
  }
  const membership = BOT_MEMBERSHIP_EVENTS[info.eventType];
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

  const lines = [
    `**事件类型**：${info.eventType}`,
    ...(groupId
      ? [
          `**群**：${runtime.identityMap.getGroupNumber(groupId) ?? groupId}`,
        ]
      : []),
    ...(operator ? [`**相关成员**：${operator}`] : []),
    `**时间**：${formatDisplayTime(new Date())}`,
    "",
    `**顶层字段**：${escapeCardText(
      keys.length > 0 ? keys.join("、") : "（非对象）",
    )}`,
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
            : topic === "friend"
              ? "好友变动"
              : "未知事件类型",
    lines,
    footer: [
      "可在 /notify 里调整或退订这类通知（卡片底部也有「取消订阅」按钮）。",
      ...(topic === "member_join"
        ? [
            "迎新已可用：群管理员在群内发 /rules →「更多设置 → 迎新」，或 /rules set welcome on。",
          ]
        : []),
      ...(topic === "unknown_event"
        ? ["该事件类型目前没有被机器人处理；如需支持请告知开发者。"]
        : []),
    ],
  });
  for (const userId of recipients) {
    // 每张卡底部带「取消订阅此通知」，按钮只允许收件人本人点 → 每人一张
    await runtime.notifications.sendPrivateCard(
      userId,
      runtime.notifications.withUnsubscribeRow(
        card,
        topic,
        NOTIFY_SCOPE_ALL,
        userId,
      ),
    );
  }
  log.info("official event alerted", {
    eventType: info.eventType,
    topic,
    recipients: recipients.length,
  });
}
