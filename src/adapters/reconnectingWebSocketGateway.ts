import type { EventGateway, EventHandler } from "./eventGateway.js";
import type { EventMapper } from "./eventMapper.js";
import {
  WebSocketGateway,
  type WebSocketFactory,
} from "./webSocketGateway.js";

export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class SystemScheduler implements Scheduler {
  public setTimeout(callback: () => void, delayMs: number): unknown {
    return globalThis.setTimeout(callback, delayMs);
  }

  public clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

export interface ReconnectPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
}

export class ReconnectingWebSocketGateway implements EventGateway {
  private handler: EventHandler | undefined;
  private inner: WebSocketGateway | undefined;
  private attempts = 0;
  private timer: unknown;
  private stopped = false;
  private reconnectScheduled = false;

  public constructor(
    private readonly factory: WebSocketFactory,
    private readonly mapper: EventMapper,
    private readonly policy: ReconnectPolicy,
    private readonly scheduler: Scheduler = new SystemScheduler(),
  ) {}

  public get isRunning(): boolean {
    return this.inner?.isRunning ?? false;
  }

  public async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    this.attempts = 0;
    await this.connect();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.reconnectScheduled = false;
    await this.inner?.stop();
    this.inner = undefined;
    this.handler = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.handler) {
      return;
    }
    this.reconnectScheduled = false;
    const gateway = new WebSocketGateway(this.factory, this.mapper, {
      onOpen: () => {
        this.attempts = 0;
      },
      onClose: () => {
        this.scheduleReconnect();
      },
      onError: () => {
        this.scheduleReconnect();
      },
    });
    this.inner = gateway;
    await gateway.start(async (event) => {
      if (this.handler) {
        await this.handler(event);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectScheduled) {
      return;
    }
    if (this.attempts >= this.policy.maxAttempts) {
      this.stopped = true;
      return;
    }
    const delay = Math.min(
      this.policy.maxDelayMs,
      this.policy.initialDelayMs * Math.pow(this.policy.factor, this.attempts),
    );
    this.attempts += 1;
    this.reconnectScheduled = true;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }
}
