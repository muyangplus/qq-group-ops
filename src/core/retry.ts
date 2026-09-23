import { getLogger } from "./logger.js";

const log = getLogger("retry");

export type SleepFn = (delayMs: number) => Promise<void>;

export const defaultSleep: SleepFn = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: SleepFn;
  /** 覆盖某次失败的延迟（例如限流时使用更长的冷却时间）。 */
  delayFor?: (error: unknown, attempt: number) => number | undefined;
  /** 返回 false 时立即抛出，不再重试。 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (info: RetryAttemptInfo) => void;
  label?: string;
}

/**
 * 带指数退避与抖动的重试。
 *
 * 抖动避免多个实例在同一时刻同步重试；`delayFor` 允许对限流等特殊错误
 * 使用固定的冷却时间，而不是常规的指数退避。
 */
export async function retryWithBackoff<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) {
        throw error;
      }
      const delay = resolveDelay(attempt, error);
      options.onRetry?.({ attempt, delayMs: delay, error });
      log.debug("retrying", {
        label: options.label,
        attempt,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }

  function resolveDelay(attempt: number, error: unknown): number {
    const override = options.delayFor?.(error, attempt);
    if (override !== undefined) {
      return override;
    }
    const raw = Math.min(maxDelayMs, initialDelayMs * factor ** (attempt - 1));
    const jitter = raw * jitterRatio * (random() * 2 - 1);
    return Math.max(0, Math.round(raw + jitter));
  }
}
