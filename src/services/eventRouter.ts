import { ModerationAction, PermissionLevel } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import { newIncomingMessage } from "../core/models.js";
import type { AdminCommandService } from "./adminCommands.js";
import type { JoinApprovalService } from "./joinApproval.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { JoinRequestDecision } from "./joinRequestCard.js";
import type { MessageGuardService } from "./messageGuard.js";
import type { NotificationService } from "./notifications.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("event-router");

/** 审批动作 → 卡片上的处理结果标记。 */
function decisionOf(action: "approve" | "reject" | "manual"): JoinRequestDecision {
  if (action === "approve") {
    return "auto_approved";
  }
  if (action === "reject") {
    return "auto_rejected";
  }
  return "manual";
}

export interface GroupMessageEvent {
  type: "group_message";
  groupId: string;
  userId: string;
  messageId: string;
  content: string;
  /**
   * 这条消息是不是**真的 @ 了机器人**。
   *
   * 来源两个（任一成立即真）：官方事件类型是 `GROUP_AT_MESSAGE_CREATE`（只有被 @ 才会推），
   * 或正文开头剥掉了一个提及前缀（全量消息通道里客户端也会带 `<@!botid>`）。
   *
   * **为什么必须有它**：全量消息模式（官方 `GROUP_MESSAGE_CREATE`，群管理里开了「接收所有消息」）
   * 下，图片 / 文件 / 语音的正文就是空的 —— 只有真正 @ 了机器人时，空正文才该被当成
   * 「空 @机器人 → 回主菜单」；否则一次发 N 张图片就会回 N 张菜单卡、@ 用户 N 次
   * （真机反馈 2026-10-12）。缺省 `false`（老映射器 / 单测不必每条都填）。
   */
  mentioned?: boolean | undefined;
}

export interface JoinRequestEvent {
  type: "join_request";
  groupId: string;
  userId: string;
  requestId: string;
  reason?: string;
  /** 申请人昵称（官方 `username`）。 */
  applicantName?: string;
  /** 入群验证方式：`verify_message` / `admin_review_qa`。 */
  verifyMethod?: string;
  /** 申请来源：`self_apply` / `invited`。 */
  applySource?: string;
  /** 管理员问答的题目（`admin_review_qa` 时携带）。 */
  questions?: readonly string[];
}

export interface PrivateMessageEvent {
  type: "private_message";
  userId: string;
  messageId: string;
  content: string;
}

export interface AdminCommandEvent {
  type: "admin_command";
  groupId: string;
  userId: string;
  text: string;
}

/**
 * 互动事件（官方 `INTERACTION_CREATE`）：用户在消息里点了按钮。
 *
 * `interactionId` 既用于回包（`PUT /interactions/{id}`），也可以直接当 `msg_id`
 * 发一条**被动消息** —— 这是官方唯一的"回调回复"方式（没有更新原消息的接口）。
 */
export interface InteractionEvent {
  type: "interaction";
  interactionId: string;
  /** 互动类型：11=消息按钮点击，12=快捷菜单点击。 */
  interactionType: number;
  scene?: string | undefined;
  chatType?: number | undefined;
  /** 群聊场景的群 OpenID。 */
  groupId?: string | undefined;
  /** 点击者：群聊为 group_member_openid，单聊为 user_openid。 */
  userId?: string | undefined;
  buttonId?: string | undefined;
  buttonData?: string | undefined;
  messageId?: string | undefined;
}

export type QQEvent =
  | GroupMessageEvent
  | PrivateMessageEvent
  | JoinRequestEvent
  | AdminCommandEvent
  | InteractionEvent;

export interface EventRouterResult {
  kind: "message" | "private_message" | "join_request" | "command" | "interaction";
  action?: ModerationAction;
  executed?: boolean;
  detail?: string;
  ok?: boolean;
  text?: string;
  /** 富回复（Markdown + 按钮）；由 gatewayRunner 交给 RichMessageSender 发送。 */
  rich?: RichMessage | undefined;
  /**
   * §B4 群内静默：`true` 时 `gatewayRunner` **不往群里发任何消息**。
   *
   * 用于「结果只能私信」的动作（群里报名 / 取消报名）：结果由 handler 私信发出，
   * 群里连「原因已私信」都不发。
   */
  silent?: boolean | undefined;
  /**
   * §F1：`true` 时群内回复**不自动 @ 发起人**（仅 `test` 模块使用）。
   * 默认由 `gatewayRunner` 在卡片首行加 `<@!发起人>`。
   */
  noMention?: boolean | undefined;
}

/** 互动事件处理器（例如 `/testmenu` 的回调翻页）。 */
export interface InteractionHandler {
  handle(event: InteractionEvent): Promise<{ handled: boolean; detail: string }>;
}

/**
 * 群里「谁能触发响应」的档位判定（ADR-0074）。
 *
 * 只用到这两个方法，`PermissionService` 天然满足这个形状；用结构类型注入，
 * 单测不必造一份完整的权限服务。
 */
export interface GroupLevelGate {
  meetsInGroup(userId: string, groupId: string, level: PermissionLevel): boolean;
  levelFor(userId: string, groupId: string): PermissionLevel;
}

export class EventRouter {
  public constructor(
    private readonly messageGuard: MessageGuardService,
    /**
     * 群里响应门槛（ADR-0074）：**必填**。
     *
     * 缺省会让「审核员以下也能触发回复」的旧行为悄悄回来 —— 而这类「忘接线 = 静默降级」
     * 正是包安装器踩过的坑（ADR-0073：替换根漏传、照常报成功），所以这里不留缺省值。
     */
    private readonly permissions: GroupLevelGate,
    private readonly joinAudit: JoinAuditService,
    private readonly adminCommands: AdminCommandService,
    private readonly joinApproval?: JoinApprovalService,
    private readonly notifications?: NotificationService,
    private readonly interactionHandler?: InteractionHandler,
  ) {}

  public async handle(event: QQEvent): Promise<EventRouterResult> {
    log.debug("route", {
      type: event.type,
      userId: event.userId,
      ...("groupId" in event ? { groupId: event.groupId } : {}),
    });
    switch (event.type) {
      case "group_message": {
        const content = event.content.trim();
        if (content.length === 0 && event.mentioned !== true) {
          // ⚠️ 只有**真的 @ 了机器人**才算「空 @机器人」：
          // 全量消息模式下图片 / 文件 / 语音的正文就是空的，之前会被当成空 @ 回一张常用菜单 ——
          // 一次发 N 张图片 = N 张菜单卡 + @ 用户 N 次（真机反馈 2026-10-12）。
          // 没 @ 也不是指令的消息：一条都不回（没有正文可审，也不用写审计）。
          log.debug("empty group message ignored (bot not mentioned)", {
            groupId: event.groupId,
            userId: event.userId,
          });
          return {
            kind: "message",
            action: ModerationAction.Allow,
            executed: false,
            detail: "empty_not_mentioned",
          };
        }
        // ADR-0074：群里**只有本群审核员（120）及以上**的消息会被响应。
        // 审核员以下的任何消息（`/指令`、`@机器人`、普通发言）**一条都不回**，也不回
        // 「权限不足」—— 级别不够就是**不允许使用**，静默即可（用户口径 2026-10-15）。
        // 但**审查照旧**：关键词 / 正则命中仍要处置（撤回 / 禁言 / 处罚卡），那是机器人的本职，
        // 不是「响应消息」。判据放在指令分发**之前**，所以下面的路径天然只服务审核员及以上。
        if (
          !this.permissions.meetsInGroup(
            event.userId,
            event.groupId,
            PermissionLevel.Moderator,
          )
        ) {
          const reviewed = await this.messageGuard.handleMessage(
            newIncomingMessage(
              event.groupId,
              event.userId,
              event.messageId,
              event.content,
            ),
          );
          log.debug("group message from below-moderator: reviewed only", {
            groupId: event.groupId,
            userId: event.userId,
            level: this.permissions.levelFor(event.userId, event.groupId),
            mentioned: event.mentioned === true,
            action: reviewed.action,
            executed: reviewed.executed,
            detail: reviewed.detail,
          });
          return {
            kind: "message",
            action: reviewed.action,
            executed: reviewed.executed,
            detail: reviewed.detail,
          };
        }
        if (content.startsWith("/")) {
          const commandResult = await this.adminCommands.handle(
            event.groupId,
            event.userId,
            content,
          );
          return {
            kind: "command",
            ok: commandResult.ok,
            text: commandResult.text,
            rich: commandResult.rich,
            silent: commandResult.silent,
            noMention: commandResult.noMention,
          };
        }
        const result = await this.messageGuard.handleMessage(
          newIncomingMessage(
            event.groupId,
            event.userId,
            event.messageId,
            event.content,
          ),
        );
        // 「绑定提醒」就是常用菜单（未绑定用户那张卡里带「请执行 /bind qq」）。
        // 触发条件（用户 2026-10-12 口径「非 @机器人 只响应 /指令」）：
        // ① **真的 @ 了机器人**（`mentioned`）—— 群里普通发言、全量模式下的图片都不算；
        // ② 这条消息**没有被别的路径回复**（命中规则会回处罚通知）→ 不再叠一张菜单（避免多卡刷屏）。
        if (event.mentioned === true && result.matches.length === 0) {
          const menuResult = await this.adminCommands.handle(
            event.groupId,
            event.userId,
            "/menu",
          );
          return {
            kind: "command",
            ok: menuResult.ok,
            text: menuResult.text,
            rich: menuResult.rich,
          };
        }
        return {
          kind: "message",
          action: result.action,
          executed: result.executed,
          detail: result.detail,
        };
      }
      case "join_request": {
        try {
          log.debug("join request received", {
            groupId: event.groupId,
            requestId: event.requestId,
            hasReason: Boolean(event.reason),
            reasonLength: event.reason?.length ?? 0,
            verifyMethod: event.verifyMethod,
            applySource: event.applySource,
          });
          // 事件可能重投：已经记录过的申请不再重复写入，但仍可补一次推送（投递表去重）。
          if (!this.joinAudit.has(event.requestId)) {
            this.joinAudit.submit(
              event.groupId,
              event.userId,
              event.reason ?? "",
              event.requestId,
            );
          }
          const outcome = await this.joinApproval?.applyJoinRules(
            event.groupId,
            event.requestId,
          );
          // 需要人工处理的一定推送；机器人自动处理的结果只在 notifyAutoApproved 开启时通知
          const shouldNotify = !outcome || outcome.notify;
          if (shouldNotify) {
            const decision: JoinRequestDecision = outcome
              ? decisionOf(outcome.action)
              : "manual";
            await this.notifications
              ?.notifyJoinRequest({
                groupId: event.groupId,
                requestId: event.requestId,
                userId: event.userId,
                reason: event.reason ?? "",
                decision,
                ...(event.applicantName !== undefined
                  ? { applicantName: event.applicantName }
                  : {}),
                ...(event.questions !== undefined
                  ? { questions: event.questions }
                  : {}),
              })
              .catch((error: unknown) => {
                log.warn("join request notification failed", {
                  groupId: event.groupId,
                  requestId: event.requestId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
          return {
            kind: "join_request",
            ok: true,
            detail:
              outcome?.action === "approve"
                ? "auto_approved"
                : outcome?.action === "reject"
                  ? "auto_rejected"
                  : "queued",
          };
        } catch (error) {
          return { kind: "join_request", ok: false, detail: String(error) };
        }
      }
      case "private_message": {
        const content = event.content.trim();
        if (content.startsWith("/")) {
          const result = await this.adminCommands.handle(
            undefined,
            event.userId,
            content,
          );
          return {
            kind: "private_message",
            ok: result.ok,
            text: result.text,
            rich: result.rich,
          };
        }
        if (content.length === 0) {
          // 私信空正文（图片 / 文件 / 语音）：**不在这里回菜单** —— 否则连发 N 张图会回 N 张卡。
          // 改由 `gatewayRunner` 的「首次私信」那一次推送负责：第一次私信只推一张常用菜单
          // （未绑定用户那张卡自带绑定提示），之后不再打扰。
          return { kind: "private_message", ok: true, text: "" };
        }
        return { kind: "private_message", ok: true, text: "" };
      }
      case "admin_command": {
        const result = await this.adminCommands.handle(
          event.groupId,
          event.userId,
          event.text,
        );
        return {
          kind: "command",
          ok: result.ok,
          text: result.text,
          rich: result.rich,
          silent: result.silent,
          noMention: result.noMention,
        };
      }
      case "interaction": {
        // 互动事件由处理器自己回包并回复（没有更新原消息的接口），这里只记录结果
        if (!this.interactionHandler) {
          log.debug("interaction ignored: no handler", {
            interactionType: event.interactionType,
          });
          return { kind: "interaction", ok: true, detail: "no_handler" };
        }
        try {
          const outcome = await this.interactionHandler.handle(event);
          log.debug("interaction handled", {
            interactionType: event.interactionType,
            handled: outcome.handled,
            detail: outcome.detail,
          });
          return {
            kind: "interaction",
            ok: outcome.handled,
            detail: outcome.detail,
          };
        } catch (error) {
          log.warn("interaction handler failed", {
            interactionType: event.interactionType,
            error: error instanceof Error ? error.message : String(error),
          });
          return { kind: "interaction", ok: false, detail: String(error) };
        }
      }
    }
  }
}
