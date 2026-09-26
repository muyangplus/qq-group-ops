import type { KeyboardPayload, QQOfficialAPI } from "../adapters/qqOfficial.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("rich-messages");

/** 一条富消息：Markdown 正文 + 可选按钮 + 纯文本降级。 */
export interface RichMessage {
  markdown: string;
  keyboard?: KeyboardPayload | undefined;
  /** 客户端/平台都不支持富消息时发送的纯文本。 */
  text: string;
}

export type RichSendMode = "markdown+keyboard" | "markdown" | "text";

export interface RichSendResult {
  ok: boolean;
  /** 成功时为降级说明（空 = 完整富消息），失败时为错误信息。 */
  detail: string;
  mode: RichSendMode | "none";
}

export interface RichReplyOptions {
  /** 被动回复的 `msg_id`；缺省时直接主动发送。 */
  msgId?: string | undefined;
  /** 被动回复全部失败后是否降级为主动发送（默认 true）。 */
  activeFallback?: boolean | undefined;
}

interface Attempt {
  mode: RichSendMode;
  /**
   * 是否为被动回复（带 `msg_id`）。
   *
   * 群聊被动回复有 5 分钟窗口、单聊同一 `msg_id` 最多 5 次；主动发送则受
   * 「允许主动发送」开关与频控约束。两种通道都可能失败，所以统一做降级。
   */
  passive: boolean;
}

/**
 * 富消息发送器（Markdown + 内嵌按钮）。
 *
 * 三级降级：Markdown+按钮 → Markdown → 纯文本。
 * 自定义按钮是官方内邀能力，一旦被拒就记住该状态、后续不再尝试按钮，
 * 避免每条消息都白打一次。
 *
 * 回复指令时优先走**被动回复**（`msg_id`），全部失败再降级为主动发送；
 * 主动发送失败不影响事件处理链，由调用方决定是否记日志。
 */
export class RichMessageSender {
  /**
   * 自定义按钮可用性**按目标分开**记录：C2C 的一次失败不能连累群卡片（真机回归）。
   *
   * 之前的实现是一个全局布尔：沙箱下给新用户发私信 400「沙箱环境不能访问此资源」后，
   * 后续所有群卡片都被降级成 `keyboard:false`，群里彻底丢按钮。
   */
  private readonly keyboardDisabled = { user: false, group: false };

  public constructor(private readonly api: QQOfficialAPI) {}

  /** 群里是否还能用自定义按钮（群卡片/群广播的主要判据）。 */
  public get keyboardAvailable(): boolean {
    return !this.keyboardDisabled.group;
  }

  /** 指定目标是否还能用自定义按钮（私信卡片判据）。 */
  public keyboardAvailableFor(target: "user" | "group"): boolean {
    return !this.keyboardDisabled[target];
  }

  /** 主动私聊发送。 */
  public sendToUser(
    userOpenid: string,
    message: RichMessage,
  ): Promise<RichSendResult> {
    return this.run("user", userOpenid, message, {});
  }

  /** 主动群聊发送。 */
  public sendToGroup(
    groupId: string,
    message: RichMessage,
  ): Promise<RichSendResult> {
    return this.run("group", groupId, message, {});
  }

  /**
   * 主动发一条**纯文本**群消息。
   *
   * 官方的内嵌格式（`<@!openid>` 提及、`@everyone`）**只在 `content` 里生效**，
   * 而 Markdown 消息（`msg_type=2`）的 payload 不带 `content`，所以「真 @ 到人」
   * 必须走这条纯文本通道；需要正文时再补发一张卡片。
   */
  public async sendPlainToGroup(
    groupId: string,
    content: string,
  ): Promise<RichSendResult> {
    try {
      await this.api.sendGroupMessage(groupId, content);
      return { ok: true, detail: "", mode: "text" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        mode: "none",
      };
    }
  }

  /** 主动发一条**纯文本**私聊消息（同样用于内嵌格式）。 */
  public async sendPlainToUser(
    userOpenid: string,
    content: string,
  ): Promise<RichSendResult> {
    try {
      await this.api.sendPrivateMessage(userOpenid, content);
      return { ok: true, detail: "", mode: "text" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        mode: "none",
      };
    }
  }

  /** 回复用户：优先被动回复，失败降级为主动发送。 */
  public replyToUser(
    userOpenid: string,
    message: RichMessage,
    options: RichReplyOptions = {},
  ): Promise<RichSendResult> {
    return this.run("user", userOpenid, message, options);
  }

  /** 回复群消息：优先被动回复，失败降级为主动发送。 */
  public replyToGroup(
    groupId: string,
    message: RichMessage,
    options: RichReplyOptions = {},
  ): Promise<RichSendResult> {
    return this.run("group", groupId, message, options);
  }

  private async run(
    target: "user" | "group",
    targetId: string,
    message: RichMessage,
    options: RichReplyOptions,
  ): Promise<RichSendResult> {
    const msgId = options.msgId?.trim() ? options.msgId : undefined;
    const activeFallback = options.activeFallback ?? true;

    const modes: RichSendMode[] = [];
    if (message.keyboard && !this.keyboardDisabled[target]) {
      modes.push("markdown+keyboard");
    }
    modes.push("markdown", "text");

    const attempts: Attempt[] = [];
    if (msgId) {
      for (const mode of modes) {
        attempts.push({ mode, passive: true });
      }
    }
    if (!msgId || activeFallback) {
      for (const mode of modes) {
        attempts.push({ mode, passive: false });
      }
    }

    const primary = attempts[0]!;
    let lastError = "";
    for (const attempt of attempts) {
      try {
        await this.sendOnce(
          target,
          targetId,
          message,
          attempt.mode,
          attempt.passive ? msgId : undefined,
        );
        return {
          ok: true,
          detail: describeAttempt(attempt, primary, Boolean(msgId)),
          mode: attempt.mode,
        };
      } catch (error) {
        const failure = describeError(error);
        lastError = failure.text;
        // 只有「主动发送也带不上按钮」才能断定平台不支持自定义按钮。
        // 被动回复失败往往只是 msg_id 无效/越权（实测：群聊里把 interaction id 当
        // msg_id 会返回 400），把它当成键盘被拒会让后续卡片全部丢按钮。
        if (attempt.mode === "markdown+keyboard" && !attempt.passive) {
          this.handleKeyboardFailure(target, failure, message);
        }
        log.debug("rich message attempt failed", {
          target,
          mode: attempt.mode,
          passive: attempt.passive,
          error: lastError,
          ...(failure.errorCode !== undefined
            ? { errorCode: failure.errorCode }
            : {}),
          ...(failure.traceId !== undefined ? { traceId: failure.traceId } : {}),
          cardTitle: cardTitleOf(message),
        });
      }
    }
    log.warn("rich message delivery failed", {
      target,
      error: lastError,
      passiveFirst: Boolean(msgId),
      cardTitle: cardTitleOf(message),
    });
    return { ok: false, detail: lastError, mode: "none" };
  }

  /**
   * 键盘被拒的分类处理。
   *
   * 只有**明确「平台不支持按钮」**时才永久关掉该目标的键盘；内容审核、沙箱、权限这类
   * 属于「这次不行」的错误（真机踩过：群规则卡片里列出违规词 → 400 消息内容违规），
   * 一旦当成「不支持」，这个群后续所有卡片都会永久丢按钮（与 C2C 那次同源的 bug）。
   */
  private handleKeyboardFailure(
    target: "user" | "group",
    failure: { text: string; errorCode?: number | undefined },
    message: RichMessage,
  ): void {
    if (this.keyboardDisabled[target]) {
      return;
    }
    const kind = classifyKeyboardFailure(failure.text);
    if (kind !== "unsupported") {
      log.warn("keyboard skipped for this message only", {
        target,
        kind,
        error: failure.text,
        ...(failure.errorCode !== undefined
          ? { errorCode: failure.errorCode }
          : {}),
        cardTitle: cardTitleOf(message),
        buttons: countButtons(message),
      });
      return;
    }
    this.keyboardDisabled[target] = true;
    log.warn(
      "custom keyboard rejected by platform, falling back to markdown/text",
      {
        target,
        error: failure.text,
        reason: kind,
        cardTitle: cardTitleOf(message),
        buttons: countButtons(message),
      },
    );
  }

  private sendOnce(
    target: "user" | "group",
    targetId: string,
    message: RichMessage,
    mode: RichSendMode,
    passiveMsgId: string | undefined,
  ): Promise<unknown> {
    const options =
      mode === "text"
        ? undefined
        : {
            markdown: message.markdown,
            ...(mode === "markdown+keyboard" && message.keyboard
              ? { keyboard: message.keyboard }
              : {}),
          };
    if (target === "user") {
      return mode === "text"
        ? this.api.sendPrivateMessage(targetId, message.text, passiveMsgId)
        : this.api.sendPrivateMessage(targetId, "", passiveMsgId, options);
    }
    return mode === "text"
      ? this.api.sendGroupMessage(targetId, message.text, passiveMsgId)
      : this.api.sendGroupMessage(targetId, "", passiveMsgId, options);
  }
}

/**
 * 键盘失败归类：
 *
 * - `sandbox`：沙箱环境限制（不是「不支持按钮」）；
 * - `permission`：应用无接口访问权限（没开接口，也不是「不支持按钮」）；
 * - `content`：内容审核/违规（跟这条消息的内容有关，换一张卡还能带按钮）；
 * - `unsupported`：其余按「平台确实用不了自定义按钮」处理（唯一会永久禁用键盘的情况）。
 */
export function classifyKeyboardFailure(
  error: string,
): "sandbox" | "permission" | "content" | "unsupported" {
  if (/沙箱环境/u.test(error)) {
    return "sandbox";
  }
  if (/应用无接口访问权限|无权限/u.test(error)) {
    return "permission";
  }
  if (/消息内容违规|内容违规|敏感|违规/u.test(error)) {
    return "content";
  }
  return "unsupported";
}

/** 从卡片 Markdown 里取标题（`## 标题`）——只记标题，不把正文写进日志。 */
export function cardTitleOf(message: RichMessage): string {
  const match = /^#+\s*(.+)$/mu.exec(message.markdown);
  return (match?.[1] ?? "").trim().slice(0, 40);
}

function countButtons(message: RichMessage): number {
  return (
    message.keyboard?.content.rows.reduce(
      (total, row) => total + row.buttons.length,
      0,
    ) ?? 0
  );
}

/** 官方错误里可用的定位信息：`errorCode` 与响应体里的 `trace_id`（日志用）。 */
export function describeError(error: unknown): {
  text: string;
  errorCode?: number | undefined;
  traceId?: string | undefined;
} {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  const payload = (error as { payload?: unknown } | null)?.payload;
  const trace =
    typeof payload === "object" && payload !== null
      ? ((payload as Record<string, unknown>).trace_id ??
        (payload as Record<string, unknown>).traceId)
      : undefined;
  return {
    text,
    ...(typeof code === "number" ? { errorCode: code } : {}),
    ...(typeof trace === "string" && trace.length > 0 ? { traceId: trace } : {}),
  };
}
/**
 * 降级说明：
 * - 第一个尝试成功 → 空字符串（完整富消息）；
 * - 按钮被跳过 → `markdown_fallback` / `text_fallback`；
 * - 被动回复失败改用主动发送 → `active_fallback`（可与其他标记组合）。
 */
function describeAttempt(
  attempt: Attempt,
  primary: Attempt,
  attemptedPassive: boolean,
): string {
  if (attempt.mode === primary.mode && attempt.passive === primary.passive) {
    return "";
  }
  const parts: string[] = [];
  if (attempt.mode !== "markdown+keyboard") {
    parts.push(`${attempt.mode}_fallback`);
  }
  if (attemptedPassive && !attempt.passive) {
    parts.push("active_fallback");
  }
  return parts.length > 0 ? parts.join("+") : "passive_fallback";
}
