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
    if (result.kind === "command" && result.text) {
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
