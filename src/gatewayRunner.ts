import type { EventGateway } from "./adapters/eventGateway.js";
import { isRateLimitedError } from "./adapters/qqOfficial.js";
import { getLogger } from "./core/logger.js";
import type { Runtime } from "./runtime.js";

const log = getLogger("gateway-runner");

export async function attachGateway(
  runtime: Runtime,
  gateway: EventGateway,
): Promise<void> {
  await gateway.start(async (event) => {
    const result = await runtime.router.handle(event);
    // 回复用户前先确保本次事件产生的状态变更已落库。
    await runtime.flush();
    if (
      (result.kind === "command" || result.kind === "private_message") &&
      result.text
    ) {
      await sendReply(runtime, event, result.text);
    }
  });
}

type ReplyEvent =
  | { type: "private_message"; userId: string; messageId: string }
  | { type: "group_message"; groupId: string; messageId: string }
  | { type: "admin_command"; groupId: string; userId: string }
  | { type: "join_request" };

/**
 * 发送回复。
 *
 * 回复失败（限流、被动回复配额耗尽、网络错误）不应该让整个事件处理链抛出异常，
 * 否则 WebSocket 消息处理器会产生未处理拒绝；这里统一降级为日志。
 */
async function sendReply(
  runtime: Runtime,
  event: ReplyEvent,
  text: string,
): Promise<void> {
  try {
    if (event.type === "private_message") {
      log.debug("sending private reply", {
        userId: event.userId,
        messageId: event.messageId,
      });
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
      });
      await runtime.api.sendGroupMessage(event.groupId, text, event.messageId);
      return;
    }
    if (event.type === "admin_command") {
      log.debug("sending admin reply", { groupId: event.groupId });
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
