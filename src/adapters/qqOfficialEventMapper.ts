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
    if (eventType === "INTERACTION_CREATE") {
      return mapInteraction(data);
    }
    return null;
  }
}

/**
 * 互动事件（官方 `INTERACTION_CREATE`，intent `INTERACTION (1<<26)`）。
 *
 * 按钮回调：`type=11`（消息按钮）/ `type=12`（快捷菜单），数据在 `data.resolved`：
 * - `button_data` = 按钮定义里的 `data`（我们用它区分页码）；
 * - `button_id` = 按钮 id；
 * - 群聊场景额外带 `group_openid` 与 `group_member_openid`（点击者）。
 *
 * 收到后**必须**调 `PUT /interactions/{id}` 回应，否则客户端会一直 loading 到超时。
 */
function mapInteraction(data: unknown): QQEvent | null {
  if (!isRecord(data)) {
    return null;
  }
  const interactionId = trimmed(asString(data.id));
  if (!interactionId) {
    return null;
  }
  const resolved =
    isRecord(data.data) && isRecord(data.data.resolved)
      ? data.data.resolved
      : undefined;
  const rawType =
    typeof data.type === "number"
      ? data.type
      : Number.parseInt(String(data.type ?? ""), 10);
  const scene = trimmed(asString(data.scene));
  const chatType = typeof data.chat_type === "number" ? data.chat_type : undefined;
  const groupId = trimmed(asString(data.group_openid));
  const userId =
    trimmed(asString(data.group_member_openid)) ??
    trimmed(asString(data.user_openid));
  const buttonId = trimmed(asString(resolved?.button_id));
  const buttonData = asString(resolved?.button_data);
  const messageId = trimmed(asString(resolved?.message_id));
  return {
    type: "interaction",
    interactionId,
    interactionType: Number.isNaN(rawType) ? 0 : rawType,
    ...(scene !== undefined ? { scene } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(buttonId !== undefined ? { buttonId } : {}),
    ...(buttonData !== undefined ? { buttonData } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

function mapGroupMessage(data: unknown): QQEvent | null {
  if (!isRecord(data)) {
    return null;
  }
  const groupId = asString(data.group_openid);
  const messageId = asString(data.id);
  const rawContent = asString(data.content);
  const author = isRecord(data.author) ? data.author : undefined;
  const userId =
    asString(author?.member_openid) ??
    asString(author?.user_openid) ??
    asString(author?.id);
  if (!groupId || !messageId || rawContent === undefined || !userId) {
    return null;
  }
  const content = stripBotMention(rawContent);
  // 诊断：@ 了机器人但剥离后既不是指令也不是空内容 —— 说明提及格式没识别出来。
  // 只记录前缀形状（转义后的前 16 个码点），用于现场定位格式，不落库、不写审计。
  if (looksMentionLike(rawContent) && content.length > 0 && !content.startsWith("/")) {
    log.debug("group message with unparsed mention", {
      ...describeContentShape(rawContent, content),
    });
  }
  return {
    type: "group_message",
    groupId,
    userId,
    messageId,
    content,
  };
}

/** 零宽 / 双向控制 / BOM 等不可见字符：QQ 客户端会在 @ 提及前后插入。 */
const INVISIBLE_CHARS = "\\u200B-\\u200F\\u2060-\\u2064\\u2066-\\u2069\\uFEFF";
const LEADING_NOISE = new RegExp(`^[\\s${INVISIBLE_CHARS}]+`, "u");
const INVISIBLE_PATTERN = new RegExp(`[${INVISIBLE_CHARS}]`, "u");
/** `<@!123>` / `<@123>` / `<@！123>` / `<@任意内容>`，后面允许多个空白或不可见字符。 */
const ANGLE_MENTION = new RegExp(
  `^<@[^>\\s]*>[\\s${INVISIBLE_CHARS}]*`,
  "u",
);
/** 客户端可能把提及渲染成 `@昵称`（而不是 `<@id>`）。 */
const AT_MENTION = new RegExp(`^@[^\\s/]+[\\s${INVISIBLE_CHARS}]*`, "u");

/**
 * 去掉群聊 @机器人 留下的提及前缀。
 *
 * 官方字段没有统一格式，实测可能是 `<@!1234567890>`（机器人 appid）、`<@!abc>`，
 * 也可能是带零宽/双向控制字符的 `@昵称`；不做这一步的话：
 * - `@机器人 /menu` 会被当成普通消息送去关键词审核，而不是指令分发；
 * - `@机器人`（不带内容）识别不出「空内容 → 主菜单」。
 *
 * 只剥离**开头连续**的提及与不可见字符，正文里的其它内容一律不动。
 * `@昵称` 这种写法只在后面紧跟 `/指令`（或没有内容）时才剥离：普通聊天
 * 「@张三 你好」不受影响，而「@机器人 /menu」能正常识别。
 */
export function stripBotMention(content: string): string {
  let rest = content.replace(LEADING_NOISE, "");
  for (let round = 0; round < 5; round += 1) {
    const angle = rest.match(ANGLE_MENTION);
    if (angle) {
      rest = rest.slice(angle[0].length).replace(LEADING_NOISE, "");
      continue;
    }
    const at = rest.match(AT_MENTION);
    if (at) {
      const remainder = rest.slice(at[0].length).replace(LEADING_NOISE, "");
      if (remainder.startsWith("/") || remainder.length === 0) {
        rest = remainder;
        continue;
      }
    }
    break;
  }
  return rest;
}

/** 内容里是否出现提及/不可见字符特征（用来决定要不要打诊断日志）。 */
function looksMentionLike(content: string): boolean {
  return content.includes("@") || INVISIBLE_PATTERN.test(content);
}

/** 转义后的短前缀 + 长度信息，用于定位未识别的提及格式（不打印完整正文）。 */
function describeContentShape(
  raw: string,
  cleaned: string,
): Record<string, unknown> {
  const invisibleCodePoints = [
    ...new Set(
      [...raw]
        .filter((char) => INVISIBLE_PATTERN.test(char))
        .map((char) =>
          `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
        ),
    ),
  ];
  return {
    rawLength: raw.length,
    cleanedLength: cleaned.length,
    hasAngleMention: /<@/u.test(raw),
    hasAtMention: /@/u.test(raw),
    invisibleCodePoints,
    leading: escapePreview(raw),
  };
}

/** 前 16 个码点，控制字符与不可见字符转成 `\uXXXX`，便于看出真实格式。 */
function escapePreview(content: string, max = 16): string {
  return [...content]
    .slice(0, max)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        INVISIBLE_PATTERN.test(char)
      ) {
        return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
      }
      return char;
    })
    .join("");
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
