import { getLogger } from "../core/logger.js";
import type { QQEvent } from "../services/eventRouter.js";

const log = getLogger("qq-official-event-mapper");

export interface OfficialEventMapper {
  map(eventType: string, data: unknown): QQEvent | null;
}

export interface OfficialEventMapperOptions {
  /**
   * 未处理事件类型的回调：**每种类型只回调一次**（进程内去重），由装配方负责
   * 「私信超管」。日志侧不受影响——每次收到未知类型都会记一条 warn。
   */
  onUnhandledEvent?:
    | ((info: { eventType: string; payload: unknown }) => void)
    | undefined;
}

/** 未处理事件 payload 的日志/通知摘要：JSON 截断，避免几 KB 的 payload 撑爆卡片与日志。 */
const PAYLOAD_SUMMARY_MAX = 800;

function summarizePayload(data: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(data) ?? String(data);
  } catch {
    json = String(data);
  }
  return json.length > PAYLOAD_SUMMARY_MAX
    ? `${json.slice(0, PAYLOAD_SUMMARY_MAX)}…`
    : json;
}

/** 本项目已经处理的事件类型（其余类型只会被记一条日志，便于真机确认官方还会推什么）。 */
const HANDLED_EVENT_TYPES = new Set([
  "GROUP_AT_MESSAGE_CREATE",
  "GROUP_MESSAGE_CREATE",
  "GROUP_JOIN_REQUEST",
  "C2C_MESSAGE_CREATE",
  "INTERACTION_CREATE",
]);

/** 官方事件类型是否已被本项目处理（纯函数，便于单测）。 */
export function isHandledEventType(eventType: string): boolean {
  return HANDLED_EVENT_TYPES.has(eventType);
}

/**
 * 官方事件映射器。
 *
 * §能力探测（A2 / R2 / R3）：**没被处理的事件类型按 info 级记一条日志**（同一类型只记一次），
 * 带 `eventType` 与 payload 的**顶层字段名**（不记值，避免隐私）。用途：
 * - 好友申请 / 机器人被拉进群（A2）：后台不一定能看到，日志能直接证明官方有没有推事件；
 * - 用户撤回消息（R2）：有事件就会出现在这里；
 * - 平台新增能力：先把类型和字段形状暴露出来，再决定要不要实现。
 */
export class QQOfficialEventMapper implements OfficialEventMapper {
  /** 已经**通知过**的未知事件类型（同类型只通知一次，避免刷私信）。 */
  private readonly reportedUnhandled = new Set<string>();
  private readonly onUnhandledEvent:
    | ((info: { eventType: string; payload: unknown }) => void)
    | undefined;

  public constructor(options: OfficialEventMapperOptions = {}) {
    this.onUnhandledEvent = options.onUnhandledEvent;
  }

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
    this.reportUnhandled(eventType, data);
    return null;
  }

  /**
   * 未处理事件：**每次都记 warn**（带类型、顶层字段名与截断后的 payload），
   * **每种类型只通知一次超管**（`onUnhandledEvent` 由装配方接线）。
   */
  private reportUnhandled(eventType: string, data: unknown): void {
    const type = eventType.trim();
    if (type.length === 0) {
      return;
    }
    log.warn("unhandled official event (ignored)", {
      eventType: type,
      dataKeys: isRecord(data) ? Object.keys(data).slice(0, 40) : [],
      payload: summarizePayload(data),
    });
    if (this.reportedUnhandled.has(type)) {
      return;
    }
    this.reportedUnhandled.add(type);
    this.onUnhandledEvent?.({ eventType: type, payload: data });
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
  // §R1 探测：把 @ 相关原文的**形状**打进日志（不落库、不写审计、不打印完整正文）。
  // - 命中「@全体」类关键词 → info 级，开箱即见，用来确认官方事件里 @全体 的真实表示（B3 依赖）；
  // - 其它带 @ / 不可见字符的内容 → debug 级（需 LOG_LEVEL=debug），用来定位没识别出的提及格式。
  const probe = classifyMentionProbe(rawContent);
  if (probe !== "none") {
    const shape = describeContentShape(rawContent, content);
    if (probe === "at-all") {
      log.info("mention probe: at-all candidate", shape);
    } else {
      log.debug("mention probe: mention-like content", shape);
    }
  }
  // §B3：整条消息就是「@全体」广播（剥离提及后没有正文）→ 直接丢弃。
  //
  // 真机确认（R1，2026-09-26）：`@全体成员` 在事件里是 `<@all> `，`@everyone` 是 `@everyone`。
  // 它们会被 `stripBotMention` 当作机器人提及剥掉、剩下空内容，进而被当成「空 @机器人」
  // 回一张常用菜单——群里有人 @全体 时机器人就抢答。这里短路掉：
  // 不回复、不送关键词审核、不写审计、不处罚（没有正文可审）。
  if (content.length === 0 && isAtAllBroadcast(rawContent)) {
    log.info("mention probe: skipped at-all mention", describeContentShape(rawContent, content));
    return null;
  }
  return {
    type: "group_message",
    groupId,
    userId,
    messageId,
    content,
  };
}

/** 客户端可能把 @全体 写成这些样子（大小写不敏感）。 */
const AT_ALL_HINT =
  /(@\s*(全体|全體|全员|所有人)|<@!?(all|everyone)>|@(all|everyone)\b)/iu;

/**
 * §R1 探测判定（纯函数，便于单测）：
 * - `at-all`：原文像「@全体」→ info 级日志；
 * - `mention`：原文有 @ 或不可见字符 → debug 级日志；
 * - `none`：普通聊天，不记。
 */
export function classifyMentionProbe(raw: string): "at-all" | "mention" | "none" {
  if (AT_ALL_HINT.test(raw)) {
    return "at-all";
  }
  return looksMentionLike(raw) ? "mention" : "none";
}

/**
 * §B3：这条原文是不是以「@全体」开头的广播。
 *
 * 判定只看**开头**：`大家好 @全体成员` 这种半路提及不算（它是正常发言，照常审核）；
 * 真正的群广播一定是 @全体 打头。
 */
export function isAtAllBroadcast(raw: string): boolean {
  return AT_ALL_PREFIX.test(raw);
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
 * §B3：开头就是「@全体」写法（允许前置空白 / 不可见字符）。
 *
 * 只锚定开头：`大家好 @全体成员` 这类半路提及不是广播，照常走审核。
 */
const AT_ALL_PREFIX = new RegExp(
  `^[\\s${INVISIBLE_CHARS}]*(?:<@!?(?:all|everyone)>|@(?:all|everyone)\\b|@(?:全体成员|全体|全體|全员|所有人))`,
  "iu",
);

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
 * 开头的 `@全体成员` / `<@all>` / `@everyone` 一律剥掉：它是广播标记不是「@某人」
 * （§B3；整条只有 @全体 时由 `isAtAllBroadcast` 判为广播直接丢弃）。
 */
export function stripBotMention(content: string): string {
  let rest = content.replace(LEADING_NOISE, "");
  for (let round = 0; round < 5; round += 1) {
    const angle = rest.match(ANGLE_MENTION);
    if (angle) {
      rest = rest.slice(angle[0].length).replace(LEADING_NOISE, "");
      continue;
    }
    // §B3：开头的 @全体 是广播标记，不是「@某人」，无条件剥掉（不留进正文）
    const atAll = rest.match(AT_ALL_PREFIX);
    if (atAll) {
      rest = rest.slice(atAll[0].length).replace(LEADING_NOISE, "");
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
export function describeContentShape(
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
    // 提及是否真的被剥离了：false + 正文不是指令 = 出现没识别出的提及格式
    stripped: raw !== cleaned,
    isCommand: cleaned.startsWith("/"),
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
