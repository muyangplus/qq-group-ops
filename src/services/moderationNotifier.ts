import type { AppealRecord } from "../db/appealRepository.js";
import type { PunishmentRecord } from "../db/punishmentRepository.js";
import { getLogger } from "../core/logger.js";
import { PermissionLevel } from "../core/enums.js";
import type { RichMessage } from "./richMessages.js";
import {
  buildAppealDecisionCard,
  buildAppealGuideCard,
  buildAppealHandledNoticeCard,
  buildAppealNoticeCard,
  buildAppealReceiptCard,
  buildPunishmentNoticeCard,
} from "./moderationCards.js";
import type { NotificationService } from "./notifications.js";
import type { PermissionService } from "./permissions.js";
import { emptySummary, type PushSummary } from "./pushService.js";

const log = getLogger("moderation-notifier");

/** 没有可推送对象时的空汇总。 */
function emptyPushSummary(): PushSummary {
  return emptySummary(0);
}

export interface ModerationNotifierOptions {
  notifications: NotificationService;
  permissions: PermissionService;
  /** 群展示名（群号 / #群短码 / 内部 id）。 */
  groupLabel?: ((groupId: string) => string) | undefined;
  /** 用户展示名（QQ号 / #用户短码 / 内部 id）。 */
  userLabel?: ((userId: string) => string) | undefined;
  /**
   * 「只给短码」的用户标签（申诉人拿到的结果卡里显示处理人时用）。
   * 缺省回落到 `userLabel`。
   */
  userShortLabel?: ((userId: string) => string) | undefined;
  /**
   * 申诉「值班」单人持有时间（毫秒）。
   *
   * 申诉只推给**一个**审核员（按订阅顺序轮转），超过这个时间仍未处理则转给下一位；
   * `<= 0` 表示不自动转派（只推第一人）。
   */
  appealHoldMs?: number | undefined;
  /** 注入时钟便于测试。 */
  now?: (() => number) | undefined;
}

/** 申诉当前「值班」的审核员与超时时间。 */
interface AppealAssignment {
  holderId: string;
  /** 已经轮到第几个人（1 = 第一位；每转派一次 +1）。 */
  attempt: number;
  assignedAt: number;
}

/**
 * 处罚 / 申诉的私信推送（§B7 / §B8）。
 *
 * - **处罚通知**：推给 `notifications.subscribersFor(groupId, "punish")` 的全部订阅者
 *   （订阅是本人主动行为，一条处罚只推一次）；每张卡片按接收者渲染，因此「拉黑全局」
 *   只出现在全局超管的卡上，按钮也带 `specifyUserIds` 只允许本人点击。
 * - **申诉通知**：§B8 真机反馈「同时通知所有人会打扰大家、一个人处理了别人也不知道」，
 *   改成**值班轮转单人**：按订阅顺序只推给**一个**审核员，超过 `appealHoldMs` 未处理
 *   自动转给下一位（见 `forwardAppealIfStale`）；处理完成后由 `notifyAppealHandled`
 *   把结果同步给其余订阅者。
 */
export class ModerationNotifier {
  private readonly notifications: NotificationService;
  private readonly permissions: PermissionService;
  private readonly groupLabel: (groupId: string) => string;
  private readonly userLabel: (userId: string) => string;
  /** 只给短码的标签（申诉人卡片上的处理人）。 */
  private readonly userShortLabel: (userId: string) => string;
  private readonly appealHoldMs: number;
  private readonly now: () => number;
  /** 申诉 → 当前值班人（内存态；重启后由值班轮转服务重新从第一人开始派发）。 */
  private readonly assignments = new Map<string, AppealAssignment>();
  /** 每个群的下一个值班起点（让多条申诉轮流落在不同人身上）。 */
  private readonly groupCursor = new Map<string, number>();

  public constructor(options: ModerationNotifierOptions) {
    this.notifications = options.notifications;
    this.permissions = options.permissions;
    this.groupLabel = options.groupLabel ?? ((groupId) => groupId);
    this.userLabel = options.userLabel ?? ((userId) => userId);
    this.userShortLabel = options.userShortLabel ?? this.userLabel;
    this.appealHoldMs = options.appealHoldMs ?? 0;
    this.now = options.now ?? Date.now;
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

  /**
   * 申诉事件（§B8，用户口径）：**默认通知所有管理员（群管理员 / 本群超管 / 全局超管）；
   * 审核员之间轮单**（按订阅顺序只通知一个，超时转下一位）。
   *
   * 去重键带 `attempt`：同一批人不会被重复推送，转派给下一位时才是新的键。
   */
  public async notifyAppeal(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
  ): Promise<PushSummary> {
    const audience = this.appealAudience(appeal.groupId);
    const moderator = this.nextModerator(
      appeal.groupId,
      appeal.appealId,
      audience.moderators,
      1,
    );
    const recipients = [
      ...audience.admins,
      ...(moderator ? [moderator.holderId] : []),
    ];
    if (recipients.length === 0) {
      log.warn("no reviewer available for appeal", {
        appealId: appeal.appealId,
        groupId: appeal.groupId,
      });
      return emptyPushSummary();
    }
    return this.deliverAppeal(appeal, punishment, recipients, 1);
  }

  /**
   * 值班超时转派：把超过 `appealHoldMs` 仍未处理的申诉转给**下一位审核员**。
   *
   * 由 [`AppealWatcher`](./appealWatcher.ts) 周期调用；返回是否发生了转派。
   * 没有值班记录（例如进程刚重启）时重新从第一位审核员开始派发 ——
   * 去重键保证不会重复打扰同一位。
   */
  public async forwardAppealIfStale(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
  ): Promise<boolean> {
    if (this.appealHoldMs <= 0) {
      return false;
    }
    const audience = this.appealAudience(appeal.groupId);
    if (audience.moderators.length === 0) {
      // 没有审核员可轮：管理员已经收到过，不再转派
      return false;
    }
    const current = this.assignments.get(appeal.appealId);
    if (!current) {
      // 重启后内存态为空：重新派给第一位审核员（`attempt:1` 的旧投递会被去重拦下）
      const first = this.nextModerator(
        appeal.groupId,
        appeal.appealId,
        audience.moderators,
        1,
      );
      return first !== undefined;
    }
    if (this.now() - current.assignedAt < this.appealHoldMs) {
      return false;
    }
    const nextAttempt = current.attempt + 1;
    const next = this.nextModerator(
      appeal.groupId,
      appeal.appealId,
      audience.moderators,
      nextAttempt,
    );
    if (!next) {
      // 所有审核员都轮过一遍了：不再无限转派，等有人处理
      log.warn("appeal forwarded to every moderator", {
        appealId: appeal.appealId,
        attempts: current.attempt,
      });
      this.assignments.set(appeal.appealId, {
        ...current,
        assignedAt: this.now(),
      });
      return false;
    }
    await this.deliverAppeal(appeal, punishment, [next.holderId], nextAttempt);
    return true;
  }

  /** 当前轮到的审核员（测试与排查用）。 */
  public appealHolder(appealId: string): string | undefined {
    return this.assignments.get(appealId)?.holderId;
  }

  /** 清掉已处理申诉的值班记录（避免内存无限增长）。 */
  public releaseAppeal(appealId: string): void {
    this.assignments.delete(appealId);
  }

  /**
   * 处理结果同步：发给**与派发时同一批人** —— 管理员全部 + 当初值班的审核员，
   * 并把**处理人自己**也算进去（他也需要一份结果存档）。
   *
   * 真机反馈：原来只发给「订阅者减去处理人」，于是「只有处理人订阅」时一个收件人都没有，
   * 却静默返回、连日志都没有，看起来就是「审核员没收到任何信息」。
   */
  public async notifyAppealHandled(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
    approved: boolean,
    reviewerId: string,
  ): Promise<PushSummary> {
    const audience = this.appealAudience(appeal.groupId);
    const holder = this.assignments.get(appeal.appealId)?.holderId;
    this.releaseAppeal(appeal.appealId);
    const recipients = [
      ...new Set(
        [...audience.admins, ...(holder ? [holder] : []), reviewerId].filter(
          (userId) => userId.length > 0,
        ),
      ),
    ];
    if (recipients.length === 0) {
      log.warn("no recipients for appeal handled notice", {
        appealId: appeal.appealId,
        groupId: appeal.groupId,
      });
      return emptyPushSummary();
    }
    return this.notifications.pushToSubscribers({
      groupId: appeal.groupId,
      channel: "punish",
      dedupeId: `appeal-done:${appeal.appealId}`,
      recipients,
      cardFor: () =>
        buildAppealHandledNoticeCard({
          appealId: appeal.appealId,
          recordId: punishment.recordId,
          groupLabel: this.groupLabel(appeal.groupId),
          appellantLabel: this.userLabel(appeal.userId),
          approved,
          reviewerLabel: this.userLabel(reviewerId),
        }),
    });
  }

  /**
   * 给申诉人本人发处理结果（通过 / 驳回）。
   *
   * ⚠️ 申诉人只看到**处理人的短码**（`#U3F7K2`），不给 QQ 号/昵称 ——
   * 处理人属于内部信息，真机反馈过「把详细处理人发给申诉人」的问题。
   */
  public async notifyAppealDecision(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
    approved: boolean,
    reviewerId: string,
    note: string,
  ): Promise<{ ok: boolean; detail: string }> {
    return this.notifyAppellant(
      appeal.userId,
      buildAppealDecisionCard({
        appealId: appeal.appealId,
        recordId: punishment.recordId,
        groupLabel: this.groupLabel(appeal.groupId),
        approved,
        reviewerLabel: this.userShortLabel(reviewerId),
        note,
        createdAt: new Date(this.now()),
      }),
    );
  }

  /**
   * 把该群「处罚通知」的订阅者拆成两档：
   * - `admins`：群管理员 / 本群超管 / 全局超管 → **全部通知**；
   * - `moderators`：审核员 → **轮单**（一次只通知一位）。
   */
  private appealAudience(groupId: string): {
    admins: string[];
    moderators: string[];
  } {
    const admins: string[] = [];
    const moderators: string[] = [];
    for (const userId of this.notifications.subscribersFor(groupId, "punish")) {
      if (this.permissions.hasAtLeast(userId, groupId, PermissionLevel.GroupAdmin)) {
        admins.push(userId);
      } else {
        moderators.push(userId);
      }
    }
    return { admins, moderators };
  }

  /**
   * 选出本次值班的审核员。
   *
   * - 第 1 次（`attempt === 1`）：按**群内游标**取一位，游标前进 —— 所以连续几条申诉会落到不同人；
   * - 转派（`attempt > 1`）：从当前值班人的**下一位**继续；轮完一圈返回 `undefined`，不再无限转派。
   */
  private nextModerator(
    groupId: string,
    appealId: string,
    moderators: readonly string[],
    attempt: number,
  ): AppealAssignment | undefined {
    if (moderators.length === 0) {
      return undefined;
    }
    let index: number;
    if (attempt <= 1) {
      const cursor = this.groupCursor.get(groupId) ?? 0;
      this.groupCursor.set(groupId, cursor + 1);
      index = cursor % moderators.length;
    } else {
      const current = this.assignments.get(appealId);
      const start = current ? moderators.indexOf(current.holderId) : -1;
      index = start >= 0 ? start + 1 : 0;
    }
    if (index >= moderators.length) {
      return undefined;
    }
    const assignment: AppealAssignment = {
      holderId: moderators[index]!,
      attempt,
      assignedAt: this.now(),
    };
    this.assignments.set(appealId, assignment);
    return assignment;
  }

  private async deliverAppeal(
    appeal: AppealRecord,
    punishment: PunishmentRecord,
    recipients: readonly string[],
    attempt: number,
  ): Promise<PushSummary> {
    log.info("appeal assigned", {
      appealId: appeal.appealId,
      groupId: appeal.groupId,
      recipients,
      attempt,
    });
    return this.notifications.pushToSubscribers({
      groupId: appeal.groupId,
      channel: "punish",
      dedupeId: `appeal:${appeal.appealId}:${attempt}`,
      recipients,
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
