import { defaultSleep, retryWithBackoff, type SleepFn } from "../core/retry.js";
import { isRateLimitedError } from "./qqOfficialError.js";

export interface SendThrottleOptions {
  /** 两次发送之间的最小间隔，避免短时间连发触发 22009。 */
  minIntervalMs?: number;
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** 命中限流后的固定冷却时间。 */
  rateLimitDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: SleepFn;
  isRateLimited?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  now?: () => number;
}

export const DEFAULT_SEND_MIN_INTERVAL_MS = 400;
export const DEFAULT_SEND_RATE_LIMIT_DELAY_MS = 5_000;

/**
 * 出站消息节流器。
 *
 * 官方对被动的群聊/单聊回复有频控（单聊同一 msg_id 最多回复 5 次，群聊有效期 5 分钟，
 * 超频返回 22009）。这里把所有出站消息串行化并强制最小间隔，命中限流后再退避重试，
 * 避免业务侧无意中的连发把配额打满。
 */
export class SendThrottle {
  private chain: Promise<void> = Promise.resolve();
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly rateLimitDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly sleep: SleepFn;
  private readonly isRateLimited: (error: unknown) => boolean;
  private readonly onRetry: SendThrottleOptions["onRetry"];
  private readonly now: () => number;

  public constructor(options: SendThrottleOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_SEND_MIN_INTERVAL_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 10_000;
    this.rateLimitDelayMs =
      options.rateLimitDelayMs ?? DEFAULT_SEND_RATE_LIMIT_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.isRateLimited = options.isRateLimited ?? isRateLimitedError;
    this.onRetry = options.onRetry;
    this.now = options.now ?? Date.now;
  }

  /** 串行执行一次发送；同一时刻只有一个发送在途。 */
  public run<T>(label: string, task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => this.execute(label, task));
    // 保证单个任务失败不会阻断后续任务。
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async execute<T>(label: string, task: () => Promise<T>): Promise<T> {
    const gap = this.minIntervalMs - (this.now() - this.lastStartedAt);
    if (gap > 0) {
      await this.sleep(gap);
    }
    this.lastStartedAt = this.now();
    return retryWithBackoff(task, {
      maxAttempts: this.maxAttempts,
      initialDelayMs: this.initialRetryDelayMs,
      maxDelayMs: this.maxRetryDelayMs,
      jitterRatio: this.jitterRatio,
      random: this.random,
      sleep: this.sleep,
      label: `send:${label}`,
      delayFor: (error) =>
        this.isRateLimited(error) ? this.rateLimitDelayMs : undefined,
      ...(this.onRetry ? { onRetry: this.onRetry } : {}),
    });
  }
}
