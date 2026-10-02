import { NativeWebSocketFactory } from "./adapters/nativeWebSocketFactory.js";
import {
  restoreDistFromBackup,
  snapshotDist,
  takeRollbackNotice,
} from "./services/distSnapshot.js";
import {
  FailedVersionGuard,
  runRestartPreflight,
} from "./services/restartPreflight.js";
import {
  isStartupCheck,
  writeStartupCheckFile,
} from "./startupCheck.js";
import type { EventGateway } from "./adapters/eventGateway.js";
import { QQOfficialEventMapper } from "./adapters/qqOfficialEventMapper.js";
import { QQOfficialGateway } from "./adapters/qqOfficialGateway.js";
import { WebhookEventGateway } from "./adapters/webhookEventGateway.js";
import { isRateLimitedError } from "./adapters/qqOfficial.js";
import { rawMessageDaysResolver } from "./services/excerptRetention.js";
import { hasQqCredentials, loadSettings, type Settings } from "./config.js";
import { instrumentEventGateway } from "./core/instrumentation.js";
import { closeLogging, configureLogging, getLogger } from "./core/logger.js";
import { formatDisplayTime } from "./core/timeFormat.js";
import { retryWithBackoff } from "./core/retry.js";
import { loadEnvFile } from "./env.js";
import { attachGateway } from "./gatewayRunner.js";
import { startAdminApiHost, type AdminApiHost } from "./adminApi/host.js";
import { connectPersistence, type Persistence } from "./persistence.js";
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
import type {
  RestartRequestHandler,
  RestartRequestInfo,
} from "./services/restart.js";
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

/**
 * 自检成功（层 4A）：**硬失败**（settings / 数据库 / 建表 / 装配期抛错）由异常表达，
 * 走到这里就说明进程能起来；降级模块与迁移问题只作为信息输出，交给助手带原因去报告
 * （它们已经由层 1/2 兜住，不该拦住升级）。
 */
export async function finishStartupCheck(
  runtime: Runtime,
  persistence: Persistence | undefined,
): Promise<void> {
  const degraded = runtime.health.degraded.map((status) => ({
    module: status.key,
    error: status.error ?? "",
  }));
  const migrationIssues = persistence?.migration.issues ?? [];
  writeStartupCheckFile({
    ok: true,
    mode: runtime.mode,
    database: persistence?.driver ?? "memory",
    degraded,
    migrationIssues,
  });
  log.info("startup check ok", {
    degraded: degraded.map((item) => item.module),
    migrationSteps: migrationIssues.map((issue) => issue.step),
  });
  await runtime.flush();
  await persistence?.close();
  await closeLogging();
  process.exitCode = 0;
}

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
    // 热配置（/config）：这三项都在用的时候取当前值
    enabled: () => runtime.platform.get("autoRestartOnDeploy"),
    checkIntervalMs: () => runtime.platform.get("deployCheckIntervalMs"),
    delayMs: () => runtime.platform.get("deployRestartDelayMinutes") * 60_000,
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
            platformSettings: persistence.platformSettings,
           },
          }
        : {}),
      migration: persistence?.migration,
      // 管理 API 的 `/api/status` 要展示数据库类型（内存模式为 undefined）
      databaseDriver: persistence?.driver,
    },
  );
  if (persistence) {
    await runtime.load();
  }
  // 自检模式（层 4A）：只跑到「加载完成」，不接网关、不起定时器、不发重启回执，
  // 用退出码告诉调用方（`scripts/respawn.mjs`）这个版本到底能不能起来。
  if (isStartupCheck()) {
    await finishStartupCheck(runtime, persistence);
    return;
  }
  // 层 1 / 层 3 的可见性：模块降级、迁移失败都私信超管（通知模块没起来就只留日志）
  await announceStartupReport(runtime, persistence?.migration);
  // 层 4B：本构建已经初始化成功 → 留一份「上一次能起来」的快照，供下次自检失败时回滚
  snapshotDist();
  // 助手刚回滚过的话，告诉超管「现在跑的是上一版、新版本为什么没起来」
  await announceRollbackIfAny(runtime);
  // 上次 `/restart` 留下的回执：给发起人私信一条「已重启」（说明进程管理器真的拉回来了）
  await announceRestartIfAny(runtime);

  /**
   * 管理 API（E1-d）：在机器人进程内起**第二个回环监听口**（默认 `127.0.0.1:8787`），
   * 与 webhook 端口互不相干；读写都走上面这一份服务图（同一份内存态、同一个 tick）。
   *
   * 端口被占 / 监听失败只记错误，**不让机器人起不来**（管理面是旁路能力）；
   * 自检模式在上面已经 return，不会占端口。
   */
  const adminApiHost = await startAdminApiIfEnabled(runtime);

  const retention = new RetentionService(
    runtime.auditLog,
    runtime.joinAudit,
    {
      // 保留期是热配置：每次运行都取当前值
      auditLogRetentionDays: () => runtime.platform.get("auditLogRetentionDays"),
      joinRequestRetentionDays: () =>
        runtime.platform.get("auditLogRetentionDays"),
      // 原文保留期按**群**算：群（或全局默认规则）显式设过就用群值，否则用平台默认值
      rawMessageDaysFor: rawMessageDaysResolver(
        runtime.configStore,
        runtime.platform,
      ),
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
    // 热配置项打印**生效值**（可能是 /config 覆盖过的）
    rawMessageRetentionDays: runtime.platform.get("rawMessageRetentionDays"),
    auditLogRetentionDays: runtime.platform.get("auditLogRetentionDays"),
    appealHoldMinutes: runtime.platform.get("appealHoldMinutes"),
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
  // 扫描周期是热配置：每轮节拍按当前值排；改完立刻按新节拍重启定时器
  const scheduler = new TickScheduler({
    intervalMs: () => runtime.platform.get("scanIntervalMs"),
  });
  runtime.platform.onChange((key) => {
    if (key === "scanIntervalMs") {
      scheduler.restart();
    }
  });
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
    minIntervalMs: () => runtime.platform.get("deployCheckIntervalMs"),
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
    await adminApiHost?.close();
    await gateway.stop();
    await runtime.flush();
    await persistence?.close();
    await closeLogging();
    process.exit(0);
  };
  /** 自检不过的构建（进程内记忆）：部署监测不再对同一版本反复尝试。 */
  const failedVersions = new FailedVersionGuard();

  /**
   * `/restart` 的落点（**自我重启模式**）：**先自检**，通过才拉起 `scripts/respawn.mjs`
   * （等旧 PID 消失 → 释放端口/句柄 → 启动新进程），确认助手起来后写重启回执，
   * 再走与 SIGTERM 相同的优雅关闭并退出。
   *
   * 自检放在**退出之前**是关键：跑不过就**不退出** —— 最坏情况只是「这次重启没生效」，
   * 而不是「旧进程已经退出、新进程又起不来 → 机器人没了」。失败时顺手把坏构建换回上一版
   * （现役 `dist/` 挪进 `data/dist-broken/`），私信带「强制重启 / 再次检查」的取消卡，
   * 并让部署监测别再重试同一个目标版本。
   *
   * 手动再发 `/restart` 会**再检查一次**；「强制重启」按钮（`force`）才跳过自检。
   */
  restartHandler = (info) => {
    void runRestartFlow(info);
  };

  async function runRestartFlow(info: RestartRequestInfo): Promise<void> {
    const targetVersion = info.targetVersion ?? onDiskVersion();
    if (!info.force) {
      // 先排空写队列：尽量别和自检里的迁移抢 SQLite 写锁（busy_timeout 兜底）
      await runtime.flush();
      const preflight = runRestartPreflight({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      if (!preflight.ok) {
        const reason = preflight.reason ?? "自检未通过";
        log.error("restart aborted: startup check failed", {
          targetVersion,
          reason,
          requestedBy: info.requestedBy,
        });
        const restore = restoreDistFromBackup();
        failedVersions.markFailed(targetVersion, reason, info.reason ?? "manual");
        deployWatcher.blockVersion(targetVersion, reason);
        await notifyPreflightFailed(runtime, info, reason, restore);
        return;
      }
      // 自检通过：这个构建没问题，清掉旧的失败记录
      failedVersions.forget(targetVersion);
    } else {
      log.warn("restart forced: preflight skipped", { targetVersion });
    }

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
  }
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

/**
 * 自检不过时的「重启已取消」卡：机器人**没有退出**，坏构建已换回上一版，
 * 卡上给「强制重启」和「再次检查」两个出口。
 */
async function notifyPreflightFailed(
  runtime: Runtime,
  info: RestartRequestInfo,
  reason: string,
  restore: { ok: boolean; detail: string },
): Promise<void> {
  const lines = [
    "**机器人仍在运行上一版**（这次没有重启）。",
    `**新版本**：v${info.targetVersion ?? onDiskVersion()}`,
    `**原因**：${reason}`,
    restore.ok
      ? `已把坏构建换回上一版：${restore.detail}`
      : `换回上一版没成功：${restore.detail}`,
    "",
    "修好新版本后重新部署（版本一变就会重新检查）；也可以点下面两个按钮：",
    "「再次检查」只跑自检、不重启；「强制重启」跳过自检直接换版本（确认要看新版本行为时用）。",
  ];
  const rows = [
    [
      {
        id: "force",
        label: "强制重启",
        callbackData: encodeCallback("restart", "force"),
      },
      {
        id: "again",
        label: "再次检查",
        callbackData: encodeCallback("restart", "again"),
      },
    ],
    [
      {
        id: "proc",
        label: "看看进程状态",
        callbackData: encodeCallback("status", "proc"),
      },
    ],
  ];
  const card = renderCard({ title: "重启已取消", lines, rows });
  // 自动重启（部署监测）发给全部全局超管；手动重启发给发起人
  const recipients =
    info.reason === "deploy"
      ? runtime.permissions.listSuperAdmins()
      : [info.requestedBy];
  for (const userId of recipients) {
    const result = await runtime.notifications.sendPrivateCard(userId, card);
    if (!result.ok) {
      getLogger("main").warn("restart abort notice not delivered", {
        userId,
        detail: result.detail,
      });
    }
  }
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

/**
 * 助手的回滚回执（层 4B）：新版本自检不过 → 助手换回上一版构建再启动，
 * 这里把「现在跑的是哪一版、为什么回滚」告诉超管。
 */
async function announceRollbackIfAny(runtime: Runtime): Promise<void> {
  const notice = takeRollbackNotice();
  if (!notice) {
    return;
  }
  getLogger("main").warn("started after dist rollback", {
    reason: notice.reason,
    at: notice.at,
  });
  if (!runtime.health.isAllAvailable(["notify", "permissions"])) {
    getLogger("main").warn("rollback notice not delivered: notify unavailable");
    return;
  }
  const card = renderCard({
    title: "已回滚到上一版",
    lines: [
      `${notice.reason}`,
      "",
      `当前版本：v${appVersion()} · 回滚时间 ${formatDisplayTime(new Date(notice.at))}`,
      "修好新版本后可重新部署；期间机器人按上一版继续工作。",
    ],
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
  for (const userId of runtime.permissions.listSuperAdmins()) {
    const result = await runtime.notifications.sendPrivateCard(userId, card);
    if (!result.ok) {
      getLogger("main").warn("rollback notice not delivered", {
        userId,
        detail: result.detail,
      });
    }
  }
}

void main().catch((error: unknown) => {
  const message = formatError(error);
  console.error(message);
  // 自检模式下的硬失败要留证据：助手读到 `ok:false` 就不会拉起新进程
  if (isStartupCheck()) {
    writeStartupCheckFile({ ok: false, error: message });
  }
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

/**
 * 起管理 API 的同进程回环监听口（E1-d）。
 *
 * 三种「不起」都走同一条路：**不阻塞机器人启动**，只把原因写进日志：
 * - `ADMIN_API_ENABLED` 没开（`runtime.adminApiHost` 为 undefined）→ 静默返回；
 * - 纯内存模式没有令牌仓储 → 无法兑换登录令牌，起了也没人进得来；
 * - 端口被占 / 监听失败 → 管理面是旁路能力，不该拖垮收消息。
 */
async function startAdminApiIfEnabled(
  runtime: Runtime,
): Promise<AdminApiHost | undefined> {
  const source = runtime.adminApiHost;
  if (!source) {
    return undefined;
  }
  const log = getLogger("main");
  if (!source.tokens) {
    log.warn("管理 API 已开启但没有数据库，跳过监听口", {
      hint: "DATABASE_URL=memory 时没有令牌表，无法签发/兑换登录令牌。",
    });
    return undefined;
  }
  try {
    return await startAdminApiHost({
      config: source.config,
      tokens: source.tokens,
      backend: source.backend,
      version: appVersion(),
      uptimeMs: () => Math.round(process.uptime() * 1000),
      logger: getLogger("admin-api"),
    });
  } catch (error) {
    log.error("管理 API 监听失败（机器人继续运行）", {
      error: error instanceof Error ? error.message : String(error),
      hint: "端口可能被占用；改 ADMIN_API_PORT 或先停掉旧进程。",
    });
    return undefined;
  }
}
