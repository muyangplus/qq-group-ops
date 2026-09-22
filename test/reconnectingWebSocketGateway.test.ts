import { describe, expect, it } from "vitest";

import { JsonEventMapper } from "../src/adapters/eventMapper.js";
import {
  ReconnectingWebSocketGateway,
  type Scheduler,
} from "../src/adapters/reconnectingWebSocketGateway.js";
import type {
  WebSocketEventName,
  WebSocketFactory,
  WebSocketLike,
  WebSocketListener,
} from "../src/adapters/webSocketGateway.js";
import type { QQEvent } from "../src/services/eventRouter.js";

class FakeSocket implements WebSocketLike {
  public closed = false;
  private readonly listeners = new Map<WebSocketEventName, WebSocketListener[]>();

  public on(event: WebSocketEventName, listener: WebSocketListener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  public send(_data: string): void {
    return undefined;
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

class FakeFactory implements WebSocketFactory {
  public readonly sockets: FakeSocket[] = [];

  public create(): WebSocketLike {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  }
}

class FakeScheduler implements Scheduler {
  public readonly callbacks: Array<{ callback: () => void; delayMs: number; handle: number }> = [];
  private nextHandle = 1;

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.push({ callback, delayMs, handle });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const index = this.callbacks.findIndex((item) => item.handle === handle);
    if (index >= 0) {
      this.callbacks.splice(index, 1);
    }
  }

  public runNext(): void {
    const item = this.callbacks.shift();
    item?.callback();
  }
}

describe("ReconnectingWebSocketGateway", () => {
  it("reconnects after close", async () => {
    const factory = new FakeFactory();
    const scheduler = new FakeScheduler();
    const gateway = new ReconnectingWebSocketGateway(
      factory,
      new JsonEventMapper(),
      { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1000, factor: 2 },
      scheduler,
    );
    const received: QQEvent[] = [];
    await gateway.start((event) => {
      received.push(event);
    });

    expect(factory.sockets).toHaveLength(1);
    factory.sockets[0]?.emit("open");
    expect(gateway.isRunning).toBe(true);

    factory.sockets[0]?.emit("close");
    expect(scheduler.callbacks[0]?.delayMs).toBe(100);

    scheduler.runNext();
    expect(factory.sockets).toHaveLength(2);
    factory.sockets[1]?.emit("open");
    expect(gateway.isRunning).toBe(true);

    factory.sockets[1]?.emit(
      "message",
      JSON.stringify({
        type: "join_request",
        groupId: "g1",
        userId: "u1",
        requestId: "r1",
      }),
    );
    expect(received).toHaveLength(1);

    await gateway.stop();
    expect(gateway.isRunning).toBe(false);
    expect(factory.sockets[1]?.closed).toBe(true);
  });

  it("backs off and stops at max attempts", async () => {
    const factory = new FakeFactory();
    const scheduler = new FakeScheduler();
    const gateway = new ReconnectingWebSocketGateway(
      factory,
      new JsonEventMapper(),
      { maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 1000, factor: 2 },
      scheduler,
    );
    await gateway.start(() => undefined);

    factory.sockets[0]?.emit("close");
    expect(scheduler.callbacks[0]?.delayMs).toBe(100);
    scheduler.runNext();

    factory.sockets[1]?.emit("close");
    expect(scheduler.callbacks[0]?.delayMs).toBe(200);
    scheduler.runNext();

    factory.sockets[2]?.emit("close");
    expect(scheduler.callbacks).toHaveLength(0);
  });
});
