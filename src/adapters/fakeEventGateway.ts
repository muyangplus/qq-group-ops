import type { QQEvent } from "../services/eventRouter.js";
import type { EventGateway, EventHandler } from "./eventGateway.js";

export class FakeEventGateway implements EventGateway {
  private handler: EventHandler | undefined;
  private running = false;

  public get isRunning(): boolean {
    return this.running;
  }

  public async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
  }

  public async stop(): Promise<void> {
    this.handler = undefined;
    this.running = false;
  }

  public async emit(event: QQEvent): Promise<void> {
    if (!this.running || !this.handler) {
      throw new Error("event gateway is not running");
    }
    await this.handler(event);
  }
}
