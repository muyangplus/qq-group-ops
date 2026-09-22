import type { QQEvent } from "../services/eventRouter.js";

export type EventHandler = (event: QQEvent) => void | Promise<void>;

export interface EventGateway {
  start(handler: EventHandler): Promise<void>;
  stop(): Promise<void>;
}
