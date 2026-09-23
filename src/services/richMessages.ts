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

export interface RichSendResult {
  ok: boolean;
  /** 成功时为降级说明（空 = 完整富消息），失败时为错误信息。 */
  detail: string;
  mode: "markdown+keyboard" | "markdown" | "text" | "none";
}

/**
 * 富消息发送器（Markdown + 内嵌按钮）。
 *
 * 三级降级：Markdown+按钮 → Markdown → 纯文本。
 * 自定义按钮是官方内邀能力，一旦被拒就记住该状态、后续不再尝试按钮，
 * 避免每条消息都白打一次。
 */
export class RichMessageSender {
  private keyboardDisabled = false;

  public constructor(private readonly api: QQOfficialAPI) {}

  public get keyboardAvailable(): boolean {
    return !this.keyboardDisabled;
  }

  public sendToUser(
    userOpenid: string,
    message: RichMessage,
  ): Promise<RichSendResult> {
    return this.run("user", message, (mode) =>
      mode === "text"
        ? this.api.sendPrivateMessage(userOpenid, message.text)
        : this.api.sendPrivateMessage(userOpenid, "", undefined, {
            markdown: message.markdown,
            ...(mode === "markdown+keyboard" && message.keyboard
              ? { keyboard: message.keyboard }
              : {}),
          }),
    );
  }

  public sendToGroup(
    groupId: string,
    message: RichMessage,
  ): Promise<RichSendResult> {
    return this.run("group", message, (mode) =>
      mode === "text"
        ? this.api.sendGroupMessage(groupId, message.text)
        : this.api.sendGroupMessage(groupId, "", undefined, {
            markdown: message.markdown,
            ...(mode === "markdown+keyboard" && message.keyboard
              ? { keyboard: message.keyboard }
              : {}),
          }),
    );
  }

  private async run(
    target: "user" | "group",
    message: RichMessage,
    send: (
      mode: "markdown+keyboard" | "markdown" | "text",
    ) => Promise<unknown>,
  ): Promise<RichSendResult> {
    const modes: Array<"markdown+keyboard" | "markdown" | "text"> = [];
    if (message.keyboard && !this.keyboardDisabled) {
      modes.push("markdown+keyboard");
    }
    modes.push("markdown", "text");

    let lastError = "";
    for (const mode of modes) {
      try {
        await send(mode);
        return {
          ok: true,
          detail: mode === "markdown+keyboard" ? "" : `${mode}_fallback`,
          mode,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (mode === "markdown+keyboard" && !this.keyboardDisabled) {
          this.keyboardDisabled = true;
          log.warn(
            "custom keyboard rejected by platform, falling back to markdown/text",
            { target, error: lastError },
          );
        } else {
          log.debug("rich message attempt failed", {
            target,
            mode,
            error: lastError,
          });
        }
      }
    }
    log.warn("rich message delivery failed", { target, error: lastError });
    return { ok: false, detail: lastError, mode: "none" };
  }
}
