import { getLogger } from "../core/logger.js";
import { utcNow } from "../core/models.js";
import type {
  ActivityNotification,
  ActivityNotificationKind,
  ActivityNotificationRepository,
} from "../db/activityNotificationRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { renderCard } from "./cardTemplate.js";
import { NOTIFY_SCOPE_ALL, type NotificationService } from "./notifications.js";
import { PushService } from "./pushService.js";
import type { RichMessage, RichMessageSender } from "./richMessages.js";

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

/** 群卡片广播（满员卡）的结果。 */
export interface ActivityGroupBroadcastResult {
  /** 是否装配了群消息发送通道；false 时其余字段无意义。 */
  available: boolean;
  /** 本次实际发出的群数量。 */
  sent: number;
  /** 之前已经发过、因此跳过的群数量。 */
  skipped: number;
  /** 发送失败的群数量（只记日志）。 */
  failed: number;
  /** 本次目标群数量。 */
  recipients: number;
  /** 本次实际发出的群 ID（便于回执里列出「成功 / 失败」）。 */
  groups: string[];
}

export interface ActivityNotifyOptions {
  /** 每人每日上限；`0` = 不限制（默认 3）。 */
  dailyLimit?: number;
  /** 令牌桶速率（条/秒）；`0` = 不限制。默认 0，由 runtime 按配置传入。 */
  ratePerSecond?: number;
  now?: () => Date;
  /**
   * 群消息发送器（§B4 满员广播用）。
   *
   * 这是**群消息**不是私信，因此不占用户的每日私信额度；未装配时不做群广播
   * （调用方按「没装配就跳过」处理，不影响报名本身）。
   */
  groupSender?: RichMessageSender | undefined;
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
  private readonly sent = new Map<string, ActivityNotification>();
  private readonly notificationRepository: ActivityNotificationRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly dailyLimit: number;
  private readonly now: () => Date;
  private readonly groupSender: RichMessageSender | undefined;
  /** 统一推送骨架（去重 + 每日封顶 + 记录）。 */
  private readonly push: PushService<ActivityNotification>;

  public constructor(
    private readonly sender: NotificationService,
    notifications?: ActivityNotificationRepository,
    options: ActivityNotifyOptions = {},
  ) {
    this.notificationRepository = notifications;
    this.queue = notifications ? new WriteQueue() : undefined;
    this.dailyLimit = normalizeDailyLimit(options.dailyLimit);
    this.now = options.now ?? (() => utcNow());
    this.groupSender = options.groupSender;
    this.push = new PushService({
      store: {
        has: (key) => this.sent.has(key),
        countSince: (userId, since) => this.countSince(userId, since),
        record: (_key, entry) => this.record(entry),
      },
      now: this.now,
      label: "activity notification",
      dailyLimit: this.dailyLimit,
      rateLimitPerSecond: options.ratePerSecond ?? 0,
    });
  }

  public get persistent(): boolean {
    return this.notificationRepository !== undefined;
  }

  public get dailyNotifyLimit(): number {
    return this.dailyLimit;
  }

  public async load(): Promise<void> {
    const notifications = await this.notificationRepository?.findAll();
    this.sent.clear();
    for (const entry of notifications ?? []) {
      this.sent.set(notificationKey(entry), entry);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public isSubscribed(groupId: string, userId: string): boolean {
    return this.sender.isSubscribed(userId, groupId, "activity");
  }

  public subscribe(groupId: string, userId: string): void {
    this.sender.subscribe(userId, groupId, "activity");
  }

  /** 返回是否真的取消了（本来就未订阅时返回 false）。 */
  public unsubscribe(groupId: string, userId: string): boolean {
    return this.sender.unsubscribe(userId, groupId, "activity");
  }

  /** 某用户订阅的全部群（排序，便于展示与测试）。 */
  public listSubscribedGroups(userId: string): string[] {
    return this.sender
      .listScopes(userId, "activity")
      .filter((scope) => scope !== NOTIFY_SCOPE_ALL);
  }

  /** 订阅了该群（或全部群）的成员（排序，保证推送顺序稳定）。 */
  public subscribersOf(groupId: string): string[] {
    return this.sender.subscribersFor(groupId, "activity");
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

  /**
   * 群卡片广播（§B4 满员卡）：给每个群发**同一条群消息**，每个群只发一次。
   *
   * - 不占用户的每日私信额度（群消息不是私信），但**共用同一张去重表**：
   *   键是 `(activityId, "group:<groupId>", kind)`；
   * - `kind` 由调用方决定（默认 `full`），`received` 是本次实际发出的群数量，
   *   `skipped` 是已经发过的群数量；
   * - 没有装配群发送通道时返回 `available: false`，由调用方降级（不报错）。
   */
  public async notifyGroupsCard(input: {
    activityId: string;
    groupIds: readonly string[];
    card: RichMessage;
    kind?: ActivityNotificationKind;
  }): Promise<ActivityGroupBroadcastResult> {
    const kind = input.kind ?? "full";
    const groups = [...new Set(input.groupIds)].sort();
    const result: ActivityGroupBroadcastResult = {
      available: this.groupSender !== undefined,
      sent: 0,
      skipped: 0,
      failed: 0,
      recipients: groups.length,
      groups: [],
    };
    const sender = this.groupSender;
    if (!sender) {
      log.warn("activity group broadcast skipped: no group sender", {
        activityId: input.activityId,
        kind,
      });
      return result;
    }
    for (const groupId of groups) {
      // 群消息的「接收者」是伪用户 `group:<群ID>`：与真实用户 ID 不冲突，
      // 且不会进入某个用户的每日计数（`countSince` 按 user_id 过滤）。
      const target = groupTargetId(groupId);
      if (this.sent.has(notificationKey({ activityId: input.activityId, userId: target, kind }))) {
        result.skipped += 1;
        continue;
      }
      const sent = await sender.sendToGroup(groupId, input.card);
      if (!sent.ok) {
        log.warn("activity group broadcast failed", {
          activityId: input.activityId,
          groupId,
          kind,
          error: sent.detail,
        });
        result.failed += 1;
        continue;
      }
      this.record({ activityId: input.activityId, userId: target, kind, createdAt: this.now() });
      result.sent += 1;
      result.groups.push(groupId);
    }
    log.info("activity group broadcast finished", {
      activityId: input.activityId,
      kind,
      ...result,
    });
    return result;
  }

  /** 某条群卡片是否已经发过（不产生写入，供调用方判断）。 */
  public isGroupCardSent(
    activityId: string,
    groupId: string,
    kind: ActivityNotificationKind = "full",
  ): boolean {
    return this.sent.has(
      notificationKey({ activityId, userId: groupTargetId(groupId), kind }),
    );
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
    const outcome = await this.push.deliver({
      key: notificationKey({ activityId, userId, kind }),
      userId,
      fields: { activityId, kind },
      send: () => this.sender.sendPrivateCard(userId, message),
      entry: (now) => ({ activityId, userId, kind, createdAt: now }),
    });
    return {
      delivered: outcome.status === "sent",
      skipped: outcome.status === "skipped" || outcome.status === "rateLimited",
      rateLimited: outcome.status === "rateLimited",
    };
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
}

const NOTIFY_TITLES: Record<ActivityNotificationKind, string> = {
  published: "新活动",
  changed: "活动有变更",
  cancelled: "活动已取消",
  promoted: "候补递补成功",
  full: "活动已满",
  remind: "活动提醒",
};

function normalizeDailyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 3;
  }
  const parsed = Math.trunc(value);
  return parsed >= 0 ? parsed : 3;
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

/**
 * 群消息广播的伪接收者 ID。
 *
 * `activity_notifications` 的主键是 `(activity_id, user_id, kind)`，群消息没有用户；
 * 用 `group:<群ID>` 占位既能复用同一张去重表，也不会与真实用户 ID 撞键
 * （官方 openid 不含 `:`）。
 */
function groupTargetId(groupId: string): string {
  return `group:${groupId}`;
}
