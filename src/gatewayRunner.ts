import type { EventGateway } from "./adapters/eventGateway.js";
import { isRateLimitedError } from "./adapters/qqOfficial.js";
import { getLogger } from "./core/logger.js";
import type { Runtime } from "./runtime.js";
import type { RichMessage } from "./services/richMessages.js";

const log = getLogger("gateway-runner");

export async function attachGateway(
  runtime: Runtime,
  gateway: EventGateway,
): Promise<void> {
  await gateway.start(async (event) => {
    const result = await runtime.router.handle(event);
    // 回复用户前先确保本次事件产生的状态变更已落库。
    await runtime.flush();
    // 私信首次交互：记录并准备推送一次主菜单（dev 只记内存，正式入库）
    const privateUserId =
      event.type === "private_message" ? event.userId : undefined;
    const firstPrivate =
      privateUserId !== undefined ? runtime.menuState.claim(privateUserId) : false;
    if (
      (result.kind === "command" || result.kind === "private_message") &&
      (result.text || result.rich)
    ) {
      await sendReply(runtime, event, result.text ?? "", result.rich);
    }
    // 空私信的回复本身就是主菜单，不再重复推一次
    const menuAlreadyReplied =
      event.type === "private_message" && event.content.trim().length === 0;
    if (firstPrivate && !menuAlreadyReplied && privateUserId !== undefined) {
      await pushMainMenu(runtime, privateUserId);
    }
  });
}

type ReplyEvent =
  | { type: "private_message"; userId: string; messageId: string }
  | { type: "group_message"; groupId: string; messageId: string }
  | { type: "admin_command"; groupId: string; userId: string }
  /** 互动事件由处理器自行回包与回复，这里只是让类型联合完整。 */
  | { type: "interaction" }
  | { type: "join_request" };

/**
 * 发送回复。
 *
 * 有富回复（Markdown + 按钮）时优先走 `RichMessageSender`：先被动回复、失败再降级主动
 * 发送，内部再做「Markdown+按钮 → Markdown → 纯文本」三级降级。
 * 回复失败（限流、被动回复配额耗尽、网络错误）不应该让整个事件处理链抛出异常，
 * 否则 WebSocket 消息处理器会产生未处理拒绝；这里统一降级为日志。
 */
async function sendReply(
  runtime: Runtime,
  event: ReplyEvent,
  text: string,
  rich?: RichMessage | undefined,
): Promise<void> {
  try {
    if (event.type === "private_message") {
      log.debug("sending private reply", {
        userId: event.userId,
        messageId: event.messageId,
        rich: Boolean(rich),
      });
      if (rich) {
        const result = await runtime.richMessages.replyToUser(
          event.userId,
          rich,
          { msgId: event.messageId },
        );
        if (!result.ok) {
          log.warn("rich reply failed", {
            target: "user",
            detail: result.detail,
          });
        }
        return;
      }
      await runtime.api.sendPrivateMessage(
        event.userId,
        text,
        event.messageId,
      );
      return;
    }
    if (event.type === "group_message") {
      log.debug("sending command reply", {
        groupId: event.groupId,
        messageId: event.messageId,
        rich: Boolean(rich),
      });
      if (rich) {
        const result = await runtime.richMessages.replyToGroup(
          event.groupId,
          rich,
          { msgId: event.messageId },
        );
        if (!result.ok) {
          log.warn("rich reply failed", {
            target: "group",
            detail: result.detail,
          });
        }
        return;
      }
      await runtime.api.sendGroupMessage(event.groupId, text, event.messageId);
      return;
    }
    if (event.type === "admin_command") {
      log.debug("sending admin reply", {
        groupId: event.groupId,
        rich: Boolean(rich),
      });
      if (rich) {
        await runtime.richMessages.sendToGroup(event.groupId, rich);
        return;
      }
      await runtime.api.sendGroupMessage(event.groupId, text);
    }
  } catch (error) {
    log.error("failed to send reply", {
      type: event.type,
      rateLimited: isRateLimitedError(error),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 首次私信交互时主动推一次主菜单（失败只记日志，不影响指令回复）。 */
async function pushMainMenu(runtime: Runtime, userId: string): Promise<void> {
  try {
    const menu = runtime.adminCommands.mainMenu(undefined, userId);
    const result = await runtime.richMessages.sendToUser(userId, menu);
    if (!result.ok) {
      log.warn("failed to push first private menu", {
        userId,
        detail: result.detail,
      });
      return;
    }
    log.debug("first private menu pushed", { userId, mode: result.mode });
  } catch (error) {
    log.error("failed to push first private menu", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
