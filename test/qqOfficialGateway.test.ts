import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { QQOfficialEventMapper } from "../src/adapters/qqOfficialEventMapper.js";
import { QQOfficialGateway } from "../src/adapters/qqOfficialGateway.js";
import type { Scheduler } from "../src/adapters/reconnectingWebSocketGateway.js";
import type {
  WebSocketEventName,
  WebSocketLike,
  WebSocketListener,
} from "../src/adapters/webSocketGateway.js";
import type { QQEvent } from "../src/services/eventRouter.js";

class FakeSocket implements WebSocketLike {
  public readonly sent: string[] = [];
  public closed = false;
  private readonly listeners = new Map<WebSocketEventName, WebSocketListener[]>();

  public on(event: WebSocketEventName, listener: WebSocketListener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  public send(data: string): void {
    this.sent.push(data);
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

describe("QQOfficialGateway", () => {
  it("identifies, heartbeats and dispatches events", async () => {
    const api = new FakeQQOfficialAPI();
    const socket = new FakeSocket();
    const scheduler = new FakeScheduler();
    let helloHeartbeat = -1;
    let readySession = "";
    const gateway = new QQOfficialGateway({
      api,
      createSocket: () => socket,
      mapper: new QQOfficialEventMapper(),
      scheduler,
      shard: [0, 1],
      onHello: (heartbeatIntervalMs) => {
        helloHeartbeat = heartbeatIntervalMs;
      },
      onReady: (sessionId) => {
        readySession = sessionId;
      },
    });
    const received: QQEvent[] = [];
    await gateway.start((event) => {
      received.push(event);
    });

    socket.emit("open");
    expect(gateway.isRunning).toBe(true);

    socket.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }),
    );
    expect(helloHeartbeat).toBe(1000);

    const identify = JSON.parse(socket.sent[0] ?? "{}") as {
      op: number;
      d: { token: string; shard: number[] };
    };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("QQBot fake-token");
    expect(identify.d.shard).toEqual([0, 1]);
    expect(scheduler.callbacks[0]?.delayMs).toBe(1000);

    socket.emit(
      "message",
      JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess" } }),
    );
    expect(gateway.session).toBe("sess");
    expect(readySession).toBe("sess");

    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        s: 2,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "m1",
          group_openid: "g1",
          content: "/test",
          author: { member_openid: "u1" },
        },
      }),
    );
    expect(received).toEqual([
      {
        type: "group_message",
        groupId: "g1",
        userId: "u1",
        messageId: "m1",
        content: "/test",
      },
    ]);

    scheduler.runNext();
    const heartbeat = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      op: number;
      d: number | null;
    };
    expect(heartbeat).toEqual({ op: 1, d: 2 });

    await gateway.stop();
    expect(gateway.isRunning).toBe(false);
    expect(socket.closed).toBe(true);
  });
});
