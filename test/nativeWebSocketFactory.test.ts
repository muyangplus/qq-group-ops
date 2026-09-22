import { describe, expect, it } from "vitest";

import {
  NativeWebSocketFactory,
  type NativeWebSocketLike,
} from "../src/adapters/nativeWebSocketFactory.js";
import type { WebSocketLike } from "../src/adapters/webSocketGateway.js";

class FakeNativeSocket implements NativeWebSocketLike {
  public static readonly instances: FakeNativeSocket[] = [];
  public readonly url: string;
  public readonly sent: string[] = [];
  public closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  public constructor(url: string) {
    this.url = url;
    FakeNativeSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closed = true;
  }

  public emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }
}

describe("NativeWebSocketFactory", () => {
  it("adapts native message events and close", () => {
    FakeNativeSocket.instances.length = 0;
    const factory = new NativeWebSocketFactory(
      "wss://example.test",
      FakeNativeSocket,
    );
    const socket: WebSocketLike = factory.create();
    const received: unknown[] = [];
    socket.on("message", (payload) => {
      received.push(payload);
    });

    FakeNativeSocket.instances[0]?.emit("message", { data: "hello" });
    expect(received).toEqual(["hello"]);

    socket.close();
    expect(FakeNativeSocket.instances[0]?.closed).toBe(true);
  });
});
