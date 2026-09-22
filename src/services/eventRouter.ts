import type { ModerationAction } from "../core/enums.js";
import { newIncomingMessage } from "../core/models.js";
import type { AdminCommandService } from "./adminCommands.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { MessageGuardService } from "./messageGuard.js";

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
}

export interface AdminCommandEvent {
  type: "admin_command";
  groupId: string;
  userId: string;
  text: string;
}

export type QQEvent = GroupMessageEvent | JoinRequestEvent | AdminCommandEvent;

export interface EventRouterResult {
  kind: "message" | "join_request" | "command";
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
  ) {}

  public async handle(event: QQEvent): Promise<EventRouterResult> {
    switch (event.type) {
      case "group_message": {
        if (event.content.trim().startsWith("/")) {
          const commandResult = this.adminCommands.handle(
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
          this.joinAudit.submit(
            event.groupId,
            event.userId,
            event.reason ?? "",
            event.requestId,
          );
          return { kind: "join_request", ok: true, detail: "queued" };
        } catch (error) {
          return { kind: "join_request", ok: false, detail: String(error) };
        }
      }
      case "admin_command": {
        const result = this.adminCommands.handle(
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
