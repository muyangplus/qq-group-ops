import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import {
  NotificationDeliveryStatus,
  PLATFORM_LEVEL_MIN,
  PermissionLevel,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import { utcNow } from "../core/models.js";
import type {
  NotificationDelivery,
  NotificationDeliveryRepository,
  NotificationSubscription,
  NotificationSubscriptionRepository,
} from "../db/notificationRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import {
  meetsNotifyLevel,
  NOTIFY_CHANNELS,
  NOTIFY_SCOPE_ALL,
  NOTIFY_TOPIC_META,
  type NotifyChannel,
  type NotifyTopicLevelStore,
} from "./notifyTopics.js";
import type { GroupConfigStore } from "./groupConfig.js";
import type { DisplayNameService } from "./displayNames.js";
import type { IdentityMapService } from "./identityMap.js";
import {
  buildJoinRequestCard,
  type JoinRequestCard,
  type JoinRequestCardInput,
  type JoinRequestDecision,
} from "./joinRequestCard.js";
import { appendKeyboardRow, renderCard } from "./cardTemplate.js";
import { encodeCallback } from "./callbackData.js";
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

/**
 * 订阅范围（`__all__` / group_openid）与话题枚举统一定义在 `notifyTopics.ts`
 * （那里还有默认门槛与推送/订阅共用的唯一判据），这里只做转出，
 * 保持既有 `from "./notifications.js"` 的导入不变。
 */
export { NOTIFY_CHANNELS, NOTIFY_SCOPE_ALL } from "./notifyTopics.js";
export type { NotifyChannel } from "./notifyTopics.js";

const channelPrefix = (channel: NotifyChannel): string => `${channel}:`;

/** 业务 scope → 存储 scope（所有频道都带前缀）。 */
function storageScope(channel: NotifyChannel, scope: string): string {
  return `${channelPrefix(channel)}${scope}`;
}

/** 存储 scope → 业务 scope；不属于该频道时返回 undefined。 */
function businessScope(
  channel: NotifyChannel,
  stored: string,
): string | undefined {
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
  /** 话题门槛（全局一套，存 `__default__`）；缺省时用内置默认门槛。 */
  notifyTopics?: NotifyTopicLevelStore | undefined;
  /** 自定义富消息发送器；缺省时用 api 现建一个。 */
  sender?: RichMessageSender | undefined;
  now?: (() => Date) | undefined;
}

/**
 * 入群申请推送。
 *
 * - 审核员用 `/notify` 订阅「全部群」或某个群；订阅持久化到数据库；
 * - 有新的待审批入群申请时，推送给「订阅了该群 + 在当前群有审批权限」的人；
 * - 卡片是 Markdown + 指令按钮（同意 / 拒绝 / 自定义理由），自定义按钮未开通时自动降级为
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
  /** 话题门槛存储（缺省时用内置默认值，推送与订阅仍走同一份判据）。 */
  private readonly topicLevels: NotifyTopicLevelStore | undefined;
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
    this.topicLevels = options.notifyTopics;
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
    // 重新订阅 = 撤销之前的退订墓碑（默认开的话题才可能有墓碑）
    this.topicLevels?.clearOptOut(channel, userId);
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
    // 默认开的话题（门槛 >= 平台档下限）必须留退订墓碑：
    // 否则下次启动 `seedSuperAdminDefaults` 又把它种回来，等于退不掉。
    if (scope === NOTIFY_SCOPE_ALL && this.topicLevel(channel) >= PLATFORM_LEVEL_MIN) {
      this.topicLevels?.markOptedOut(channel, userId);
    }
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
   * **平台类话题**（机器人入/退群、好友变动、新成员、未知事件）的收件人：
   * 订阅了该话题「全部群」且够门槛的人 —— 这些事件与具体群无关（未知事件甚至没有群号），
   * 所以只看「全部群」这一个范围。
   */
  public topicSubscribers(topic: NotifyChannel): string[] {
    const wanted = storageScope(topic, NOTIFY_SCOPE_ALL);
    const recipients: string[] = [];
    for (const [userId, scopes] of this.subscriptions) {
      if (!scopes.has(wanted)) {
        continue;
      }
      if (!this.checkTopicReach(userId, topic, NOTIFY_SCOPE_ALL).ok) {
        continue;
      }
      recipients.push(userId);
    }
    return recipients.sort();
  }

  /**
   * 订阅了该群（或「全部群」）且**有收件资格**的人（见 `canReceive`）。
   *
   * 所有话题共用这张订阅表，资格判定集中在 `canReceive`（推送）与 `checkTopicReach`
   * （订阅）两处，但两者走的是同一份门槛判据。
   */
  public subscribersFor(
    groupId: string,
    channel: NotifyChannel = "join",
  ): string[] {
    const recipients: string[] = [];
    const wanted = storageScope(channel, groupId);
    const all = storageScope(channel, NOTIFY_SCOPE_ALL);
    for (const [userId, scopes] of this.subscriptions) {
      const viaGroup = scopes.has(wanted);
      const viaAll = scopes.has(all);
      if (!viaGroup && !viaAll) {
        continue;
      }
      if (!this.canReceive(userId, groupId, channel, viaAll)) {
        continue;
      }
      recipients.push(userId);
    }
    return recipients.sort();
  }

  /**
   * 收件人资格（订阅之外的第二道门）：门槛统一由 `meetsNotifyLevel` 决定，
   * 与订阅路径（`checkTopicReach`）**共用同一份判据**，避免「订阅成功却永远收不到」。
   *
   * 推送始终按**具体群**判定（订阅了「全部群」也要在该群有角色，与历史行为一致）；
   * 平台档话题（>= 200）只看全局角色，不受群上下文影响。
   */
  private canReceive(
    userId: string,
    groupId: string,
    channel: NotifyChannel,
    viaAll: boolean,
  ): boolean {
    if (!this.meetsTopicLevel(userId, channel, groupId)) {
      return false;
    }
    // 历史口径：活动通知订阅「全部群」时要求已绑定 QQ 号
    if (NOTIFY_TOPIC_META[channel].requiresBindingForAll === true && viaAll) {
      return this.isBound(userId);
    }
    return true;
  }

  /** 话题当前门槛（全局一套；通知中心展示用）。 */
  public topicLevel(topic: NotifyChannel): number {
    return (
      this.topicLevels?.levelOf(topic) ?? NOTIFY_TOPIC_META[topic].defaultLevel
    );
  }

  /**
   * 改某个话题的门槛（仅全局超管，通知中心子卡用）：立即对推送与订阅生效并落库。
   * 没装配门槛存储（例如纯内存测试）时抛错，避免「改了个寂寞」。
   */
  public setTopicLevel(topic: NotifyChannel, level: number): void {
    if (!this.topicLevels) {
      throw new Error("话题门槛存储未启用，无法修改门槛。");
    }
    this.topicLevels.setLevel(topic, level);
    log.info("notify topic level updated", { topic, level });
  }

  /** 恢复全部话题的内置默认门槛（通知中心「恢复默认」按钮）。 */
  public resetTopicLevels(): void {
    if (!this.topicLevels) {
      throw new Error("话题门槛存储未启用，无法恢复默认门槛。");
    }
    this.topicLevels.resetLevels();
    log.info("notify topic levels reset");
  }

  /**
   * 订阅资格：与推送资格（`canReceive`）共用同一份门槛判据。
   *
   * `scope` 是用户点的范围：具体群按该群折算判定；「全部群」按「全局超管，或至少在
   * 某个群达到该档」判定 —— 与推送侧「按具体群判定」的范围语义差异是**历史行为**，
   * 门槛本身两边完全一致。
   */
  public checkTopicReach(
    userId: string,
    topic: NotifyChannel,
    scope: string,
  ): { ok: boolean; reason: string } {
    const level = this.topicLevel(topic);
    if (!this.meetsTopicLevel(userId, topic, scope)) {
      return { ok: false, reason: topicReachReason(topic, scope, level) };
    }
    if (
      NOTIFY_TOPIC_META[topic].requiresBindingForAll === true &&
      scope === NOTIFY_SCOPE_ALL &&
      !this.isBound(userId)
    ) {
      return {
        ok: false,
        reason: "订阅「全部群」的活动通知需要先绑定 QQ 号（/bind）。",
      };
    }
    return { ok: true, reason: "" };
  }

  /**
   * 超管专属话题（当前门槛 >= 平台档下限）「默认开」：启动时给现有全局超管补订阅行。
   *
   * 幂等：已有行不动（不覆盖用户已有的状态）；退订 = 删行。注意「退订后重启会被重新
   * 种上」是「默认开 + 不加默认订阅层」的必然结果 —— H4 的「取消订阅此通知」按钮若要
   * 真正生效，需要一个退订墓碑（本轮不做，已在 TODO 里记录）。
   */
  public seedSuperAdminDefaults(userIds: readonly string[]): number {
    const topics =
      this.topicLevels?.superAdminTopics() ??
      NOTIFY_CHANNELS.filter(
        (topic) =>
          NOTIFY_TOPIC_META[topic].defaultLevel >= PLATFORM_LEVEL_MIN,
      );
    let added = 0;
    for (const topic of topics) {
      for (const userId of userIds) {
        if (this.isSubscribed(userId, NOTIFY_SCOPE_ALL, topic)) {
          continue;
        }
        // 退订墓碑优先：用户明确关掉过的话题不再种回（否则退订白做）
        if (this.topicLevels?.isOptedOut(topic, userId) === true) {
          continue;
        }
        this.subscribe(userId, NOTIFY_SCOPE_ALL, topic);
        added += 1;
      }
    }
    if (added > 0) {
      log.info("seeded super admin notification defaults", { added });
    }
    return added;
  }

  private meetsTopicLevel(
    userId: string,
    topic: NotifyChannel,
    scope: string,
  ): boolean {
    return meetsNotifyLevel(
      this.permissions,
      userId,
      this.topicLevel(topic),
      scope,
    );
  }

  /** 诊断计数（`/status proc`）：订阅人数 / 投递记录数。 */
  public stats(): { subscribers: number; deliveries: number } {
    let subscribers = 0;
    for (const scopes of this.subscriptions.values()) {
      if (scopes.size > 0) {
        subscribers += 1;
      }
    }
    return { subscribers, deliveries: this.deliveries.size };
  }

  /** 是否已绑定 QQ 号（没有身份库时按「已绑定」处理，保持测试与单机用法可用）。 */
  private isBound(userId: string): boolean {
    if (!this.identityMap) {
      return true;
    }
    return this.identityMap.getQq(userId) !== undefined;
  }

  /**
   * 这张卡实际是通过哪个范围投给该用户的：订过「全部群」就是「全部群」，
   * 否则是具体群 —— 卡上的「取消订阅」要退掉真正生效的那一条。
   */
  private scopeFor(userId: string, groupId: string, topic: NotifyChannel): string {
    return this.isSubscribed(userId, NOTIFY_SCOPE_ALL, topic)
      ? NOTIFY_SCOPE_ALL
      : groupId;
  }

  /**
   * 推送卡底部补一行「取消订阅此通知」。
   *
   * ⚠️ **不写** `permission.specifyUserIds`：1:1 私信卡片上客户端会把它误判成
   * 「无权限操作」（真机：全局超管点自己收到的卡也一样）。退订本身只作用于点击者自己
   * （回调里用事件里的 `userId`），不存在越权可能，所以客户端不需要做可见性限制。
   *
   * 追加不进去（键盘已满 5 行）时原样返回：宁可少一个按钮，也不能让整张通知卡发不出去。
   * 供本服务与其它投递路径（活动通知）共用，保证「所有通知卡」都有同一个退订入口。
   */
  public withUnsubscribeRow(
    card: RichMessage,
    topic: NotifyChannel,
    scope: string,
    /** 接收者：退订只作用于点击者自己，所以这里**不用**它做客户端可见性限制（见上）。 */
    _userId: string,
  ): RichMessage {
    return appendKeyboardRow(card, [
      {
        id: "notifyUnsub",
        label: "取消订阅",
        callbackData: encodeCallback("notify", "unsub", topic, scope),
        unsupportTips: "当前 QQ 版本不支持按钮，可在 /notify 里取消订阅",
      },
    ]);
  }

  /**
   * 给某个频道的订阅者逐个私信一张卡片（§B7/B8 复用）。
   *
   * - 每人每 key 只投一次（`dedupeId` 写进投递记录的 `request_id` 字段，重启后仍去重）；
   * - 失败也记录，避免反复重试刷屏；
   * - `cardFor(recipientId)` 让每张卡片能按接收者定制内容（例如只给超管的「拉黑全局」按钮）；
   *   卡片按钮**不做客户端可见性限制**（私信上会被误判「无权限操作」），权限在服务端校验。
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
      // 每张推送卡底部带「取消订阅此通知」：按该卡话题 + 实际投递范围退订
      const card = this.withUnsubscribeRow(
        input.cardFor(userId),
        input.channel,
        this.scopeFor(userId, input.groupId, input.channel),
        userId,
      );
      const outcome = await this.push.deliver({
        key: `${input.groupId}\u0000${input.dedupeId}\u0000${userId}`,
        userId,
        fields: {
          groupId: input.groupId,
          channel: input.channel,
          dedupeId: input.dedupeId,
        },
        send: () => this.sendCard(userId, card),
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
      const card = this.withUnsubscribeRow(
        buildJoinRequestCard(input),
        "join",
        this.scopeFor(userId, push.groupId, "join"),
        userId,
      );
      const outcome = await this.push.deliver({
        key: deliveryKey({
          groupId: push.groupId,
          requestId: push.requestId,
          userId,
        }),
        userId,
        fields: { groupId: push.groupId, requestId: push.requestId },
        send: () => this.sendCard(userId, card),
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
      preferredGroupId &&
      this.permissions.meetsInGroup(
        userId,
        preferredGroupId,
        PermissionLevel.GroupAdmin,
      )
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
                  // 私信卡片不写 specifyUserIds（客户端会误判「无权限操作」）
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

/** 订阅被拒时给人看的原因（门槛本身由 `meetsNotifyLevel` 判定）。 */
function topicReachReason(
  topic: NotifyChannel,
  scope: string,
  level: number,
): string {
  if (topic === "join") {
    return "权限不足：入群申请推送只发给群管理员及以上。";
  }
  if (topic === "punish") {
    return "权限不足：处罚与申诉推送只发给审核员及以上。";
  }
  if (level >= PLATFORM_LEVEL_MIN) {
    return "权限不足：该通知只发给全局超级管理员。";
  }
  if (scope === NOTIFY_SCOPE_ALL) {
    return "权限不足：订阅「全部群」需要你是全局超管，或至少在某个群达到该档位。";
  }
  return "权限不足：你在此群的权限不够接收该通知。";
}
