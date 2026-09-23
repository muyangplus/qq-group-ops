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
});
