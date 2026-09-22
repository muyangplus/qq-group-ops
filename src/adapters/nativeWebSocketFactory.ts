import type {
  WebSocketEventName,
  WebSocketFactory,
  WebSocketLike,
  WebSocketListener,
} from "./webSocketGateway.js";

export interface NativeWebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

export interface NativeWebSocketConstructorLike {
  new (url: string): NativeWebSocketLike;
}

export class NativeWebSocketFactory implements WebSocketFactory {
  private readonly url: string;
  private readonly constructorLike: NativeWebSocketConstructorLike;

  public constructor(url: string, constructorLike?: NativeWebSocketConstructorLike) {
    this.url = url;
    if (constructorLike) {
      this.constructorLike = constructorLike;
      return;
    }
    const globalConstructor = (
      globalThis as { WebSocket?: NativeWebSocketConstructorLike }
    ).WebSocket;
    if (!globalConstructor) {
      throw new Error(
        "WebSocket is not available in this runtime; pass a constructor explicitly",
      );
    }
    this.constructorLike = globalConstructor;
  }

  public create(): WebSocketLike {
    const socket = new this.constructorLike(this.url);
    return {
      on: (event: WebSocketEventName, listener: WebSocketListener) => {
        socket.addEventListener(event, (payload) => {
          if (event === "message" && isMessageEvent(payload)) {
            listener(payload.data);
          } else {
            listener(payload);
          }
        });
      },
      close: () => {
        socket.close();
      },
    };
  }
}

function isMessageEvent(value: unknown): value is { data: unknown } {
  return typeof value === "object" && value !== null && "data" in value;
}
