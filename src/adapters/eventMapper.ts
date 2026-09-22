import type { QQEvent } from "../services/eventRouter.js";

export interface EventMapper {
  map(raw: unknown): QQEvent | null;
}

export class JsonEventMapper implements EventMapper {
  public map(raw: unknown): QQEvent | null {
    if (!isRecord(raw)) {
      return null;
    }

    if (raw.type === "group_message") {
      const groupId = asString(raw.groupId);
      const userId = asString(raw.userId);
      const messageId = asString(raw.messageId);
      const content = asString(raw.content);
      if (!groupId || !userId || !messageId || content === undefined) {
        return null;
      }
      return { type: "group_message", groupId, userId, messageId, content };
    }

    if (raw.type === "join_request") {
      const groupId = asString(raw.groupId);
      const userId = asString(raw.userId);
      const requestId = asString(raw.requestId);
      if (!groupId || !userId || !requestId) {
        return null;
      }
      const reason = asString(raw.reason);
      return {
        type: "join_request",
        groupId,
        userId,
        requestId,
        ...(reason !== undefined ? { reason } : {}),
      };
    }

    if (raw.type === "admin_command") {
      const groupId = asString(raw.groupId);
      const userId = asString(raw.userId);
      const text = asString(raw.text);
      if (!groupId || !userId || text === undefined) {
        return null;
      }
      return { type: "admin_command", groupId, userId, text };
    }

    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
