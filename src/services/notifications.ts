import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { NotificationDeliveryStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import { utcNow } from "../core/models.js";
import type {
  NotificationDelivery,
  NotificationDeliveryRepository,
  NotificationSubscription,
  NotificationSubscriptionRepository,
} from "../db/notificationRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { DisplayNameService } from "./displayNames.js";
import type { IdentityMapService } from "./identityMap.js";
import {
  buildJoinRequestCard,
  type JoinRequestCard,
  type JoinRequestCardInput,
  type JoinRequestDecision,
} from "./joinRequestCard.js";
import { renderCard } from "./cardTemplate.js";
import { RichMessageSender, type RichMessage } from "./richMessages.js";
import {
  evaluateConfiguredJoinRules,
  type JoinRuleEvaluator,
} from "./joinRules.js";
import type { PermissionService } from "./permissions.js";
import {
  emptySummary,
  PushService,
  tallySummary,
  type PushSummary,
} from "./pushService.js";

const log = getLogger("notifications");

/** 订阅范围：`__all__` 表示「我担任审核员的所有群」，否则是 group_openid。 */
export const NOTIFY_SCOPE_ALL = "__all__";

/**
 * 推送频道：
 * - `join`：入群申请待审批推送（原 `/notify`）；
 * - `punish`：机器人处罚事件 + 申诉推送（§B7/B8，`/notify punish` 独立开关）。
 *
 * 两个频道共用 `notification_subscriptions` 表，存储时给 `punish` 加 `punish:` 前缀，
 * 因此老数据天然属于 `join` 频道，无需迁移。
 */
export type NotifyChannel = "join" | "punish";

const channelPrefix = (channel: NotifyChannel): string => `${channel}:`;

/** 业务 scope → 存储 scope。 */
function storageScope(channel: NotifyChannel, scope: string): string {
  return channel === "join" ? scope : `${channelPrefix(channel)}${scope}`;
}

/** 存储 scope → 业务 scope；不属于该频道时返回 undefined。 */
function businessScope(
  channel: NotifyChannel,
  stored: string,
): string | undefined {
  if (channel === "join") {
    return stored.startsWith(channelPrefix("punish")) ? undefined : stored;
  }
  const prefix = channelPrefix(channel);
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : undefined;
}

export interface JoinRequestPush {
  groupId: string;
  requestId: string;
  userId: string;
  reason: string;
  /** 申请人昵称（官方 `username`）。 */
  applicantName?: string | undefined;
  /** 管理员问答的题目，仅用于展示。 */
  questions?: readonly string[] | undefined;
  /** 处理结果：默认 `manual`（待审核，带按钮）；自动处理时只通知结果。 */
  decision?: JoinRequestDecision | undefined;
}

export interface NotificationPushResult {
  sent: number;
  failed: number;
  skipped: number;
  /** 本次推送的接收者数量（已订阅且有审批权限）。 */
  recipients: number;
}

export interface NotificationTestResult {
  ok: boolean;
  text: string;
}

export interface NotificationServiceOptions {
  subscriptions?: NotificationSubscriptionRepository | undefined;
  deliveries?: NotificationDeliveryRepository | undefined;
  queue?: WriteQueue | undefined;
  identityMap?: IdentityMapService | undefined;
  /** 展示名解析（群号/QQ号/短码）；缺省时回退到绑定号或内部 id。 */
  display?: DisplayNameService | undefined;
  /** 用于在卡片里附带审核意见。 */
  configStore?: GroupConfigStore | undefined;
  joinRules?: JoinRuleEvaluator | undefined;
  /** 自定义富消息发送器；缺省时用 api 现建一个。 */
  sender?: RichMessageSender | undefined;
  now?: (() => Date) | undefined;
}

/**
 * 入群申请推送。
 *
 * - 审核员用 `/notify` 订阅「全部群」或某个群；订阅持久化到数据库；
 * - 有新的待审批入群申请时，推送给「订阅了该群 + 在当前群有审批权限」的人；
 * - 卡片是 Markdown + 指令按钮（同意 / 拒绝），自定义按钮未开通时自动降级为
 *   纯 Markdown、再降级为纯文本；
 * - 同一 (群, 申请, 用户) 只推送一次，重启后也不会重复推送。
 */
export class NotificationService {
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly deliveries = new Map<string, NotificationDelivery>();
  private readonly subscriptionRepository: NotificationSubscriptionRepository | undefined;
  private readonly deliveryRepository: NotificationDeliveryRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly identityMap: IdentityMapService | undefined;
  private readonly display: DisplayNameService | undefined;
  private readonly configStore: GroupConfigStore | undefined;
  private readonly joinRules: JoinRuleEvaluator | undefined;
  private readonly now: () => Date;
  /** 富消息发送器（Markdown + 按钮 + 三级降级），与活动卡片共用。 */
  private readonly sender: RichMessageSender;
  /** 统一推送骨架（去重 + 记录；失败也记录，避免重复重试刷屏）。 */
  private readonly push: PushService<NotificationDelivery>;

  public constructor(
    private readonly api: QQOfficialAPI,
    private readonly permissions: PermissionService,
    options: NotificationServiceOptions = {},
  ) {
    this.subscriptionRepository = options.subscriptions;
    this.deliveryRepository = options.deliveries;
    this.queue =
      options.subscriptions || options.deliveries
        ? (options.queue ?? new WriteQueue())
        : undefined;
    this.identityMap = options.identityMap;
    this.display = options.display;
    this.configStore = options.configStore;
    this.joinRules = options.joinRules;
    this.now = options.now ?? (() => utcNow());
    this.sender = options.sender ?? new RichMessageSender(api);
    this.push = new PushService({
      store: {
        has: (key) => this.deliveries.has(key),
        countSince: () => 0,
        record: (_key, entry) => this.recordDelivery(entry),
      },
      now: this.now,
      label: "notification",
      recordOnFailure: true,
    });
  }

  public get keyboardAvailable(): boolean {
    return this.sender.keyboardAvailable;
  }

  /** 指定目标是否还能用自定义按钮（私信卡片判据：群键盘被拒不该连累私信）。 */
  public keyboardAvailableFor(target: "user" | "group"): boolean {
    return this.sender.keyboardAvailableFor(target);
  }

  /**
   * 暴露富消息发送器（Markdown + 按钮 + 三级降级）。
   *
   * 与活动卡片共用同一条发送通道，避免同一进程里出现两个键盘降级状态
   * （一个被平台拒绝、另一个还在重试）。
   */
  public get richMessageSender(): RichMessageSender {
    return this.sender;
  }

  /**
   * 主动私信发一张任意卡片（`/whois` 这类**隐私结果**只走私信，不走群聊）。
   *
   * 返回 `ok=false` 时 `detail` 是失败原因（例如用户没和机器人私聊过、未开启主动消息）。
   */
  public async sendPrivateCard(
    userId: string,
    message: RichMessage,
  ): Promise<{ ok: boolean; detail: string }> {
    const result = await this.sender.sendToUser(userId, message);
    if (result.ok) {
      return { ok: true, detail: result.detail };
    }
    log.warn("private card delivery failed", {
      userId,
      error: result.detail,
    });
    return { ok: false, detail: result.detail };
  }

  public async load(): Promise<void> {
    const subscriptions = await this.subscriptionRepository?.findAll();
    this.subscriptions.clear();
    for (const subscription of subscriptions ?? []) {
      this.addScope(subscription);
    }
    const deliveries = await this.deliveryRepository?.findAll();
    this.deliveries.clear();
    for (const delivery of deliveries ?? []) {
      this.deliveries.set(deliveryKey(delivery), delivery);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public isSubscribed(
    userId: string,
    scope: string,
    channel: NotifyChannel = "join",
  ): boolean {
    return (
      this.subscriptions.get(userId)?.has(storageScope(channel, scope)) ?? false
    );
  }

  public listScopes(userId: string, channel: NotifyChannel = "join"): string[] {
    const result: string[] = [];
    for (const stored of this.subscriptions.get(userId) ?? []) {
      const scope = businessScope(channel, stored);
      if (scope !== undefined) {
        result.push(scope);
      }
    }
    return result.sort();
  }

  public subscribe(
    userId: string,
    scope: string,
    channel: NotifyChannel = "join",
  ): void {
    const scopes = this.scopesFor(userId, true);
    const stored = storageScope(channel, scope);
    if (scopes.has(stored)) {
      return;
    }
    scopes.add(stored);
    this.subscriptionRepository &&
      this.queue?.enqueue("notification.subscription.save", () =>
        this.subscriptionRepository!.save({ userId, scope: stored }),
      );
    log.info("notification subscribed", { userId, scope: stored });
  }

  public unsubscribe(
    userId: string,
    scope: string,
    channel: NotifyChannel = "join",
  ): boolean {
    const scopes = this.subscriptions.get(userId);
    if (!scopes?.delete(storageScope(channel, scope))) {
      return false;
    }
    if (scopes.size === 0) {
      this.subscriptions.delete(userId);
    }
    this.subscriptionRepository &&
      this.queue?.enqueue("notification.subscription.remove", () =>
        this.subscriptionRepository!.remove(
          userId,
          storageScope(channel, scope),
        ),
      );
    log.info("notification unsubscribed", {
      userId,
      scope: storageScope(channel, scope),
    });
    return true;
  }

  /**
   * 订阅了该群（或全部群）且有对应权限的接收者。
   *
   * - `join` 频道要求入群审批权限（群管理员或以上）；
   * - `punish` 频道要求内容审核权限（审核员或以上）。
   */
  public subscribersFor(
    groupId: string,
    channel: NotifyChannel = "join",
  ): string[] {
    const recipients: string[] = [];
    const wanted = storageScope(channel, groupId);
    const all = storageScope(channel, NOTIFY_SCOPE_ALL);
    for (const [userId, scopes] of this.subscriptions) {
      if (!scopes.has(all) && !scopes.has(wanted)) {
        continue;
      }
      const allowed =
        channel === "join"
          ? this.permissions.canApproveJoin(userId, groupId)
          : this.permissions.canReviewContent(userId, groupId);
      if (!allowed) {
        continue;
      }
      recipients.push(userId);
    }
    return recipients.sort();
  }

  /**
   * 给某个频道的订阅者逐个私信一张卡片（§B7/B8 复用）。
   *
   * - 每人每 key 只投一次（`dedupeId` 写进投递记录的 `request_id` 字段，重启后仍去重）；
   * - 失败也记录，避免反复重试刷屏；
   * - `cardFor(recipientId)` 让每张卡片能带**只允许该接收者点击**的按钮。
   */
  public async pushToSubscribers(input: {
    groupId: string;
    channel: NotifyChannel;
    /** 去重 id，建议带频道前缀，例如 `punish:#ABC123`。 */
    dedupeId: string;
    /** 只推给这些人（缺省 = 该群该频道的全部订阅者；用于「值班轮转」只推一人）。 */
    recipients?: readonly string[] | undefined;
    cardFor: (recipientId: string) => RichMessage;
  }): Promise<PushSummary> {
    const recipients = input.recipients ?? this.subscribersFor(input.groupId, input.channel);
    const summary = emptySummary(recipients.length);
    if (recipients.length === 0) {
      log.debug("no subscribers for push", {
        groupId: input.groupId,
        channel: input.channel,
        dedupeId: input.dedupeId,
      });
      return summary;
    }
    for (const userId of recipients) {
      const outcome = await this.push.deliver({
        key: `${input.groupId}\u0000${input.dedupeId}\u0000${userId}`,
        userId,
        fields: {
          groupId: input.groupId,
          channel: input.channel,
          dedupeId: input.dedupeId,
        },
        send: () => this.sendCard(userId, input.cardFor(userId)),
        entry: (now, sent) => ({
          groupId: input.groupId,
          requestId: input.dedupeId,
          userId,
          status:
            sent.status === "sent"
              ? NotificationDeliveryStatus.Sent
              : NotificationDeliveryStatus.Failed,
          detail: sent.detail,
          createdAt: now,
        }),
      });
      tallySummary(summary, outcome);
    }
    log.info("subscriber push finished", {
      groupId: input.groupId,
      channel: input.channel,
      dedupeId: input.dedupeId,
      ...summary,
    });
    return summary;
  }

  /**
   * 推送一条待审批入群申请。
   *
   * 发送失败只记录日志与投递状态，不抛错：申请本身仍在 `/pending` 里。
   */
  public async notifyJoinRequest(
    push: JoinRequestPush,
  ): Promise<NotificationPushResult> {
    const recipients = this.subscribersFor(push.groupId);
    const result: NotificationPushResult = {
      sent: 0,
      failed: 0,
      skipped: 0,
      recipients: recipients.length,
    };
    if (recipients.length === 0) {
      log.debug("no subscribers for join request", {
        groupId: push.groupId,
        requestId: push.requestId,
      });
      return result;
    }

    const opinion = this.opinionFor(push.groupId, push.reason);
    // 展示名：优先 DisplayNameService（群号/QQ号/短码），否则回退到绑定号或内部 id
    const groupLabel =
      this.display?.group(push.groupId) ??
      this.identityMap?.getGroupNumber(push.groupId) ??
      push.groupId;
    const applicantLabel =
      this.display?.user(push.userId) ??
      this.identityMap?.getQq(push.userId) ??
      push.userId;
    const requestLabel = this.display?.request(push.requestId) ?? push.requestId;
    for (const userId of recipients) {
      const input: JoinRequestCardInput = {
        groupId: push.groupId,
        groupLabel,
        requestId: requestLabel,
        userId: push.userId,
        applicantLabel,
        reason: push.reason,
        ...(push.applicantName !== undefined
          ? { applicantName: push.applicantName }
          : {}),
        ...(push.questions !== undefined ? { questions: push.questions } : {}),
        ...(push.decision !== undefined ? { decision: push.decision } : {}),
        opinion,
        recipientId: userId,
        withButtons: this.sender.keyboardAvailable,
      };
      const outcome = await this.push.deliver({
        key: deliveryKey({
          groupId: push.groupId,
          requestId: push.requestId,
          userId,
        }),
        userId,
        fields: { groupId: push.groupId, requestId: push.requestId },
        send: () => this.send(userId, input),
        entry: (now, sent) => ({
          groupId: push.groupId,
          requestId: push.requestId,
          userId,
          status:
            sent.status === "sent"
              ? NotificationDeliveryStatus.Sent
              : NotificationDeliveryStatus.Failed,
          detail: sent.detail,
          createdAt: now,
        }),
      });
      if (outcome.status === "sent") {
        result.sent += 1;
      } else if (outcome.status === "failed") {
        result.failed += 1;
      } else {
        result.skipped += 1;
      }
    }
    log.info("join request push finished", {
      groupId: push.groupId,
      requestId: push.requestId,
      ...result,
    });
    return result;
  }

  /** `/notify test`：给自己发一张测试卡片，验证推送通道与按钮。 */
  public async sendTestCard(
    userId: string,
    preferredGroupId?: string,
  ): Promise<NotificationTestResult> {
    const groupId =
      preferredGroupId && this.permissions.canApproveJoin(userId, preferredGroupId)
        ? preferredGroupId
        : this.permissions.listReviewableGroups(userId)[0];
    // 没有可用的群也要能自检：测试的是**私聊推送通道**，不依赖具体群
    // （全局超管可能没有被显式授予任何群角色，私聊里也就没有"可审批的群"）。
    const groupLabel = groupId
      ? (this.display?.group(groupId) ??
        this.identityMap?.getGroupNumber(groupId) ??
        groupId)
      : undefined;
    const input: JoinRequestCardInput = {
      groupId: groupId ?? "",
      groupLabel: groupLabel ?? "（未指定群）",
      requestId: "TEST",
      userId,
      applicantLabel: this.display?.user(userId) ?? userId,
      reason: "推送测试",
      recipientId: userId,
      withButtons: this.sender.keyboardAvailable,
    };
    const pendingCommand = groupId ? `/pending ${groupId}` : undefined;
    const card: JoinRequestCard = renderCard({
      title: "推送测试",
      lines: [
        "能看到这张卡片说明入群申请推送通道正常。",
        ...(groupLabel ? [`- 群：${groupLabel}`] : []),
        ...(pendingCommand
          ? [`- 按钮测试：点击下方按钮会发送 ${pendingCommand}`]
          : ["- 还没有可审批的群：先在群里把自己设为群管理员或本群超管，才有待审批按钮"]),
        "",
        "同意 / 拒绝按钮只出现在真实的入群申请卡片上。",
      ],
      ...(input.withButtons === false || !pendingCommand
        ? {}
        : {
            rows: [
              [
                {
                  id: "pending",
                  label: "查看待审批",
                  style: 1 as const,
                  command: pendingCommand,
                  permission: {
                    type: 0 as const,
                    specifyUserIds: [userId],
                  },
                  unsupportTips: "当前 QQ 版本不支持按钮",
                },
              ],
            ],
          }),
    });
    const outcome = await this.send(userId, input, card);
    if (outcome.ok) {
      return {
        ok: true,
        text:
          "已发送推送测试卡片，请查看私聊消息。" +
          (outcome.detail ? `（降级为 ${outcome.detail}）` : ""),
      };
    }
    return {
      ok: false,
      text: `推送测试失败：${outcome.detail}。请确认机器人认证状态与“允许主动发送”开关。`,
    };
  }

  /** 删除早于 cutoff 的投递记录，返回删除条数。 */
  public async pruneDeliveredOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;
    for (const [key, delivery] of this.deliveries) {
      if (delivery.createdAt < cutoff) {
        this.deliveries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0 && this.deliveryRepository) {
      this.queue?.enqueue("notification.delivery.prune", () =>
        this.deliveryRepository!.deleteOlderThan(cutoff),
      );
    }
    return removed;
  }

  private opinionFor(groupId: string, reason: string): string {
    const config = this.configStore?.get(groupId);
    if (!config?.joinReviewOpinion || !this.joinRules) {
      return "";
    }
    return evaluateConfiguredJoinRules(this.joinRules, config, reason, true)
      .opinion;
  }

  /**
   * 三级投递（委托给 RichMessageSender）：Markdown + 按钮 → Markdown → 纯文本。
   *
   * 任何一次成功都算投递成功，detail 里记录降级原因。
   */
  private async send(
    userId: string,
    input: JoinRequestCardInput,
    preset?: JoinRequestCard,
  ): Promise<{ ok: boolean; detail: string }> {
    const card = preset ?? buildJoinRequestCard(input);
    const result = await this.sender.sendToUser(userId, card);
    return { ok: result.ok, detail: result.detail };
  }

  /** 主动私信一张卡片（三级降级由 RichMessageSender 负责）。 */
  private async sendCard(
    userId: string,
    card: RichMessage,
  ): Promise<{ ok: boolean; detail: string }> {
    const result = await this.sender.sendToUser(userId, card);
    return { ok: result.ok, detail: result.detail };
  }

  private recordDelivery(delivery: NotificationDelivery): void {
    this.deliveries.set(deliveryKey(delivery), delivery);
    if (this.deliveryRepository) {
      this.queue?.enqueue("notification.delivery.save", () =>
        this.deliveryRepository!.save(delivery),
      );
    }
  }

  private scopesFor(userId: string, create: boolean): Set<string> {
    let scopes = this.subscriptions.get(userId);
    if (!scopes && create) {
      scopes = new Set();
      this.subscriptions.set(userId, scopes);
    }
    return scopes ?? new Set();
  }

  private addScope(subscription: NotificationSubscription): void {
    const scopes = this.scopesFor(subscription.userId, true);
    scopes.add(subscription.scope);
  }
}

function deliveryKey(input: {
  groupId: string;
  requestId: string;
  userId: string;
}): string {
  return `${input.groupId}\u0000${input.requestId}\u0000${input.userId}`;
}
