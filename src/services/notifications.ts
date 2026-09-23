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
  renderJoinRequestCardText,
  type JoinRequestCard,
  type JoinRequestCardInput,
  type JoinRequestDecision,
} from "./joinRequestCard.js";
import { RichMessageSender } from "./richMessages.js";
import {
  evaluateConfiguredJoinRules,
  type JoinRuleEvaluator,
} from "./joinRules.js";
import type { PermissionService } from "./permissions.js";

const log = getLogger("notifications");

/** 订阅范围：`__all__` 表示「我担任审核员的所有群」，否则是 group_openid。 */
export const NOTIFY_SCOPE_ALL = "__all__";

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
  }

  public get keyboardAvailable(): boolean {
    return this.sender.keyboardAvailable;
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

  public isSubscribed(userId: string, scope: string): boolean {
    return this.subscriptions.get(userId)?.has(scope) ?? false;
  }

  public listScopes(userId: string): string[] {
    return [...(this.subscriptions.get(userId) ?? [])].sort();
  }

  public subscribe(userId: string, scope: string): void {
    const scopes = this.scopesFor(userId, true);
    if (scopes.has(scope)) {
      return;
    }
    scopes.add(scope);
    this.subscriptionRepository &&
      this.queue?.enqueue("notification.subscription.save", () =>
        this.subscriptionRepository!.save({ userId, scope }),
      );
    log.info("notification subscribed", { userId, scope });
  }

  public unsubscribe(userId: string, scope: string): boolean {
    const scopes = this.subscriptions.get(userId);
    if (!scopes?.delete(scope)) {
      return false;
    }
    if (scopes.size === 0) {
      this.subscriptions.delete(userId);
    }
    this.subscriptionRepository &&
      this.queue?.enqueue("notification.subscription.remove", () =>
        this.subscriptionRepository!.remove(userId, scope),
      );
    log.info("notification unsubscribed", { userId, scope });
    return true;
  }

  /** 订阅了该群（或全部群）且有审批权限的接收者。 */
  public subscribersFor(groupId: string): string[] {
    const recipients: string[] = [];
    for (const [userId, scopes] of this.subscriptions) {
      if (!scopes.has(NOTIFY_SCOPE_ALL) && !scopes.has(groupId)) {
        continue;
      }
      if (!this.permissions.canApproveJoin(userId, groupId)) {
        continue;
      }
      recipients.push(userId);
    }
    return recipients.sort();
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
      const delivery = this.deliveries.get(
        deliveryKey({ groupId: push.groupId, requestId: push.requestId, userId }),
      );
      if (delivery) {
        result.skipped += 1;
        continue;
      }
      const outcome = await this.deliver(userId, input);
      this.recordDelivery({
        groupId: push.groupId,
        requestId: push.requestId,
        userId,
        status: outcome.status,
        detail: outcome.detail,
        createdAt: this.now(),
      });
      if (outcome.status === NotificationDeliveryStatus.Sent) {
        result.sent += 1;
      } else {
        result.failed += 1;
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
    if (!groupId) {
      return {
        ok: false,
        text: "你还没有可审批的群，无法发送测试卡片（入群审批需要群管理员或以上权限）。",
      };
    }
    const groupLabel =
      this.display?.group(groupId) ??
      this.identityMap?.getGroupNumber(groupId) ??
      groupId;
    const markdown = [
      "## 推送测试",
      "能看到这张卡片说明入群申请推送通道正常。",
      `- 群：${groupLabel}`,
      `- 按钮测试：点击下方按钮会发送 /pending ${groupLabel}`,
      "",
      "同意 / 拒绝按钮只出现在真实的入群申请卡片上。",
    ].join("\n");
    const input: JoinRequestCardInput = {
      groupId,
      groupLabel,
      requestId: "TEST",
      userId,
      applicantLabel: this.display?.user(userId) ?? userId,
      reason: "推送测试",
      recipientId: userId,
      withButtons: this.sender.keyboardAvailable,
    };
    const card: JoinRequestCard = {
      markdown,
      ...(input.withButtons === false
        ? {}
        : {
            keyboard: {
              content: {
                rows: [
                  {
                    buttons: [
                      {
                        id: "pending",
                        label: "查看待审批",
                        style: 1,
                        action: {
                          type: 2 as const,
                          data: `/pending ${groupId}`,
                          permission: {
                            type: 0 as const,
                            specifyUserIds: [userId],
                          },
                          enter: true,
                          reply: false,
                          unsupportTips: "当前 QQ 版本不支持按钮",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
    };
    const outcome = await this.deliver(userId, input, card);
    if (outcome.status === NotificationDeliveryStatus.Sent) {
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
  private async deliver(
    userId: string,
    input: JoinRequestCardInput,
    preset?: JoinRequestCard,
  ): Promise<{ status: NotificationDeliveryStatus; detail: string }> {
    const card = preset ?? buildJoinRequestCard(input);
    const result = await this.sender.sendToUser(userId, {
      markdown: card.markdown,
      ...(card.keyboard ? { keyboard: card.keyboard } : {}),
      text: renderJoinRequestCardText(input),
    });
    if (result.ok) {
      log.debug("notification delivered", {
        userId,
        groupId: input.groupId,
        requestId: input.requestId,
        mode: result.mode,
      });
      return { status: NotificationDeliveryStatus.Sent, detail: result.detail };
    }
    log.warn("notification delivery failed", {
      userId,
      groupId: input.groupId,
      requestId: input.requestId,
      error: result.detail,
    });
    return { status: NotificationDeliveryStatus.Failed, detail: result.detail };
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
