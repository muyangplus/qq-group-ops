import {
  SystemScheduler,
  type Scheduler,
} from "../adapters/reconnectingWebSocketGateway.js";
import type { Provider } from "../core/provider.js";
import { valueOf } from "../core/provider.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("tick-scheduler");

/**
 * 一个周期任务。
 *
 * 约定：任务只实现 `run(now)`，**不再自己持有定时器** —— 什么时候跑由统一扫描周期决定；
 * 任务自己的节拍用 `minIntervalMs` 声明（缺省 = 每轮都跑）。
 */
export interface TickTask {
  /** 任务名（日志与排错用，要求唯一且稳定）。 */
  name: string;
  /** 跑一轮。抛错由调度器兜住（只记日志，不影响其它任务）。 */
  run(now: number): Promise<void> | void;
  /** 自己的最小间隔（毫秒）：距上次执行不足这个值就跳过；缺省 / `<= 0` = 每轮都跑。可传取值函数。 */
  minIntervalMs?: Provider<number>;
  /** 启动时那一次「立即扫描」是否也跑（缺省 true）；`false` = 等一个周期再上场。 */
  runOnStart?: boolean;
  /**
   * 依赖的模块是否可用（层 2 闸门）：返回 `false` 时整轮跳过，且**不更新 `lastRun`**，
   * 模块恢复后会立刻补跑（不因为降级期间的空转而把节拍推到下一个周期）。
   */
  enabled?: () => boolean;
}

export interface TickSchedulerOptions {
  /** **统一扫描周期**（毫秒）；`<= 0` = 关闭所有周期任务（统一总开关）。可传取值函数（热配置）。 */
  intervalMs: Provider<number>;
  scheduler?: Scheduler;
  clock?: () => number;
  onError?: (task: string, error: unknown) => void;
}

/**
 * 统一计时任务调度器：**全项目只跑一个定时器**。
 *
 * 设计要点（用户口径：一个扫描周期配置驱动所有周期检查）：
 * - 固定节拍：每 `intervalMs` 触发一轮扫描，不管上一轮是否跑完；
 * - **overrun 保护**：上一轮还没跑完时，这一轮**跳过**（记 warn），不排队、不叠加；
 * - **串行执行**：一轮里的任务按注册顺序依次跑（避免同时打数据库）；
 * - **错误隔离**：单个任务抛错只记日志，后续任务照常跑；
 * - **统一开关**：`intervalMs <= 0` 时不启动（retention / 提醒 / 申诉轮转 / 部署监测全部停）。
 *
 * 与旧实现的差别只在「谁来驱动」：各任务的频率语义（retention 24h、提醒 1 分钟、
 * 申诉轮转 `APPEAL_FORWARD_INTERVAL_MS`）原样保留，只是改成由本调度器判断是否到点。
 */
export class TickScheduler {
  private readonly tasks: TickTask[] = [];
  /** 任务名 → 上次执行时刻（`minIntervalMs` 判断用）。 */
  private readonly lastRun = new Map<string, number>();
  /** `runOnStart: false` 的任务：把「启动时那一次」跳过一次。 */
  private readonly skipNext = new Set<string>();
  private readonly intervalMs: Provider<number>;
  private readonly scheduler: Scheduler;
  private readonly clock: () => number;
  private readonly onError: (task: string, error: unknown) => void;
  private timer: unknown;
  private running = false;
  private inFlight: Promise<void> | undefined;

  public constructor(options: TickSchedulerOptions) {
    this.intervalMs = options.intervalMs;
    this.scheduler = options.scheduler ?? new SystemScheduler();
    this.clock = options.clock ?? Date.now;
    this.onError =
      options.onError ??
      ((task, error) => {
        log.error("tick task failed", {
          task,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  public register(task: TickTask): void {
    this.tasks.push(task);
    if (task.runOnStart === false) {
      this.skipNext.add(task.name);
    }
  }

  public get taskNames(): string[] {
    return this.tasks.map((task) => task.name);
  }

  public get started(): boolean {
    return this.running;
  }

  /**
   * 扫一轮（启动时先手动调用一次，也用于测试）。
   *
   * 到期判断：`lastRun` 不存在（从没跑过）→ 跑；否则 `now - lastRun >= minIntervalMs` 才跑。
   * `runOnStart: false` 的任务会在这里被跳过**一次**，并把 `lastRun` 置为当前时刻（等一个周期再上场）。
   */
  public async runOnce(): Promise<void> {
    const now = this.clock();
    for (const task of this.tasks) {
      // 依赖的模块降级时整轮跳过：不执行、也不更新 `lastRun`（恢复后立刻补跑）
      if (task.enabled && !task.enabled()) {
        continue;
      }
      if (this.skipNext.delete(task.name)) {
        this.lastRun.set(task.name, now);
        continue;
      }
      const last = this.lastRun.get(task.name);
      const min = valueOf(task.minIntervalMs ?? 0);
      if (last !== undefined && min > 0 && now - last < min) {
        continue;
      }
      this.lastRun.set(task.name, now);
      try {
        await task.run(now);
      } catch (error) {
        this.onError(task.name, error);
      }
    }
  }

  public start(): void {
    if (this.running) {
      return;
    }
    if (valueOf(this.intervalMs) <= 0) {
      log.info("tick scheduler disabled (intervalMs <= 0)");
      return;
    }
    this.running = true;
    this.scheduleNext();
    log.info("tick scheduler started", {
      intervalMs: valueOf(this.intervalMs),
      tasks: this.taskNames,
    });
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 按**当前**周期重启节拍（`SCAN_INTERVAL_MS` 热改后用）：
   * 改成 `0` 就停下，从 `0` 改成正数就重新跑起来。
   */
  public restart(): void {
    this.stop();
    this.start();
  }

  /** 固定节拍：到点就跑一轮；上一轮没跑完就跳过这一轮（overrun 保护）。 */
  private scheduleNext(): void {
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      if (!this.running) {
        return;
      }
      this.tick();
      if (this.running) {
        this.scheduleNext();
      }
    }, valueOf(this.intervalMs));
  }

  private tick(): void {
    if (this.inFlight) {
      log.warn("tick skipped: previous round still running", {
        intervalMs: valueOf(this.intervalMs),
        tasks: this.taskNames,
      });
      return;
    }
    this.inFlight = this.runOnce().finally(() => {
      this.inFlight = undefined;
    });
  }
}
