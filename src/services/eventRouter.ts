import type { ModerationAction } from "../core/enums.js";
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

export class EventRouter {
  public constructor(
    private readonly messageGuard: MessageGuardService,
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
        if (content.length === 0) {
          // 群里 @机器人 但没带内容：回主菜单（菜单渲染在指令服务里）
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
        const result = await this.messageGuard.handleMessage(
          newIncomingMessage(
            event.groupId,
            event.userId,
            event.messageId,
            event.content,
          ),
        );
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
          // 私信空消息：同样回主菜单
          const menuResult = await this.adminCommands.handle(
            undefined,
            event.userId,
            "/menu",
          );
          return {
            kind: "private_message",
            ok: menuResult.ok,
            text: menuResult.text,
            rich: menuResult.rich,
          };
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
