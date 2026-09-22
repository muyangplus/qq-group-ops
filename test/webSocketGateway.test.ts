import { describe, expect, it } from "vitest";

import { JsonEventMapper } from "../src/adapters/eventMapper.js";
import type { QQEvent } from "../src/services/eventRouter.js";
import {
  WebSocketGateway,
  type WebSocketEventName,
  type WebSocketLike,
  type WebSocketListener,
} from "../src/adapters/webSocketGateway.js";

class FakeSocket implements WebSocketLike {
  public closed = false;
  private readonly listeners = new Map<WebSocketEventName, WebSocketListener[]>();

  public on(event: WebSocketEventName, listener: WebSocketListener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  public close(): void {
    this.closed = true;
    this.emit("close");
  }

  public emit(event: WebSocketEventName, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

describe("WebSocketGateway", () => {
  it("dispatches mapped messages after open", async () => {
    const socket = new FakeSocket();
    const gateway = new WebSocketGateway(
      { create: () => socket },
      new JsonEventMapper(),
    );
    const received: QQEvent[] = [];
    await gateway.start((event) => {
      received.push(event);
    });

    expect(gateway.isRunning).toBe(false);
    socket.emit("open");
    expect(gateway.isRunning).toBe(true);

    socket.emit(
      "message",
      JSON.stringify({
        type: "join_request",
        groupId: "g1",
        userId: "u1",
        requestId: "r1",
      }),
    );

    expect(received).toEqual([
      {
        type: "join_request",
        groupId: "g1",
        userId: "u1",
        requestId: "r1",
      },
    ]);
    await gateway.stop();
    expect(gateway.isRunning).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("ignores invalid JSON and unmapped messages", async () => {
    const socket = new FakeSocket();
    const gateway = new WebSocketGateway(
      { create: () => socket },
      new JsonEventMapper(),
    );
    const received: QQEvent[] = [];
    await gateway.start((event) => {
      received.push(event);
    });
    socket.emit("message", "{not-json");
    socket.emit("message", JSON.stringify({ type: "unknown" }));
    expect(received).toEqual([]);
  });
});
