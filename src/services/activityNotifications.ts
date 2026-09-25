import { getLogger } from "../core/logger.js";
import { utcNow } from "../core/models.js";
import type {
  ActivityNotification,
  ActivityNotificationKind,
  ActivityNotificationRepository,
} from "../db/activityNotificationRepository.js";
import type {
  ActivitySubscription,
  ActivitySubscriptionRepository,
} from "../db/activitySubscriptionRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { renderCard } from "./cardTemplate.js";
import type { NotificationService } from "./notifications.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("activity-notifications");

export type { ActivityNotificationKind };

export interface ActivityNotifyResult {
  /** 实际送达条数。 */
  sent: number;
  /** 因去重或每日封顶被跳过的条数。 */
  skipped: number;
  /** 发送失败的条数（只记日志，不抛错）。 */
  failed: number;
  /** 本次的目标接收者数量（订阅者 / 当事人）。 */
  recipients: number;
  /** 因每日上限跳过的接收者（便于排查「为什么没收到」）。 */
  rateLimited: number;
}

export interface ActivityNotifyOptions {
  /** 每人每日上限；`0` = 不限制（默认 3）。 */
  dailyLimit?: number;
  now?: () => Date;
}

/**
 * 活动通知：**按群订阅 + 私信推送**。
 *
 * 用户确认的真机事实（不要推翻）：
 * - 主动私信有限额：单用户每天 1000 条、单关系 20 qpm、未认证机器人 5 qps & 30 qpm，
 *   且用户可在客户端关闭「允许主动发送」；
 * - 群里「@全体成员」做不到（5 种写法全部不生效）。
 *
 * 因此这里的策略是：
 * 1. **只发给订阅者 / 当事人**（不群发、不假装能 @全体）；
 * 2. **去重**：以 `(activity_id, user_id, kind)` 为键，同一活动同一类型只打扰一次，
 *    事件重投、重复点按钮、进程重启都不会重复推送（去重行由 `load()` 恢复）；
 * 3. **每人每天封顶**：超过 `dailyLimit`（默认 3，`0` = 不限制）就跳过并记 warn 日志；
 * 4. **失败只记日志**：私信失败（没私聊过机器人 / 关闭了主动消息 / 被限流）不影响活动本身。
 */
export class ActivityNotificationService {
  private readonly subscriptions = new Map<string, Map<string, ActivitySubscription>>();
  private readonly sent = new Map<string, ActivityNotification>();
  private readonly subscriptionRepository: ActivitySubscriptionRepository | undefined;
  private readonly notificationRepository: ActivityNotificationRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly dailyLimit: number;
  private readonly now: () => Date;

  public constructor(
    private readonly sender: NotificationService,
    subscriptions?: ActivitySubscriptionRepository,
    notifications?: ActivityNotificationRepository,
    options: ActivityNotifyOptions = {},
  ) {
    this.subscriptionRepository = subscriptions;
    this.notificationRepository = notifications;
    this.queue = subscriptions || notifications ? new WriteQueue() : undefined;
    this.dailyLimit = normalizeDailyLimit(options.dailyLimit);
    this.now = options.now ?? (() => utcNow());
  }

  public get persistent(): boolean {
    return (
      this.subscriptionRepository !== undefined ||
      this.notificationRepository !== undefined
    );
  }

  public get dailyNotifyLimit(): number {
    return this.dailyLimit;
  }

  public async load(): Promise<void> {
    const [subscriptions, notifications] = await Promise.all([
      this.subscriptionRepository?.findAll() ?? Promise.resolve([]),
      this.notificationRepository?.findAll() ?? Promise.resolve([]),
    ]);
    this.subscriptions.clear();
    for (const entry of subscriptions) {
      this.addSubscription(entry);
    }
    this.sent.clear();
    for (const entry of notifications) {
      this.sent.set(notificationKey(entry), entry);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public isSubscribed(groupId: string, userId: string): boolean {
    return this.subscriptions.get(groupId)?.has(userId) ?? false;
  }

  public subscribe(groupId: string, userId: string): void {
    if (this.isSubscribed(groupId, userId)) {
      return;
    }
    const entry: ActivitySubscription = {
      groupId,
      userId,
      createdAt: this.now(),
    };
    this.addSubscription(entry);
    const repository = this.subscriptionRepository;
    if (repository) {
      this.queue?.enqueue("activity.subscription.save", () =>
        repository.save(entry),
      );
    }
    log.info("activity notification subscribed", { groupId, userId });
  }

  /** 返回是否真的取消了（本来就未订阅时返回 false）。 */
  public unsubscribe(groupId: string, userId: string): boolean {
    const bucket = this.subscriptions.get(groupId);
    if (!bucket?.delete(userId)) {
      return false;
    }
    if (bucket.size === 0) {
      this.subscriptions.delete(groupId);
    }
    const repository = this.subscriptionRepository;
    if (repository) {
      this.queue?.enqueue("activity.subscription.remove", () =>
        repository.remove(groupId, userId),
      );
    }
    log.info("activity notification unsubscribed", { groupId, userId });
    return true;
  }

  /** 某用户订阅的全部群（排序，便于展示与测试）。 */
  public listSubscribedGroups(userId: string): string[] {
    const groups: string[] = [];
    for (const [groupId, bucket] of this.subscriptions) {
      if (bucket.has(userId)) {
        groups.push(groupId);
      }
    }
    return groups.sort();
  }

  /** 订阅了该群的成员（排序，保证推送顺序稳定）。 */
  public subscribersOf(groupId: string): string[] {
    return [...(this.subscriptions.get(groupId)?.keys() ?? [])].sort();
  }

  /** 发布新活动：给该群**所有订阅者**私信活动卡。 */
  public async publishNewActivity(input: {
    activityId: string;
    groupId: string;
    card: RichMessage;
  }): Promise<ActivityNotifyResult> {
    const recipients = this.subscribersOf(input.groupId);
    const result = emptyResult(recipients.length);
    for (const userId of recipients) {
      tally(
        result,
        await this.deliver(input.activityId, userId, "published", input.card),
      );
    }
    log.info("activity publish push finished", {
      activityId: input.activityId,
      groupId: input.groupId,
      ...result,
    });
    return result;
  }

  /**
   * 给当事人（已报名 / 候补）私信。
   *
   * `rich` 缺省时按 `kind` 生成一张说明卡片（正文就是 `text`）。
   */
  public async notifyParticipants(input: {
    activityId: string;
    userIds: readonly string[];
    kind: ActivityNotificationKind;
    text: string;
    rich?: RichMessage | undefined;
    title?: string | undefined;
  }): Promise<ActivityNotifyResult> {
    const recipients = [...new Set(input.userIds)].sort();
    const result = emptyResult(recipients.length);
    if (recipients.length === 0) {
      return result;
    }
    const card =
      input.rich ??
      renderCard({
        title: input.title ?? NOTIFY_TITLES[input.kind],
        lines: input.text.split("\n"),
        footer: [
          "本消息由活动通知自动发出；如需减少打扰请联系活动管理者。",
        ],
      });
    for (const userId of recipients) {
      tally(
        result,
        await this.deliver(input.activityId, userId, input.kind, card),
      );
    }
    log.info("activity participants push finished", {
      activityId: input.activityId,
      kind: input.kind,
      ...result,
    });
    return result;
  }

  /** 删除早于 cutoff 的去重记录（由保留策略调用），返回内存里清掉的条数。 */
  public async pruneOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.sent) {
      if (entry.createdAt < cutoff) {
        this.sent.delete(key);
        removed += 1;
      }
    }
    const repository = this.notificationRepository;
    if (removed > 0 && repository) {
      this.queue?.enqueue("activity.notification.prune", () =>
        repository.deleteOlderThan(cutoff),
      );
    }
    return removed;
  }

  /**
   * 统一投递入口（去重 → 每日封顶 → 发送 → 记去重行）。
   *
   * 任何一步失败都只记日志，不抛错：活动本身的状态已经在调用方改好了，
   * 通知只是尽力而为（用户确认的落点）。
   */
  private async deliver(
    activityId: string,
    userId: string,
    kind: ActivityNotificationKind,
    message: RichMessage,
  ): Promise<{ delivered: boolean; skipped: boolean; rateLimited: boolean }> {
    const key = notificationKey({ activityId, userId, kind });
    if (this.sent.has(key)) {
      log.debug("activity notification deduplicated", { activityId, userId, kind });
      return { delivered: false, skipped: true, rateLimited: false };
    }
    if (this.dailyLimit > 0) {
      const count = this.countSince(userId, startOfToday(this.now()));
      if (count >= this.dailyLimit) {
        log.warn("activity notification skipped: daily limit reached", {
          activityId,
          userId,
          kind,
          limit: this.dailyLimit,
          count,
        });
        return { delivered: false, skipped: true, rateLimited: true };
      }
    }
    const sent = await this.sender.sendPrivateCard(userId, message);
    if (!sent.ok) {
      log.warn("activity notification delivery failed", {
        activityId,
        userId,
        kind,
        error: sent.detail,
      });
      return { delivered: false, skipped: false, rateLimited: false };
    }
    this.record({ activityId, userId, kind, createdAt: this.now() });
    return { delivered: true, skipped: false, rateLimited: false };
  }

  /** 当日已发条数（内存为准：`load()` 会把历史去重行读回来）。 */
  private countSince(userId: string, since: Date): number {
    let count = 0;
    for (const entry of this.sent.values()) {
      if (entry.userId === userId && entry.createdAt >= since) {
        count += 1;
      }
    }
    return count;
  }

  private record(entry: ActivityNotification): void {
    this.sent.set(notificationKey(entry), entry);
    const repository = this.notificationRepository;
    if (repository) {
      this.queue?.enqueue("activity.notification.save", () =>
        repository.save(entry),
      );
    }
  }

  private addSubscription(entry: ActivitySubscription): void {
    const bucket =
      this.subscriptions.get(entry.groupId) ??
      new Map<string, ActivitySubscription>();
    bucket.set(entry.userId, entry);
    this.subscriptions.set(entry.groupId, bucket);
  }
}

const NOTIFY_TITLES: Record<ActivityNotificationKind, string> = {
  published: "新活动",
  changed: "活动有变更",
  cancelled: "活动已取消",
  promoted: "候补递补成功",
};

function normalizeDailyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 3;
  }
  const parsed = Math.trunc(value);
  return parsed >= 0 ? parsed : 3;
}

/** 本地时区的「今天 0 点」。 */
function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function emptyResult(recipients: number): ActivityNotifyResult {
  return { sent: 0, skipped: 0, failed: 0, recipients, rateLimited: 0 };
}

function tally(
  result: ActivityNotifyResult,
  outcome: { delivered: boolean; skipped: boolean; rateLimited: boolean },
): void {
  if (outcome.delivered) {
    result.sent += 1;
  } else if (outcome.skipped) {
    result.skipped += 1;
    if (outcome.rateLimited) {
      result.rateLimited += 1;
    }
  } else {
    result.failed += 1;
  }
}

function notificationKey(input: {
  activityId: string;
  userId: string;
  kind: string;
}): string {
  return `${input.activityId}\u0000${input.userId}\u0000${input.kind}`;
}
