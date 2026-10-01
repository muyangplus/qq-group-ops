/**
 * 滑窗限流（E1-a）：管理 API 用它在**会话级**限制请求速率，超限返回 429。
 *
 * 令牌令牌桶那套更适合"排队等令牌"（活动通知），管理面要的是"直接拒绝"，所以这里用
 * 固定窗口计数：内存里记每个键最近的请求时间，窗口内超过上限就拒。
 * 重启即清零——对管理面足够（真正的防线是令牌一次性 + 短 TTL + 网络隔离）。
 */
export interface WindowRateLimiterOptions {
  /** 每个窗口允许的请求数；`0` = 不限。 */
  limitPerWindow: number;
  windowMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class WindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  public constructor(options: WindowRateLimiterOptions) {
    this.limit = options.limitPerWindow;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 消耗一个配额；返回 false 表示超限。 */
  public allow(key: string): boolean {
    if (this.limit <= 0) {
      return true;
    }
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }

  /** 某个键当前窗口内已用次数（测试与日志用）。 */
  public used(key: string): number {
    const cutoff = this.now() - this.windowMs;
    return (this.hits.get(key) ?? []).filter((at) => at > cutoff).length;
  }
}
