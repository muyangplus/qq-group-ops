import { getLogger } from "../core/logger.js";
import type { QQEvent } from "../services/eventRouter.js";

const log = getLogger("qq-official-event-mapper");

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
    if (eventType === "C2C_MESSAGE_CREATE") {
      return mapPrivateMessage(data);
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

function mapPrivateMessage(data: unknown): QQEvent | null {
  if (!isRecord(data)) {
    return null;
  }
  const messageId = asString(data.id);
  const content = asString(data.content);
  const author = isRecord(data.author) ? data.author : undefined;
  const userId = asString(author?.user_openid) ?? asString(author?.id);
  if (!messageId || content === undefined || !userId) {
    return null;
  }
  return { type: "private_message", userId, messageId, content };
}

/**
 * 用户申请加群事件（官方 `GROUP_JOIN_REQUEST`）。
 *
 * 入群验证有两种方式，答案字段不一样：
 * - `verify_info.method = verify_message`：答案在 `verify_info.verify_message`；
 * - `verify_info.method = admin_review_qa`：答案在 `verify_info.review_qa_list[].answer`。
 *
 * 被邀请入群（`apply_source = invited`）没有验证信息，此时不带 `reason`。
 */
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
  const method = trimmed(asString(verifyInfo?.method));
  const verifyMessage = trimmed(asString(verifyInfo?.verify_message));

  const questions: string[] = [];
  const answers: string[] = [];
  const qaList = Array.isArray(verifyInfo?.review_qa_list)
    ? verifyInfo.review_qa_list
    : [];
  for (const item of qaList) {
    if (!isRecord(item)) {
      continue;
    }
    const question = trimmed(asString(item.question));
    const answer = trimmed(asString(item.answer));
    if (question !== undefined) {
      questions.push(question);
    }
    if (answer !== undefined) {
      answers.push(answer);
    }
  }

  const reason =
    verifyMessage ?? (answers.length > 0 ? answers.join("  ") : undefined);
  if (reason === undefined) {
    // 字段名不对时只记录「有哪些字段」，不打印答案原文（避免把个人信息写进日志）
    log.debug("join request has no answer", {
      method,
      applySource: asString(data.apply_source),
      hasVerifyInfo: verifyInfo !== undefined,
      verifyKeys: verifyInfo ? Object.keys(verifyInfo) : [],
      qaCount: qaList.length,
    });
  }

  const applicantName = trimmed(asString(data.username));
  const applySource = trimmed(asString(data.apply_source));
  return {
    type: "join_request",
    groupId,
    userId,
    requestId,
    ...(reason !== undefined ? { reason } : {}),
    ...(applicantName !== undefined ? { applicantName } : {}),
    ...(method !== undefined ? { verifyMethod: method } : {}),
    ...(applySource !== undefined ? { applySource } : {}),
    ...(questions.length > 0 ? { questions } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}
