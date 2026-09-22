import type { EventGateway } from "./adapters/eventGateway.js";
import type { Runtime } from "./runtime.js";

export async function attachGateway(
  runtime: Runtime,
  gateway: EventGateway,
): Promise<void> {
  await gateway.start(async (event) => {
    await runtime.router.handle(event);
  });
}
