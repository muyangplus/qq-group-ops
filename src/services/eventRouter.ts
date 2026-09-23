import type { ModerationAction } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import { newIncomingMessage } from "../core/models.js";
import type { AdminCommandService } from "./adminCommands.js";
import type { JoinApprovalService } from "./joinApproval.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { MessageGuardService } from "./messageGuard.js";
import type { NotificationService } from "./notifications.js";

const log = getLogger("event-router");

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

export type QQEvent =
  | GroupMessageEvent
  | PrivateMessageEvent
  | JoinRequestEvent
  | AdminCommandEvent;

export interface EventRouterResult {
  kind: "message" | "private_message" | "join_request" | "command";
  action?: ModerationAction;
  executed?: boolean;
  detail?: string;
  ok?: boolean;
  text?: string;
}

export class EventRouter {
  public constructor(
    private readonly messageGuard: MessageGuardService,
    private readonly joinAudit: JoinAuditService,
    private readonly adminCommands: AdminCommandService,
    private readonly joinApproval?: JoinApprovalService,
    private readonly notifications?: NotificationService,
  ) {}

  public async handle(event: QQEvent): Promise<EventRouterResult> {
    log.debug("route", {
      type: event.type,
      userId: event.userId,
      ...("groupId" in event ? { groupId: event.groupId } : {}),
    });
    switch (event.type) {
      case "group_message": {
        if (event.content.trim().startsWith("/")) {
          const commandResult = await this.adminCommands.handle(
            event.groupId,
            event.userId,
            event.content,
          );
          return {
            kind: "command",
            ok: commandResult.ok,
            text: commandResult.text,
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
          // 只有仍需人工处理的申请才推送，自动通过/拒绝不需要审核员操作。
          if (!outcome || outcome.action === "manual") {
            await this.notifications
              ?.notifyJoinRequest({
                groupId: event.groupId,
                requestId: event.requestId,
                userId: event.userId,
                reason: event.reason ?? "",
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
        if (event.content.trim().startsWith("/")) {
          const result = await this.adminCommands.handle(
            undefined,
            event.userId,
            event.content,
          );
          return {
            kind: "private_message",
            ok: result.ok,
            text: result.text,
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
        };
      }
    }
  }
}
