import { describe, expect, it } from "vitest";

import { SendThrottle } from "../src/adapters/sendThrottle.js";

function createClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("SendThrottle", () => {
  it("enforces a minimum interval between sends", async () => {
    const clock = createClock();
    const sleeps: number[] = [];
    const throttle = new SendThrottle({
      minIntervalMs: 400,
      jitterRatio: 0,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    });

    await throttle.run("a", async () => {
      clock.advance(100);
      return "a";
    });
    await throttle.run("b", async () => "b");

    expect(sleeps).toEqual([300]);
  });

  it("serializes concurrent sends", async () => {
    const events: string[] = [];
    const throttle = new SendThrottle({ minIntervalMs: 0, jitterRatio: 0 });

    const first = throttle.run("a", async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("a:end");
    });
    const second = throttle.run("b", async () => {
      events.push("b:start");
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("retries rate limited sends after the fixed cooldown", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const throttle = new SendThrottle({
      minIntervalMs: 0,
      maxAttempts: 3,
      rateLimitDelayMs: 5_000,
      jitterRatio: 0,
      now: () => 0,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      isRateLimited: (error) =>
        error instanceof Error && error.message === "too frequent",
    });

    const result = await throttle.run("group:g1", async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("too frequent");
      }
      return "sent";
    });

    expect(result).toBe("sent");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("propagates the error after exhausting attempts", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const throttle = new SendThrottle({
      minIntervalMs: 0,
      maxAttempts: 3,
      initialRetryDelayMs: 1_000,
      jitterRatio: 0,
      now: () => 0,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(
      throttle.run("group:g1", async () => {
        attempts += 1;
        throw new Error("network down");
      }),
    ).rejects.toThrow(/network down/u);

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("keeps processing after a failed task", async () => {
    const throttle = new SendThrottle({ minIntervalMs: 0, maxAttempts: 1 });

    await expect(
      throttle.run("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/u);

    await expect(throttle.run("b", async () => "ok")).resolves.toBe("ok");
  });

  /**
   * 「结果未知的失败不重试」（ADR-0063）：发送消息是**非幂等**的 —— 超时只说明我们没等到
   * 响应，平台很可能已经发出去了。真机现象：一次部署收到**两条**「发现新版本」，
   * 间隔正好等于「超时（10s）+ 退避」的时间。
   */
  it("超时（结果未知）不再重试：只尝试一次", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const throttle = new SendThrottle({
      minIntervalMs: 0,
      maxAttempts: 3,
      initialRetryDelayMs: 1_000,
      jitterRatio: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";

    await expect(
      throttle.run("user:u1", async () => {
        attempts += 1;
        throw timeout;
      }),
    ).rejects.toThrow(/timeout/u);

    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("连接被掐断（ECONNRESET）也按结果未知处理；连都没连上（ECONNREFUSED）仍可重试", async () => {
    let socketAttempts = 0;
    const socketThrottle = new SendThrottle({
      minIntervalMs: 0,
      maxAttempts: 3,
      jitterRatio: 0,
      sleep: async () => {},
    });
    const reset = new TypeError("fetch failed");
    (reset as { cause?: unknown }).cause = { code: "ECONNRESET" };
    await expect(
      socketThrottle.run("group:g1", async () => {
        socketAttempts += 1;
        throw reset;
      }),
    ).rejects.toThrow();
    expect(socketAttempts).toBe(1);

    let refusedAttempts = 0;
    const refusedThrottle = new SendThrottle({
      minIntervalMs: 0,
      maxAttempts: 3,
      jitterRatio: 0,
      sleep: async () => {},
    });
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    await expect(
      refusedThrottle.run("group:g1", async () => {
        refusedAttempts += 1;
        throw refused;
      }),
    ).rejects.toThrow();
    // 请求根本没出去 → 可以安全重试
    expect(refusedAttempts).toBe(3);
  });
});
