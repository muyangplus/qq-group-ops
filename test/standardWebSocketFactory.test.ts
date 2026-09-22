import { describe, expect, it } from "vitest";

import { StandardWebSocketFactory } from "../src/adapters/standardWebSocketFactory.js";
import type { WebSocketLike } from "../src/adapters/webSocketGateway.js";

class FakeWebSocket implements WebSocketLike {
  public readonly url: string;
  public closed = false;

  public constructor(url: string) {
    this.url = url;
  }

  public on(): void {
    return undefined;
  }

  public send(_data: string): void {
    return undefined;
  }

  public close(): void {
    this.closed = true;
  }
}

describe("StandardWebSocketFactory", () => {
  it("creates sockets with the configured URL", () => {
    const factory = new StandardWebSocketFactory(FakeWebSocket, "wss://example.test");
    const socket = factory.create();
    expect(socket).toBeInstanceOf(FakeWebSocket);
    expect((socket as FakeWebSocket).url).toBe("wss://example.test");
  });
});
