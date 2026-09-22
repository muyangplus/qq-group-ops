import type { EventGateway, EventHandler } from "./eventGateway.js";
import type { EventMapper } from "./eventMapper.js";

export type WebSocketEventName = "open" | "message" | "close" | "error";
export type WebSocketListener = (payload?: unknown) => void;

export interface WebSocketLike {
  on(event: WebSocketEventName, listener: WebSocketListener): void;
  close(): void;
}

export interface WebSocketFactory {
  create(): WebSocketLike;
}

export interface GatewayLifecycle {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
}

export class WebSocketGateway implements EventGateway {
  private socket: WebSocketLike | undefined;
  private handler: EventHandler | undefined;
  private running = false;

  public constructor(
    private readonly factory: WebSocketFactory,
    private readonly mapper: EventMapper,
    private readonly lifecycle: GatewayLifecycle = {},
  ) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
    const socket = this.factory.create();
    this.socket = socket;
    socket.on("open", () => {
      this.running = true;
      this.lifecycle.onOpen?.();
    });
    socket.on("close", () => {
      this.running = false;
      this.lifecycle.onClose?.();
    });
    socket.on("error", (error) => {
      this.running = false;
      this.lifecycle.onError?.(error);
    });
    socket.on("message", (payload) => {
      void this.handleMessage(payload);
    });
  }

  public async stop(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.handler = undefined;
    this.running = false;
  }

  private async handleMessage(payload: unknown): Promise<void> {
    if (!this.handler) {
      return;
    }
    const raw = typeof payload === "string" ? parseJson(payload) : payload;
    const event = this.mapper.map(raw);
    if (event) {
      await this.handler(event);
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
