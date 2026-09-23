import type { EventGateway } from "./adapters/eventGateway.js";
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
      if (event.type === "private_message") {
        log.debug("sending private reply", {
          userId: event.userId,
          messageId: event.messageId,
        });
        await runtime.api.sendPrivateMessage(
          event.userId,
          result.text,
          event.messageId,
        );
        return;
      }
      const messageId =
        event.type === "group_message" ? event.messageId : undefined;
      log.debug("sending command reply", {
        groupId: event.groupId,
        messageId,
      });
      await runtime.api.sendGroupMessage(event.groupId, result.text, messageId);
    }
  });
}
