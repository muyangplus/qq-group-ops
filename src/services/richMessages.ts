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
  private keyboardDisabled = false;

  public constructor(private readonly api: QQOfficialAPI) {}

  public get keyboardAvailable(): boolean {
    return !this.keyboardDisabled;
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
    if (message.keyboard && !this.keyboardDisabled) {
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
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt.mode === "markdown+keyboard" && !this.keyboardDisabled) {
          this.keyboardDisabled = true;
          log.warn(
            "custom keyboard rejected by platform, falling back to markdown/text",
            { target, error: lastError },
          );
        } else {
          log.debug("rich message attempt failed", {
            target,
            mode: attempt.mode,
            passive: attempt.passive,
            error: lastError,
          });
        }
      }
    }
    log.warn("rich message delivery failed", {
      target,
      error: lastError,
      passiveFirst: Boolean(msgId),
    });
    return { ok: false, detail: lastError, mode: "none" };
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
