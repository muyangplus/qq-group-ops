import type { QQEvent } from "../services/eventRouter.js";

export interface OfficialEventMapper {
  map(eventType: string, data: unknown): QQEvent | null;
}

export class QQOfficialEventMapper implements OfficialEventMapper {
  public map(eventType: string, data: unknown): QQEvent | null {
    if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
      return mapGroupMessage(data);
    }
    if (eventType === "GROUP_JOIN_REQUEST") {
      return mapJoinRequest(data);
    }
    return null;
  }
}

function mapGroupMessage(data: unknown): QQEvent | null {
  if (!isRecord(data)) {
    return null;
  }
  const groupId = asString(data.group_openid);
  const messageId = asString(data.id);
  const content = asString(data.content);
  const author = isRecord(data.author) ? data.author : undefined;
  const userId =
    asString(author?.member_openid) ??
    asString(author?.user_openid) ??
    asString(author?.id);
  if (!groupId || !messageId || content === undefined || !userId) {
    return null;
  }
  return { type: "group_message", groupId, userId, messageId, content };
}

function mapJoinRequest(data: unknown): QQEvent | null {
  if (!isRecord(data)) {
    return null;
  }
  const groupId = asString(data.group_openid);
  const userId = asString(data.member_openid);
  const requestId = asString(data.join_request_id);
  if (!groupId || !userId || !requestId) {
    return null;
  }
  const verifyInfo = isRecord(data.verify_info) ? data.verify_info : undefined;
  const reason = asString(verifyInfo?.verify_message);
  return {
    type: "join_request",
    groupId,
    userId,
    requestId,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
