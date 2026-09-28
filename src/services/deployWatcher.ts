import {
  SystemScheduler,
  type Scheduler,
} from "../adapters/reconnectingWebSocketGateway.js";
import { encodeCallback } from "./callbackData.js";
import { renderCard, type CardButton } from "./cardTemplate.js";
import { getLogger } from "../core/logger.js";
import { formatDisplayTime } from "../core/timeFormat.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("deploy-watcher");

/** 自动重启时写进重启回执的「发起人」占位（不是真实用户）。 */
export const DEPLOY_RESTART_ACTOR = "deploy-watcher";

/** 连续多少轮读到同一新版本才认定「上传完成」（默认 3 轮 × 扫描间隔）。 */
export const DEFAULT_DEPLOY_STABLE_CHECKS = 3;

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
  enabled: boolean;
  /** 扫描间隔；`<= 0` = 关闭监测。 */
  checkIntervalMs: number;
  /** 宽限期（毫秒）：通知后等这么久再自动重启；`0` = 立即。 */
  delayMs: number;
  stableChecks?: number;
  runningVersion: () => string;
  onDiskVersion: () => string;
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
 * 行为：
 * - 稳定窗口通过 → 私信全部全局超管一张卡：「当前 → 新版本，计划 X 后自动重启」+ 「取消自动重启 / 立即重启」；
 * - 宽限期内没人取消 → 走既有自我重启路径（`requestRestart`，reason=`deploy`）；
 * - 取消后**同一目标版本不再提醒**（版本再变才重新提醒）；
 * - 磁盘版本回落（撤回部署）或读到 `unknown` → 清除待重启状态；
 * - 自动重启没被受理（自我重启助手起不来）→ 保留待重启状态、延后 5 分钟重试并通知超管。
 *
 * 驱动方式：暴露 `runOnce()`，**意图是由统一扫描周期（`TickScheduler`）驱动**；
 * `start()/stop()` 只是过渡期的独立定时器（本地 `DEPLOY_CHECK_INTERVAL_MS`）。
 */
export class DeployWatcher implements DeployControl {
  private readonly enabled: boolean;
  private readonly checkIntervalMs: number;
  private readonly delayMs: number;
  private readonly stableChecks: number;
  private readonly runningVersion: () => string;
  private readonly onDiskVersion: () => string;
  private readonly recipients: () => readonly string[];
  private readonly notify: (userId: string, card: RichMessage) => Promise<void>;
  private readonly requestRestart: DeployWatcherOptions["requestRestart"];
  private readonly scheduler: Scheduler;
  private readonly clock: () => number;
  /** 连续稳定计数：同一个新版本连着读到几轮。 */
  private streakVersion: string | undefined;
  private streak = 0;
  private pendingState: DeployPending | undefined;
  /** 用户取消过的目标版本（同一个不再提醒）。 */
  private cancelledVersion: string | undefined;
  private timer: unknown;
  private running = false;

  public constructor(options: DeployWatcherOptions) {
    this.enabled = options.enabled && options.checkIntervalMs > 0;
    this.checkIntervalMs = options.checkIntervalMs;
    this.delayMs = Math.max(0, options.delayMs);
    this.stableChecks = Math.max(1, options.stableChecks ?? DEFAULT_DEPLOY_STABLE_CHECKS);
    this.runningVersion = options.runningVersion;
    this.onDiskVersion = options.onDiskVersion;
    this.recipients = options.recipients;
    this.notify = options.notify;
    this.requestRestart = options.requestRestart;
    this.scheduler = options.scheduler ?? new SystemScheduler();
    this.clock = options.clock ?? Date.now;
  }

  public pending(): DeployPending | undefined {
    return this.pendingState;
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
    if (!this.enabled) {
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
      this.pendingState = undefined;
      this.streakVersion = undefined;
      this.streak = 0;
      return;
    }

    if (target !== this.streakVersion) {
      this.streakVersion = target;
      this.streak = 1;
      return;
    }
    this.streak += 1;

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
      deadlineAt: new Date(now + this.delayMs).toISOString(),
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
    if (this.running || !this.enabled) {
      log.info("deploy watcher disabled", { enabled: this.enabled });
      return;
    }
    this.running = true;
    this.scheduleNext();
    log.info("deploy watcher started", {
      checkIntervalMs: this.checkIntervalMs,
      delayMinutes: Math.round(this.delayMs / 60_000),
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
      this.pendingState = undefined;
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
    }, this.checkIntervalMs);
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
