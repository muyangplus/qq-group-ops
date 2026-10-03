import {
  SystemScheduler,
  type Scheduler,
} from "../adapters/reconnectingWebSocketGateway.js";
import { encodeCallback } from "./callbackData.js";
import { renderCard, type CardButton } from "./cardTemplate.js";
import { getLogger } from "../core/logger.js";
import { valueOf, type Provider } from "../core/provider.js";
import { formatDisplayTime } from "../core/timeFormat.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("deploy-watcher");

/** 自动重启时写进重启回执的「发起人」占位（不是真实用户）。 */
export const DEPLOY_RESTART_ACTOR = "deploy-watcher";

/**
 * 连续多少轮读到同一新版本才算「新版本」。
 *
 * **默认 1 = 检测到就提醒**：FTP 逐文件上传没有「传完」信号，但通知之后还有宽限期
 * （`DEPLOY_RESTART_DELAY_MINUTES`，默认 10 分钟）兜着 —— 上传还没完就点「取消自动重启」即可，
 * 没必要靠连续几轮来猜（那只是把提醒往后拖）。
 */
export const DEFAULT_DEPLOY_STABLE_CHECKS = 1;

export interface DeployPending {
  /** 磁盘上的新版本（部署目标）。 */
  targetVersion: string;
  /** 当前进程正在运行的版本。 */
  currentVersion: string;
  /** 通过稳定窗口、开始计时的时刻（ISO）。 */
  detectedAt: string;
  /** 计划自动重启的时刻（ISO）。 */
  deadlineAt: string;
}

/** 命令层用得到的控制面（`/`按钮 取消 / 立即重启）。 */
export interface DeployControl {
  pending(): DeployPending | undefined;
  /** 取消本次自动重启（同一目标版本不再提醒）。 */
  cancel(): boolean;
  /** 立即重启（不等宽限期）。 */
  restartNow(): boolean;
}

export interface DeployWatcherOptions {
  /** 总开关（`AUTO_RESTART_ON_DEPLOY`）。 */
  enabled: Provider<boolean>;
  /** 扫描间隔；`<= 0` = 关闭监测。 */
  checkIntervalMs: Provider<number>;
  /** 宽限期（毫秒）：通知后等这么久再自动重启；`0` = 立即。 */
  delayMs: Provider<number>;
  stableChecks?: number;
  runningVersion: () => string;
  onDiskVersion: () => string;
  /**
   * 当前 `dist/` 的构建指纹（`core/buildInfo.ts` 的 `distFingerprint`）。
   *
   * 传了就启用「**产物内容真的变了**才算新部署」的判据：版本号变了但指纹没变 → 说明这份进程
   * 已经跑着最新代码（典型场景是它在「新代码已落地、`package.json` 还没落地」的上传窗口里启动过），
   * 此时**不再排一次重启**。不传 / 指纹读不到 → 退回纯版本号判据。
   */
  fingerprint?: (() => string | undefined) | undefined;
  /** 进程启动时的构建指纹；缺省 = 构造时取一次（`main.ts` 会在同一处显式传入）。 */
  bootFingerprint?: string | undefined;
  /** 收件人（全部全局超管）。 */
  recipients: () => readonly string[];
  /** 私信投递。 */
  notify: (userId: string, card: RichMessage) => Promise<void>;
  /** 安排重启；返回是否受理。 */
  requestRestart: (info: {
    requestedBy: string;
    reason: "deploy";
    targetVersion: string;
  }) => boolean;
  scheduler?: Scheduler;
  clock?: () => number;
}

/**
 * 部署监测（P0）：**新版本已推送成功**时通知超管，并在一段宽限期后自动重启。
 *
 * 为什么这样判断：CD 是 FTP 逐文件上传，没有「传完」的信号；所以用「磁盘 `package.json`
 * 的版本 ≠ 进程启动时固化的版本」作为信号，并要求**连续 N 轮稳定**才认定上传完成
 * （压掉传到一半就当新版的窗口）。
 *
 * 判据补充（0.23.3）：版本号只是「CD 跑过」的标记，**是否值得重启要看产物内容** ——
 * 进程可能在「新代码已落地、`package.json` 还没落地」的窗口里启动过，那种情况下它已经跑着
 * 最新代码，可随后落地的版本号仍会被当成新部署，宽限期到点就白跳一次重启。所以传了
 * `fingerprint` 时，指纹没变就不再排重启（真机报「一次部署跳两次」即此）。
 *
 * 行为：
 * - 稳定窗口通过 → 私信全部全局超管一张卡：「当前 → 新版本，计划 X 后自动重启」+ 「取消自动重启 / 立即重启」；
 * - 宽限期内没人取消 → 走既有自我重启路径（`requestRestart`，reason=`deploy`）；
 * - 取消后**同一目标版本不再提醒**（版本再变才重新提醒）；
 * - **受理过重启的目标版本不再排第二轮**（`markScheduled`；手动 `/restart` 也会回写它，
 *   免得「手动重启」与「部署自动重启」撞成两次）；
 * - 磁盘版本回落（撤回部署）或读到 `unknown` → 清除待重启状态（含「已受理」记忆）；
 * - **自动重启没被受理**（`requestRestart` 返回 `false`，例如重启钩子没装配）→ 保留待重启状态、
 *   延后 5 分钟重试并通知超管；**受理之后**助手才失败（起不来 / 起来就报错）→ 由 `main.ts`
 *   拦掉同一目标版本并通知超管，不再走这条重试。
 *
 * 驱动方式：暴露 `runOnce()`，**意图是由统一扫描周期（`TickScheduler`）驱动**；
 * `start()/stop()` 只是过渡期的独立定时器（本地 `DEPLOY_CHECK_INTERVAL_MS`）。
 */
export class DeployWatcher implements DeployControl {
  private readonly enabledProvider: Provider<boolean>;
  private readonly checkIntervalMs: Provider<number>;
  private readonly delayMs: Provider<number>;
  private readonly stableChecks: number;
  private readonly runningVersion: () => string;
  private readonly onDiskVersion: () => string;
  private readonly fingerprint: (() => string | undefined) | undefined;
  /** 进程启动时的构建指纹（本进程加载的就是这份产物）。 */
  private readonly bootFingerprint: string | undefined;
  private readonly recipients: () => readonly string[];
  private readonly notify: (userId: string, card: RichMessage) => Promise<void>;
  private readonly requestRestart: DeployWatcherOptions["requestRestart"];
  private readonly scheduler: Scheduler;
  private readonly clock: () => number;
  /** 连续稳定计数：同一个新版本连着读到几轮。 */
  private streakVersion: string | undefined;
  private streak = 0;
  private pendingState: DeployPending | undefined;
  /** 已经受理过重启（含手动 `/restart`）的目标版本（同一个不再提醒、不再排第二轮）。 */
  private scheduledVersion: string | undefined;
  /** 用户取消过的目标版本（同一个不再提醒）。 */
  private cancelledVersion: string | undefined;
  /** 已经判定为「版本号变了但构建没变」的目标版本（免得每轮都记一条日志）。 */
  private matchedVersion: string | undefined;
  private timer: unknown;
  private running = false;

  public constructor(options: DeployWatcherOptions) {
    // 热配置：这三项都在用的时候取当前值（`/config` 改完立即生效）
    this.enabledProvider = options.enabled;
    this.checkIntervalMs = options.checkIntervalMs;
    this.delayMs = () => Math.max(0, valueOf(options.delayMs));
    this.stableChecks = Math.max(1, options.stableChecks ?? DEFAULT_DEPLOY_STABLE_CHECKS);
    this.runningVersion = options.runningVersion;
    this.onDiskVersion = options.onDiskVersion;
    this.fingerprint = options.fingerprint;
    this.bootFingerprint =
      options.bootFingerprint ?? options.fingerprint?.();
    this.recipients = options.recipients;
    this.notify = options.notify;
    this.requestRestart = options.requestRestart;
    this.scheduler = options.scheduler ?? new SystemScheduler();
    this.clock = options.clock ?? Date.now;
  }

  public pending(): DeployPending | undefined {
    return this.pendingState;
  }

  /**
   * 记录「这个目标版本的重启已经受理」：**同一目标版本不再提醒、不再排第二轮**。
   *
   * 为什么必须记：受理 ≠ 旧进程已经退出。自检 + 拉起 `scripts/respawn.mjs` + 等新进程起来的
   * 窗口有好几秒，而统一扫描周期一直在跑 —— 不记住「这个版本已经安排过了」，同一个目标版本
   * 会被再当成一次新部署（真机报过「一次部署通知两次、机器人改版两次」，间隔 5s）。
   *
   * 手动 `/restart` 也会回写这里：手动重启已经安排上了，部署监测不该再排一轮
   * （真机报过「手动重启后又自己重启一次」）。
   *
   * 记忆在「磁盘版本回落 / 已重启到目标版本」时随 `resetStreak()` 一起清掉 ——
   * 撤回部署后再重新上传同一个版本，仍会重新给机会。
   */
  public markScheduled(targetVersion: string): void {
    if (this.scheduledVersion === targetVersion) {
      return;
    }
    this.scheduledVersion = targetVersion;
    if (this.pendingState?.targetVersion === targetVersion) {
      this.pendingState = undefined;
    }
    log.info("deploy restart armed, same target version will not be re-scheduled", {
      targetVersion,
    });
  }

  /**
   * 把某个目标版本按「已取消」处理（自检不过时用）。
   *
   * 与用户点「取消自动重启」同一套语义：**同一目标版本不再提醒、不再自动重启**
   * （版本再变才重新给机会）。旧进程没退出，所以这份记忆一直有效。
   */
  public blockVersion(targetVersion: string, reason: string): void {
    this.cancelledVersion = targetVersion;
    if (this.pendingState?.targetVersion === targetVersion) {
      this.pendingState = undefined;
    }
    log.warn("deploy target blocked after failed preflight", {
      targetVersion,
      reason,
    });
  }

  public cancel(): boolean {
    if (!this.pendingState) {
      return false;
    }
    this.cancelledVersion = this.pendingState.targetVersion;
    this.pendingState = undefined;
    log.info("deploy auto-restart cancelled", {
      targetVersion: this.cancelledVersion,
    });
    return true;
  }

  public restartNow(): boolean {
    if (!this.pendingState) {
      return false;
    }
    return this.fireRestart(this.pendingState, "manual-now");
  }

  /** 扫一轮：判断「是否有稳定的新版本」，并在到点时自动重启。 */
  public async runOnce(): Promise<void> {
    if (!this.active()) {
      return;
    }
    const target = this.onDiskVersion();
    const current = this.runningVersion();

    // 读不到（unknown）或磁盘版本追平运行版本（撤回部署 / 已重启完）→ 清状态
    if (target === "unknown" || target === current) {
      if (this.pendingState) {
        log.info("deploy pending cleared (disk version back to running)", {
          target,
          current,
        });
      }
      this.resetStreak();
      return;
    }

    // 这个目标版本的重启已经受理过了（旧进程还在退出窗口里）→ 同一版本不再提醒、不再排第二轮。
    if (this.scheduledVersion === target) {
      return;
    }

    // 版本号变了：再确认**产物内容**是不是真的变了。没变 → 这份进程已经跑着最新代码，
    // 不该为一次「上传窗口里启动」白跳一次重启（见 options.fingerprint 的说明）。
    if (this.buildUnchanged()) {
      if (this.matchedVersion !== target) {
        this.matchedVersion = target;
        log.info("version changed but build unchanged, no restart needed", {
          current,
          target,
        });
      }
      this.resetStreak();
      return;
    }

    // 目标版本变了：重新计数；`stableChecks <= 1` 时**本轮就提醒**（不再等下一轮）
    if (target !== this.streakVersion) {
      this.streakVersion = target;
      this.streak = 1;
      if (this.stableChecks > 1) {
        return;
      }
    } else {
      this.streak += 1;
    }

    if (this.pendingState?.targetVersion === target) {
      if (this.clock() >= Date.parse(this.pendingState.deadlineAt)) {
        this.fireRestart(this.pendingState, "deadline");
      }
      return;
    }
    if (this.cancelledVersion === target) {
      return;
    }
    if (this.streak < this.stableChecks) {
      return;
    }

    const now = this.clock();
    const detectedAt = new Date(now).toISOString();
    const pending: DeployPending = {
      targetVersion: target,
      currentVersion: current,
      detectedAt,
      deadlineAt: new Date(now + valueOf(this.delayMs)).toISOString(),
    };
    this.pendingState = pending;
    log.info("new deploy detected, auto-restart scheduled", {
      current,
      target,
      deadlineAt: pending.deadlineAt,
      stableChecks: this.streak,
    });
    await this.broadcast(this.noticeCard(pending));
  }

  /** 过渡期的独立定时器；将来由 `TickScheduler` 调 `runOnce()` 即可去掉。 */
  public start(): void {
    if (this.running || !this.active()) {
      log.info("deploy watcher disabled", { enabled: valueOf(this.enabledProvider) });
      return;
    }
    this.running = true;
    this.scheduleNext();
    log.info("deploy watcher started", {
      checkIntervalMs: valueOf(this.checkIntervalMs),
      delayMinutes: Math.round(valueOf(this.delayMs) / 60_000),
    });
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 通知卡：说清「发生了什么 / 什么时候重启 / 你能做什么」。 */
  public noticeCard(pending: DeployPending): RichMessage {
    const rows: CardButton[][] = [
      [
        callbackButton("cancel", "取消自动重启", encodeCallback("deploy", "cancel")),
        callbackButton("now", "立即重启", encodeCallback("deploy", "now")),
      ],
      [callbackButton("proc", "进程状态", encodeCallback("status", "proc"))],
    ];
    return renderCard({
      title: "发现新版本",
      lines: [
        `**服务器上**：v${pending.targetVersion}（已就绪）`,
        `**当前运行**：v${pending.currentVersion}`,
        `**自动重启**：${formatDisplayTime(new Date(pending.deadlineAt))}`,
        "",
        "到点会自动重启加载新版本；重启期间机器人约几秒不可用，重启完成后会私信你一条回执。",
        "想改期就点「取消自动重启」（同一版本不会再提醒），想马上生效就点「立即重启」。",
      ],
      rows,
    });
  }

  private fireRestart(pending: DeployPending, trigger: string): boolean {
    const accepted = this.requestRestart({
      requestedBy: DEPLOY_RESTART_ACTOR,
      reason: "deploy",
      targetVersion: pending.targetVersion,
    });
    if (accepted) {
      log.warn("deploy auto-restart triggered", {
        trigger,
        current: pending.currentVersion,
        target: pending.targetVersion,
      });
      this.markScheduled(pending.targetVersion);
      return true;
    }
    // 没受理（例如自我重启助手起不来）：保留状态、延后 5 分钟重试，并通知超管
    const retryAt = new Date(this.clock() + 5 * 60_000).toISOString();
    this.pendingState = { ...pending, deadlineAt: retryAt };
    log.error("deploy auto-restart rejected, retry scheduled", { trigger, retryAt });
    void this.broadcast(
      renderCard({
        title: "自动重启没成功",
        lines: [
          `**新版本**：v${pending.targetVersion}（服务器上已就绪）`,
          "**自动重启失败了**：机器人仍在运行旧版本，会在 5 分钟后重试。",
          "可以点下面的「立即重启」手动重试，或检查启动日志 / `data/restart-failed.json`。",
        ],
        rows: [
          [
            callbackButton("now", "立即重启", encodeCallback("deploy", "now")),
            callbackButton("proc", "进程状态", encodeCallback("status", "proc")),
          ],
        ],
      }),
    );
    return false;
  }

  private async broadcast(card: RichMessage): Promise<void> {
    const recipients = this.recipients();
    if (recipients.length === 0) {
      log.warn("no super admin to notify about new deploy", {
        card: card.text.split("\n")[0],
      });
      return;
    }
    for (const userId of recipients) {
      try {
        await this.notify(userId, card);
      } catch (error) {
        log.warn("deploy notice delivery failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private scheduleNext(): void {
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((error: unknown) => {
          log.error("deploy watcher run failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNext();
          }
        });
    }, valueOf(this.checkIntervalMs));
  }

  /** 当前是否生效：开关为真且检查周期为正（热配置，随时可能变）。 */
  private active(): boolean {
    return valueOf(this.enabledProvider) && valueOf(this.checkIntervalMs) > 0;
  }

  /** 清掉待重启状态与稳定计数（「没有新东西可加载」时统一走这里）。 */
  private resetStreak(): void {
    this.pendingState = undefined;
    // 「已经安排过重启」的记忆也清掉：磁盘版本回落（撤回部署）后重新上传同一版本要重新给机会。
    this.scheduledVersion = undefined;
    this.streakVersion = undefined;
    this.streak = 0;
  }

  /**
   * `dist/` 内容与启动时一致 → 没有新代码可加载。
   *
   * 判据不可用（没传 `fingerprint`、`dist/` 读不到、或启动时就没取到指纹）时返回 `false`，
   * 即**退回版本号判据**：宁可按老口径多提醒一次，也不能因为拿不到指纹就漏掉真部署。
   */
  private buildUnchanged(): boolean {
    if (!this.fingerprint || this.bootFingerprint === undefined) {
      return false;
    }
    const now = this.fingerprint();
    return now !== undefined && now === this.bootFingerprint;
  }
}

/** 回调按钮（本地小工具，避免服务层依赖命令层）。 */
function callbackButton(
  id: string,
  label: string,
  callbackData: string,
): CardButton {
  return { id, label, callbackData };
}
