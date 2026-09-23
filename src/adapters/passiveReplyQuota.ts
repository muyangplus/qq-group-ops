export const DEFAULT_MAX_PASSIVE_REPLIES = 5;
export const DEFAULT_PASSIVE_REPLY_WINDOW_MS = 5 * 60 * 1_000;
export const DEFAULT_PASSIVE_REPLY_CACHE_SIZE = 1_000;

export interface PassiveReplyQuotaOptions {
  /** 同一个 msg_id 最多被动回复几次，官方单聊限制为 5。 */
  maxRepliesPerMessage?: number;
  /** 被动回复有效期，官方群聊为 5 分钟。 */
  windowMs?: number;
  /** 最多保留多少条 msg_id 记录，避免内存无限增长。 */
  cacheSize?: number;
  clock?: () => number;
}

export type PassiveReplyDenyReason = "count" | "expired";

export interface PassiveReplyDecision {
  allowed: boolean;
  reason?: PassiveReplyDenyReason;
  used: number;
  remaining: number;
}

interface Entry {
  count: number;
  firstAt: number;
}

/**
 * 被动回复配额。
 *
 * 官方限制：单聊同一 `msg_id` 最多被动回复 5 次；群聊被动回复有效期为 5 分钟。
 * 超过后继续回复会失败（22009），因此这里在发送前拦截，避免无效请求打满频控。
 */
export class PassiveReplyQuota {
  private readonly entries = new Map<string, Entry>();
  private readonly maxReplies: number;
  private readonly windowMs: number;
  private readonly cacheSize: number;
  private readonly clock: () => number;

  public constructor(options: PassiveReplyQuotaOptions = {}) {
    this.maxReplies = options.maxRepliesPerMessage ?? DEFAULT_MAX_PASSIVE_REPLIES;
    this.windowMs = options.windowMs ?? DEFAULT_PASSIVE_REPLY_WINDOW_MS;
    this.cacheSize = options.cacheSize ?? DEFAULT_PASSIVE_REPLY_CACHE_SIZE;
    this.clock = options.clock ?? Date.now;
  }

  public check(messageId: string): PassiveReplyDecision {
    const entry = this.entries.get(messageId);
    if (!entry) {
      return { allowed: true, used: 0, remaining: this.maxReplies };
    }
    const used = this.isExpired(entry) ? this.maxReplies : entry.count;
    if (used >= this.maxReplies) {
      return {
        allowed: false,
        reason: this.isExpired(entry) ? "expired" : "count",
        used,
        remaining: 0,
      };
    }
    return { allowed: true, used, remaining: this.maxReplies - used };
  }

  public record(messageId: string): void {
    const now = this.clock();
    const entry = this.entries.get(messageId);
    if (!entry || this.isExpired(entry)) {
      this.entries.set(messageId, { count: 1, firstAt: now });
    } else {
      entry.count += 1;
    }
    this.evictIfNeeded();
  }

  public usage(messageId: string): number {
    return this.check(messageId).used;
  }

  public get size(): number {
    return this.entries.size;
  }

  private isExpired(entry: Entry): boolean {
    return this.clock() - entry.firstAt >= this.windowMs;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.cacheSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
