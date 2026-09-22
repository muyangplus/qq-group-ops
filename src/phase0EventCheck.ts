import type { EventGateway } from "./adapters/eventGateway.js";
import {
  SystemScheduler,
  type Scheduler,
} from "./adapters/reconnectingWebSocketGateway.js";
import type { QQEvent } from "./services/eventRouter.js";

export interface Phase0EventCheckResult {
  received: boolean;
  event?: QQEvent;
  timedOut: boolean;
}

export async function runPhase0EventCheck(
  gateway: EventGateway,
  timeoutMs: number,
  scheduler: Scheduler = new SystemScheduler(),
): Promise<Phase0EventCheckResult> {
  let event: QQEvent | undefined;
  let resolveEvent: (() => void) | undefined;
  const eventPromise = new Promise<void>((resolve) => {
    resolveEvent = resolve;
  });

  await gateway.start((incoming) => {
    event = incoming;
    resolveEvent?.();
  });

  let timeoutHandle: unknown;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = scheduler.setTimeout(resolve, timeoutMs);
  });

  await Promise.race([eventPromise, timeoutPromise]);
  if (timeoutHandle !== undefined) {
    scheduler.clearTimeout(timeoutHandle);
  }
  await gateway.stop();

  return {
    received: event !== undefined,
    ...(event !== undefined ? { event } : {}),
    timedOut: event === undefined,
  };
}
