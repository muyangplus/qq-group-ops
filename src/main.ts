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
import { describeListenFailure } from "./adminApi/listenFailure.js";
import { connectPersistence, type Persistence } from "./persistence.js";
import { createRuntime, toRuntimeRepositories, type Runtime } from "./runtime.js";
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
  preflightFailedCard,
  restartDoneCard,
  takeRestartNotice,
  writeRestartNotice,
} from "./services/restartNotice.js";
import {
  acquireInstanceLock,
  releaseInstanceLock,
  writeDuplicateEvidence,
} from "./services/instanceLock.js";
import type {
  RestartRequestHandler,
  RestartRequestInfo,
} from "./services/restart.js";
import { appVersion, captureRunningVersion, distFingerprint, onDiskVersion, runningVersionOf } from "./core/buildInfo.js";
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
  // 同一刻固化「这份进程加载的产物内容」：只看版本号会在「新代码已落地、package.json 还没落地」
  // 的上传窗口里白跳一次重启，指纹能把「版本号变了」与「代码真的换了」分开（见 distFingerprint）。
  const bootFingerprint = distFingerprint();
  configureLogging({
    level: settings.logLevel,
    file: settings.logFile,
    console: settings.logConsole,
    color: settings.logColor,
  });
  const log = getLogger("main");

  /**
   * 单实例闸：**同一个应用目录只允许一份机器人进程**（见 ADR-0064）。
   *
   * ⚠️ **自检进程（`--check`）不参与这把锁**：它只是「跑一遍加载、看看能不能起来」，
   * 从来就不是第二个服务进程。真机踩过（0.27.1 的自检被自己拦下）：旧进程还活着（它没有锁，
   * 因为它是更早的版本启动的），自检进程一进来就抢锁 → 被拒 → **退出码 1**，
   * 于是「自检 JSON 明明写着 ok:true、退出码却是 1」→ 重启被取消、**健康的新构建被回滚**，
   * 版本再也升不上去。所以这里用 `isStartupCheck()` 短路掉抢锁。
   */
  const instanceLock = isStartupCheck()
    ? { ok: true as const }
    : acquireInstanceLock({ version: runningVersionOf() });
  if (!instanceLock.ok) {
    log.error("duplicate bot instance detected: refusing to start", {
      pid: process.pid,
      holderPid: instanceLock.holder.pid,
      holderStartedAt: instanceLock.holder.startedAt,
      holderVersion: instanceLock.holder.version,
      hint: "同一个应用目录只能跑一份：ps -ef | grep dist/main.js 只留一行",
    });
    writeDuplicateEvidence({
      holder: instanceLock.holder,
      pid: process.pid,
    });
    process.exitCode = 1;
    await closeLogging();
    return;
  }

  const persistence = await connectPersistence(settings);
  /**
   * `/restart` 的落点（在 `shutdown` 定义好之前先占位）：
   * 命令层只调用 `runtime.restart.request(...)`，真正退出由这里的优雅关闭负责。
   */
  let restartHandler: RestartRequestHandler | undefined;
  /**
   * 统一计时调度器（`SCAN_INTERVAL_MS` 驱动全部周期任务）。
   *
   * 它比 `runtime` **晚创建**（假模式直接 return、压根不建），而管理 API 的监听口在
   * `runtime` 里就起好了 —— 所以这里只放一个可空引用，`/api/tasks` 进来时现取。
   */
  let schedulerRef: TickScheduler | undefined;
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
    fingerprint: () => distFingerprint(),
    ...(bootFingerprint !== undefined ? { bootFingerprint } : {}),
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
      // 周期任务监测（管理 API `/api/tasks`）：调度器在下面才创建，所以这里传「取值函数」，
      // 请求进来时现取（见 `RuntimeDependencies.tickTasks`）。
      tickTasks: () => schedulerRef?.snapshot(),
      // 整份持久化对象直接透传：RuntimeRepositories 是它的结构化子集。
      // 逐个列举键会漏 —— 0.23.0 就这么漏过 privacy 与 adminTokens（`/data` 与 `/admin login`
      // 在真机上直接报「未装配」）；现在装配只发生在 createRepositories() 一处。
      ...(persistence
        ? { repositories: toRuntimeRepositories(persistence) }
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
    // 管理 API 的监听口是在上面起的（假模式也允许，方便本地排查）：这里必须先把它关掉。
    // 否则监听口会把事件循环留住、进程不退出，而接下来 `persistence.close()` 已经把库关了 ——
    // 症状就是「/healthz 正常，任何要读库的接口都 500 `database is not open`」。
    await adminApiHost?.close();
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
  schedulerRef = scheduler;
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
  // 入群申请**对账**：按绑定群拉一次官方待审批列表，把「官方已不再返回」的本地待审批
  // 标记过期 —— 别人在群管理后台 / 其它机器人处理掉的申请不会一直挂在 /pending 里
  // （真机报过：点「通过」收到 `400 申请已经被处理`，那条却没被自动删除）。
  scheduler.register({
    name: "join-reconcile",
    minIntervalMs: () => runtime.platform.get("joinSyncIntervalMs"),
    enabled: () =>
      runtime.platform.get("joinSyncIntervalMs") > 0 &&
      runtime.health.isAvailable("join"),
    run: async () => {
      for (const group of runtime.identityMap.listGroups()) {
        try {
          await runtime.joinSync.syncGroup(group.officialId);
        } catch (error) {
          // 单群失败（限流 / 未开审核 / 网络）不打断其它群，也不刷 error
          log.debug("join reconcile skipped", {
            groupId: group.officialId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  });
  // 定时发言（TODO §2 的 P0）：总开关关着就整条跳过（任务保留，只是不触发）；
  // 精度 = 扫描周期（最小 1 分钟），够 cron 的分钟粒度用。
  scheduler.register({
    name: "scheduled-announce",
    enabled: () => runtime.platform.get("scheduledAnnounceEnabled"),
    run: async () => {
      await runtime.scheduledAnnouncements.runOnce();
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
    // 放开单实例锁：下一份进程（自我重启助手拉起的）才能顺利接管
    releaseInstanceLock();
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
   *
   * 同一时刻只允许一条流程在跑（单飞闸，见 `runRestartFlow`）—— 手动重启与部署自动重启
   * 是两条独立入口，可能撞车。
   */
  let restartFlowInFlight = false;

  restartHandler = (info) => {
    void runRestartFlow(info).catch((error: unknown) => {
      // 兜底：流程里任何意料之外的错误都不能变成 unhandled rejection（这里原本是裸 `void`）。
      const detail = error instanceof Error ? error.message : String(error);
      log.error("restart flow failed", {
        requestedBy: info.requestedBy,
        reason: info.reason ?? "manual",
        error: detail,
      });
      deployWatcher.blockVersion(info.targetVersion ?? onDiskVersion(), detail);
      void announceRestartAbort(info, detail);
    });
  };

  /**
   * 单飞闸：**同一时刻只允许一条重启流程在跑**。
   *
   * 手动 `/restart`（指令层）与部署监测的自动重启是两条独立入口，都会被 `restartHandler`
   * 接住，可能撞在同一时刻 —— 真机报过「手动重启后又自己重启一次」。第二条直接放行掉，
   * 免得拉起两个 `scripts/respawn.mjs`、写出两条重启回执、把进程拉起两次。
   *
   * 闸门只在**没走成**时复位（自检没过 / 助手起不来）：真排好了重启就一直关着 ——
   * 旧进程还要两三秒才退出，这段时间再来一条请求就是「第二次重启」。
   * 手动重试因此不受影响（那些路径都会把闸门放开）。
   */
  async function runRestartFlow(info: RestartRequestInfo): Promise<void> {
    if (restartFlowInFlight) {
      log.warn("restart request ignored: another restart flow is running", {
        requestedBy: info.requestedBy,
        reason: info.reason ?? "manual",
        targetVersion: info.targetVersion ?? onDiskVersion(),
      });
      return;
    }
    restartFlowInFlight = true;
    try {
      if (!(await runRestartFlowOnce(info))) {
        restartFlowInFlight = false;
      }
    } catch (error) {
      restartFlowInFlight = false;
      throw error;
    }
  }

  /** 跑一条重启流程；返回 `true` = 已经排好重启（进程即将退出），`false` = 没走成。 */
  async function runRestartFlowOnce(info: RestartRequestInfo): Promise<boolean> {
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
        // 这两份「别重试同一个坏版本」的记忆**只作用于自动重试**：
        // `failedVersions` 供卡片/诊断显示，`deployWatcher.blockVersion` 让部署监测不再反复试。
        // **手动重试（含失败卡上的「重新检查并重启」）不查它们** —— 人在看着结果点，
        // 想试几次试几次（用户明确要求；`restartCard` 的文案也这么写）。
        failedVersions.markFailed(targetVersion, reason, info.reason ?? "manual");
        deployWatcher.blockVersion(targetVersion, reason);
        await notifyPreflightFailed(
          runtime,
          info,
          reason,
          restore,
          preflight.summary,
        );
        return false;
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
      // 助手没拉起来 = 这次重启**没有发生**（旧进程还在跑）：说清原因、别让部署监测
      // 再赌同一个版本，然后如实回报「没走成」（闸门放开，手动重试不受影响）。
      const detail = `重启助手启动失败：${respawn.detail}`;
      log.error("restart aborted: respawn helper not started", {
        requestedBy: info.requestedBy,
        reason: info.reason ?? "manual",
        detail,
      });
      deployWatcher.blockVersion(targetVersion, detail);
      await announceRestartAbort(info, detail);
      return false;
    }
    // 助手已经起来了 = 这次重启**已经安排上**：回写部署监测，同一个目标版本别再排第二轮
    // （手动 `/restart` 也走这里 —— 真机报过「手动重启后又自己重启一次」）。
    deployWatcher.markScheduled(targetVersion);
    writeRestartNotice({
      userId: info.requestedBy,
      requestedAt: new Date().toISOString(),
      // **重启前的运行版本**（不是磁盘版本）：部署重启时磁盘已经是新版本了，
      // 用 `appVersion()` 会让回执写成「vX → vX」，看不出到底换了什么。
      version: runningVersionOf(),
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
        // 助手在启动阶段就报错 → 撤销退出：这次重启没有发生（旧进程还在跑）。
        // 别让部署监测再赌同一个版本，也必须告诉等这次重启的人。
        log.error("restart aborted: respawn helper errored before exit", {
          requestedBy: info.requestedBy,
          detail: respawn.detail,
        });
        deployWatcher.blockVersion(targetVersion, respawn.detail);
        restartFlowInFlight = false;
        void announceRestartAbort(info, respawn.detail);
        return;
      }
      void shutdown();
    }, RESTART_EXIT_DELAY_MS);
    return true;
  }

  /**
   * 「这次重启没走成」的通知：助手没起来 / 起来后立刻报错 → **旧进程没有退出**。
   *
   * 不告诉一声的话，发起人只会以为「已经重启了」（命令行回执早发出去了），
   * 自动部署那条尤其糟：`requestedBy` 是 `deploy-watcher` 占位符（不是真实用户），
   * 私信过去没人收得到 —— 所以 `reason=deploy` 时改发全部全局超管。
   */
  async function announceRestartAbort(
    info: RestartRequestInfo,
    detail: string,
  ): Promise<void> {
    if (info.reason !== "deploy") {
      await notifyRestartAborted(runtime, info.requestedBy, detail);
      return;
    }
    const targetVersion = info.targetVersion ?? onDiskVersion();
    const card = renderCard({
      title: "自动重启没成功",
      lines: [
        `**新版本**：v${targetVersion}（服务器上已就绪）`,
        "**自动重启失败了**：机器人仍在运行旧版本，这个版本**不会再自动重试**。",
        `**原因**：${detail.length > 0 ? detail : "未知（详见启动日志）"}`,
        "",
        "可以在服务器上手动重启，或检查启动日志 / `data/restart-failed.json`。",
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
    for (const userId of runtime.permissions.listSuperAdmins()) {
      const result = await runtime.notifications.sendPrivateCard(userId, card);
      if (!result.ok) {
        log.warn("restart-aborted notice not delivered", {
          userId,
          detail: result.detail,
        });
      }
    }
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
 * 卡上给四个出口 + `data/startup-check.json` 的原文（内联一段，「自检结果」按钮给全文）。
 *
 * 卡片本身在 `restartNotice.ts`（纯函数，可单测）；这里只负责发给谁、投递失败只记日志。
 */
async function notifyPreflightFailed(
  runtime: Runtime,
  info: RestartRequestInfo,
  reason: string,
  restore: { ok: boolean; detail: string },
  summary?: Record<string, unknown>,
): Promise<void> {
  const card = preflightFailedCard({
    targetVersion: info.targetVersion ?? onDiskVersion(),
    reason,
    restore,
    ...(summary !== undefined ? { summary } : {}),
  });
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
    // 真机上这条曾经误导过一次：明明配了 SQLITE_PATH，却报「没有数据库」——
    // 真实原因是生产装配漏传了 adminTokens 仓储。所以这里必须把**实际原因**写清楚。
    log.warn("管理 API 已开启但拿不到令牌仓储，跳过监听口", {
      databaseDriver: source.databaseDriver,
      hint:
        source.databaseDriver === "memory"
          ? "当前是内存模式（DATABASE_URL=memory / SQLITE_PATH=:memory:）：没有令牌表，签发与兑换都无处落库；改回 SQLite 文件或 PostgreSQL 后重启。"
          : "数据库是持久化的，却拿到 undefined 的令牌仓储 —— 这是装配 bug（process 内没接上 adminTokens），请带着这行日志提 issue。",
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
      hint: describeListenFailure({
        error,
        host: source.config.host,
        port: source.config.port,
        who: "in-process",
      }),
    });
    return undefined;
  }
}
