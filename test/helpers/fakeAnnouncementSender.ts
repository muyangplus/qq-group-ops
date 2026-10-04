import type {
  AnnouncementSender,
} from "../../src/services/scheduledAnnouncements.js";
import type { RichMessage, RichSendResult } from "../../src/services/richMessages.js";

/**
 * 定时发言的假发送通道：记录每一次群发 / 纯文本 / 私信，并可按需失败。
 *
 * 服务层与指令层的测试共用（结构上满足 `AnnouncementSender`；
 * 真实的 `RichMessageSender` 也同样满足）。
 */
export class FakeAnnouncementSender implements AnnouncementSender {
  public readonly groupMessages: Array<{
    groupId: string;
    message: RichMessage;
    msgId?: string;
  }> = [];
  public readonly plainMessages: Array<{ groupId: string; content: string }> = [];
  public readonly directMessages: Array<{ userId: string; message: RichMessage }> = [];
  public failGroup = false;
  /** 群发成功时报告的模式（用来模拟按钮被平台降级掉）。 */
  public groupMode: RichSendResult["mode"] = "markdown+keyboard";
  public idCounter = 0;

  public async sendToGroup(
    groupId: string,
    message: RichMessage,
  ): Promise<RichSendResult> {
    if (this.failGroup) {
      return { ok: false, detail: "fake group failure", mode: "none" };
    }
    this.groupMessages.push({ groupId, message });
    return { ok: true, detail: "", mode: this.groupMode, messageId: this.nextId() };
  }

  public async replyToGroup(
    groupId: string,
    message: RichMessage,
    options: { msgId: string },
  ): Promise<RichSendResult> {
    if (this.failGroup) {
      return { ok: false, detail: "fake group failure", mode: "none" };
    }
    this.groupMessages.push({ groupId, message, msgId: options.msgId });
    return { ok: true, detail: "", mode: this.groupMode, messageId: this.nextId() };
  }

  public async sendPlainToGroup(
    groupId: string,
    content: string,
  ): Promise<RichSendResult> {
    if (this.failGroup) {
      return { ok: false, detail: "fake group failure", mode: "none" };
    }
    this.plainMessages.push({ groupId, content });
    return { ok: true, detail: "", mode: "text", messageId: this.nextId() };
  }

  public async sendToUser(
    userId: string,
    message: RichMessage,
  ): Promise<RichSendResult> {
    this.directMessages.push({ userId, message });
    return { ok: true, detail: "", mode: "markdown" };
  }

  private nextId(): string {
    this.idCounter += 1;
    return `mid-${this.idCounter}`;
  }
}
