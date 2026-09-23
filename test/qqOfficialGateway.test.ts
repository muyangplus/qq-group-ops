import { describe, expect, it, vi } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { QQOfficialEventMapper } from "../src/adapters/qqOfficialEventMapper.js";
import {
  DEFAULT_RECONNECT_POLICY,
  QQOfficialGateway,
} from "../src/adapters/qqOfficialGateway.js";
import { QQOfficialAPIError } from "../src/adapters/qqOfficialError.js";
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

  it("dispatches full group messages without mention", async () => {
    const api = new FakeQQOfficialAPI();
    const socket = new FakeSocket();
    const gateway = new QQOfficialGateway({
      api,
      createSocket: () => socket,
      mapper: new QQOfficialEventMapper(),
      scheduler: new FakeScheduler(),
    });
    const received: QQEvent[] = [];
    await gateway.start((event) => {
      received.push(event);
    });

    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }),
    );
    socket.emit(
      "message",
      JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess" } }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        s: 2,
        t: "GROUP_MESSAGE_CREATE",
        d: {
          id: "m2",
          group_openid: "g1",
          content: "/myperm",
          author: { member_openid: "u2" },
        },
      }),
    );

    expect(received).toEqual([
      {
        type: "group_message",
        groupId: "g1",
        userId: "u2",
        messageId: "m2",
        content: "/myperm",
      },
    ]);

    await gateway.stop();
  });

  it("tracks group full-message mode events", async () => {
    const api = new FakeQQOfficialAPI();
    const socket = new FakeSocket();
    const modes: Array<[string, boolean]> = [];
    const gateway = new QQOfficialGateway({
      api,
      createSocket: () => socket,
      mapper: new QQOfficialEventMapper(),
      scheduler: new FakeScheduler(),
      onGroupMessageMode: (groupId, enabled) => {
        modes.push([groupId, enabled]);
      },
    });
    await gateway.start(() => undefined);

    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        s: 1,
        t: "GROUP_MSG_RECEIVE",
        d: { group_openid: "g1" },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        s: 2,
        t: "GROUP_MSG_REJECT",
        d: { group_openid: "g1" },
      }),
    );

    expect(modes).toEqual([
      ["g1", true],
      ["g1", false],
    ]);
    await gateway.stop();
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("QQOfficialGateway reconnection", () => {
  it("reconnects after a disconnect with exponential backoff", async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
      reconnect: { jitterRatio: 0 },
    });

    await gateway.start(() => undefined);
    expect(sockets).toHaveLength(1);

    sockets[0]?.emit("open");
    expect(gateway.isRunning).toBe(true);
    sockets[0]?.emit("close");
    expect(gateway.isRunning).toBe(false);
    expect(scheduler.callbacks[0]?.delayMs).toBe(1_000);

    scheduler.runNext();
    await tick();
    expect(sockets).toHaveLength(2);

    // 第二次断开时退避更久
    sockets[1]?.emit("close");
    expect(scheduler.callbacks[0]?.delayMs).toBe(1_800);

    await gateway.stop();
  });

  it("uses the long cooldown when a reconnect is rate limited", async () => {
    const api = new FakeQQOfficialAPI();
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
      reconnect: { jitterRatio: 0 },
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit("close");
    expect(scheduler.callbacks[0]?.delayMs).toBe(1_000);

    const spy = vi
      .spyOn(api, "getGatewayUrl")
      .mockRejectedValue(
        new QQOfficialAPIError(400, "接口调用超过频率限制", { err_code: 100017 }),
      );
    scheduler.runNext();
    await tick();

    expect(spy).toHaveBeenCalled();
    expect(scheduler.callbacks[0]?.delayMs).toBe(
      DEFAULT_RECONNECT_POLICY.rateLimitDelayMs,
    );

    spy.mockRestore();
    await gateway.stop();
  });

  it("propagates the first connection failure so config problems fail fast", async () => {
    const api = new FakeQQOfficialAPI();
    vi.spyOn(api, "getGatewayUrl").mockRejectedValue(new Error("bad credentials"));
    const gateway = new QQOfficialGateway({
      api,
      createSocket: () => new FakeSocket(),
      mapper: new QQOfficialEventMapper(),
      scheduler: new FakeScheduler(),
    });

    await expect(gateway.start(() => undefined)).rejects.toThrow(
      /bad credentials/u,
    );
  });

  it("invalidates the cached gateway url after repeated failures without open", async () => {
    const api = new FakeQQOfficialAPI();
    const invalidate = vi.fn(async () => undefined);
    const apiWithInvalidation = Object.assign(api, {
      invalidateGatewayUrl: invalidate,
    });
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: apiWithInvalidation,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
      reconnect: { jitterRatio: 0, invalidateGatewayAfterFailures: 2 },
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    vi.spyOn(api, "getGatewayUrl").mockRejectedValue(new Error("network down"));

    sockets[0]?.emit("close");
    scheduler.runNext();
    await tick();

    expect(invalidate).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it("cancels scheduled reconnects on stop", async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit("close");
    expect(scheduler.callbacks).toHaveLength(1);

    await gateway.stop();
    expect(scheduler.callbacks).toHaveLength(0);
  });

  it("resumes the session and reuses the resume gateway url", async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
      reconnect: { jitterRatio: 0 },
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    sockets[0]?.emit(
      "message",
      JSON.stringify({
        op: 0,
        s: 7,
        t: "READY",
        d: {
          session_id: "sess-1",
          resume_gateway_url: "wss://resume.example/ws",
        },
      }),
    );

    sockets[0]?.emit("close");
    scheduler.runNext();
    await tick();

    expect(urls[1]).toBe("wss://resume.example/ws");
    sockets[1]?.emit("open");
    sockets[1]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );

    const resume = JSON.parse(sockets[1]?.sent[0] ?? "{}") as {
      op: number;
      d: Record<string, unknown>;
    };
    expect(resume.op).toBe(6);
    expect(resume.d).toEqual({
      token: "QQBot fake-token",
      session_id: "sess-1",
      seq: 7,
    });

    await gateway.stop();
  });

  it("falls back to identify when the session becomes invalid", async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
      reconnect: { jitterRatio: 0 },
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    sockets[0]?.emit(
      "message",
      JSON.stringify({ op: 0, s: 3, t: "READY", d: { session_id: "sess-1" } }),
    );

    sockets[0]?.emit("message", JSON.stringify({ op: 9, d: true }));
    await tick();
    scheduler.runNext();
    await tick();

    sockets[1]?.emit("open");
    sockets[1]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );

    const payload = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { op: number };
    expect(payload.op).toBe(2);

    await gateway.stop();
  });

  it("reconnects when the heartbeat is not acknowledged", async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    expect(gateway.isRunning).toBe(true);

    scheduler.runNext();
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toEqual({
      op: 1,
      d: null,
    });

    // 下一个周期仍未收到 op=11，应主动断开并安排重连
    scheduler.runNext();
    expect(gateway.isRunning).toBe(false);
    expect(scheduler.callbacks).toHaveLength(1);

    await gateway.stop();
  });

  it("keeps the connection while heartbeats are acknowledged", async () => {
    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );

    scheduler.runNext();
    sockets[0]?.emit("message", JSON.stringify({ op: 11 }));
    scheduler.runNext();

    expect(gateway.isRunning).toBe(true);
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toEqual({
      op: 1,
      d: null,
    });

    await gateway.stop();
  });

  it("reconnects when the server sends op=7", async () => {    const sockets: FakeSocket[] = [];
    const scheduler = new FakeScheduler();
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      mapper: new QQOfficialEventMapper(),
      scheduler,
      random: () => 0.5,
    });

    await gateway.start(() => undefined);
    sockets[0]?.emit("open");
    sockets[0]?.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );

    sockets[0]?.emit("message", JSON.stringify({ op: 7 }));
    expect(gateway.isRunning).toBe(false);
    expect(scheduler.callbacks).toHaveLength(1);

    await gateway.stop();
  });

  it("keeps the connection when an event handler throws", async () => {
    const socket = new FakeSocket();
    const errors: unknown[] = [];
    const gateway = new QQOfficialGateway({
      api: new FakeQQOfficialAPI(),
      createSocket: () => socket,
      mapper: new QQOfficialEventMapper(),
      scheduler: new FakeScheduler(),
      onError: (error) => {
        errors.push(error);
      },
    });

    await gateway.start(() => {
      throw new Error("handler boom");
    });
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        op: 0,
        s: 1,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "m1",
          group_openid: "g1",
          content: "/test",
          author: { member_openid: "u1" },
        },
      }),
    );
    await tick();

    expect(errors).toHaveLength(1);
    expect(gateway.isRunning).toBe(true);

    await gateway.stop();
  });
});
