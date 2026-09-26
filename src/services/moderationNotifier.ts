import type { AppealRecord } from "../db/appealRepository.js";
import type { PunishmentRecord } from "../db/punishmentRepository.js";
import type { RichMessage } from "./richMessages.js";
import {
  buildAppealGuideCard,
  buildAppealNoticeCard,
  buildAppealReceiptCard,
  buildPunishmentNoticeCard,
} from "./moderationCards.js";
import type { NotificationService } from "./notifications.js";
import type { PermissionService } from "./permissions.js";
import type { PushSummary } from "./pushService.js";

export interface ModerationNotifierOptions {
  notifications: NotificationService;
  permissions: PermissionService;
  /** 群展示名（群号 / #群短码 / 内部 id）。 */
  groupLabel?: ((groupId: string) => string) | undefined;
  /** 用户展示名（QQ号 / #用户短码 / 内部 id）。 */
  userLabel?: ((userId: string) => string) | undefined;
}

/**
 * 处罚 / 申诉的私信推送（§B7 / §B8）。
 *
 * 接收者 = `notifications.subscribersFor(groupId, "punish")`（订阅了「处罚通知」且在该群
 * 有内容审核权限的成员）。每张卡片按接收者渲染，因此「拉黑全局」只出现在全局超管的卡上，
 * 按钮也带 `specifyUserIds` 只允许本人点击。
 */
export class ModerationNotifier {
  private readonly notifications: NotificationService;
  private readonly permissions: PermissionService;
  private readonly groupLabel: (groupId: string) => string;
  private readonly userLabel: (userId: string) => string;

  public constructor(options: ModerationNotifierOptions) {
    this.notifications = options.notifications;
    this.permissions = options.permissions;
    this.groupLabel = options.groupLabel ?? ((groupId) => groupId);
    this.userLabel = options.userLabel ?? ((userId) => userId);
  }

  /**
   * 私信卡片的按钮开关。
   *
   * §0.14.1 真机回归：按钮可用性按目标分开记录，而处罚 / 申诉卡片**全是私信**，
   * 所以这里必须看 **user** 目标 —— 群键盘被平台拒过一次，不该让私信卡片一起丢按钮。
   */
  public get keyboardAvailable(): boolean {
    return this.notifications.keyboardAvailableFor("user");
  }

  /** 处罚事件：推送给订阅者，卡片上可直接调整处罚。 */
  public async notifyPunishment(
    record: PunishmentRecord,
  ): Promise<PushSummary> {
    return this.notifications.pushToSubscribers({
      groupId: record.groupId,
      channel: "punish",
      dedupeId: `punish:${record.recordId}`,
      cardFor: (recipientId) => this.punishmentCard(record, recipientId),
    });
  }

  /** 申诉事件：推送给订阅者，卡片上可直接通过 / 驳回 / 调整处罚。 */
  public async notifyAppeal(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
  ): Promise<PushSummary> {
    return this.notifications.pushToSubscribers({
      groupId: appeal.groupId,
      channel: "punish",
      dedupeId: `appeal:${appeal.appealId}`,
      cardFor: (recipientId) => this.appealCard(appeal, punishment, recipientId),
    });
  }

  /** 给申诉人本人发回执。 */
  public async notifyAppellant(
    userId: string,
    card: RichMessage,
  ): Promise<{ ok: boolean; detail: string }> {
    return this.notifications.sendPrivateCard(userId, card);
  }

  public punishmentCard(
    record: PunishmentRecord,
    recipientId: string,
  ): RichMessage {
    return buildPunishmentNoticeCard({
      groupLabel: this.groupLabel(record.groupId),
      userLabel: this.userLabel(record.userId),
      recordId: record.recordId,
      ruleReason: record.ruleReason,
      messageExcerpt: record.messageExcerpt,
      actions: record.actions,
      detail: record.detail,
      createdAt: record.createdAt,
      recipientId,
      withButtons: this.keyboardAvailable,
      canBlacklistGlobal: this.permissions.isSuperAdmin(recipientId),
    });
  }

  public appealCard(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
    recipientId: string,
  ): RichMessage {
    return buildAppealNoticeCard({
      groupLabel: this.groupLabel(appeal.groupId),
      userLabel: this.userLabel(appeal.userId),
      recordId: punishment.recordId,
      appealId: appeal.appealId,
      reason: appeal.reason,
      messageExcerpt: punishment.messageExcerpt,
      actions: punishment.actions,
      createdAt: appeal.createdAt,
      recipientId,
      withButtons: this.keyboardAvailable,
      canBlacklistGlobal: this.permissions.isSuperAdmin(recipientId),
    });
  }

  /** 申诉引导卡（点群内「我要申诉」按钮后私信给当事人）。 */
  public appealGuide(
    punishment: PunishmentRecord,
    recipientId: string,
  ): RichMessage {
    return buildAppealGuideCard({
      recordId: punishment.recordId,
      groupLabel: this.groupLabel(punishment.groupId),
      messageExcerpt: punishment.messageExcerpt,
      recipientId,
      withButtons: this.keyboardAvailable,
    });
  }

  /** 申诉回执（发给申诉人）。 */
  public appealReceipt(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
    updated: boolean,
  ): RichMessage {
    return buildAppealReceiptCard({
      recordId: appeal.punishmentId,
      reason: appeal.reason,
      groupLabel: this.groupLabel(appeal.groupId),
      messageExcerpt: punishment.messageExcerpt,
      updated,
      recipientId: appeal.userId,
      withButtons: this.keyboardAvailable,
    });
  }

  public groupLabelOf(groupId: string): string {
    return this.groupLabel(groupId);
  }

  public userLabelOf(userId: string): string {
    return this.userLabel(userId);
  }
}
