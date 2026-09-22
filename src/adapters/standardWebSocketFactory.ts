import type {
  WebSocketFactory,
  WebSocketLike,
} from "./webSocketGateway.js";

export interface WebSocketConstructorLike {
  new (url: string, protocols?: string | readonly string[]): WebSocketLike;
}

export class StandardWebSocketFactory implements WebSocketFactory {
  public constructor(
    private readonly constructorLike: WebSocketConstructorLike,
    private readonly url: string,
  ) {}

  public create(): WebSocketLike {
    return new this.constructorLike(this.url);
  }
}
