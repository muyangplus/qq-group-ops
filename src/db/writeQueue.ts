import { getLogger } from "../core/logger.js";

const log = getLogger("write-queue");

/**
 * 顺序写穿透队列。
 *
 * 持久化服务采用「内存为准 + 写穿透」：
 * - 读路径保持同步，不阻塞事件处理；
 * - 写路径进入本队列，按入队顺序串行落库；
 * - `flush()` 等待当前所有排队写入完成，用于「回复用户前确保已落库」和优雅退出；
 * - 单个写入失败只记录日志并计数，不会中断后续写入，也不会抛出未处理异常。
 */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private failureCount = 0;
  private lastFailure: string | undefined;

  public enqueue(label: string, task: () => Promise<void>): void {
    this.pendingCount += 1;
    this.tail = this.tail.then(async () => {
      try {
        await task();
      } catch (error) {
        this.failureCount += 1;
        this.lastFailure = `${label}: ${formatError(error)}`;
        log.error("persistence write failed", {
          label,
          error: formatError(error),
        });
      } finally {
        this.pendingCount -= 1;
      }
    });
  }

  /** 等待当前排队的写入完成；期间新入队的任务也会被等待。 */
  public async flush(): Promise<void> {
    let current = this.tail;
    while (true) {
      await current;
      if (current === this.tail) {
        return;
      }
      current = this.tail;
    }
  }

  public get pending(): number {
    return this.pendingCount;
  }

  public get failures(): number {
    return this.failureCount;
  }

  public get lastError(): string | undefined {
    return this.lastFailure;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
