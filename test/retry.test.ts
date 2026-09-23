import { describe, expect, it } from "vitest";

import { retryWithBackoff } from "../src/core/retry.js";

class RateLimitedError extends Error {
  public constructor() {
    super("接口调用超过频率限制");
  }
}

describe("retryWithBackoff", () => {
  it("returns immediately when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        return "ok";
      },
      { sleep: async () => undefined },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("uses exponential delays between attempts", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("boom");
        }
        return calls;
      },
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        factor: 2,
        jitterRatio: 0,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(result).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("gives up after maxAttempts", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        { maxAttempts: 3, jitterRatio: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/boom/u);
    expect(calls).toBe(3);
  });

  it("honours the delayFor override for rate limit errors", async () => {
    const delays: number[] = [];
    let calls = 0;

    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw calls === 1 ? new RateLimitedError() : new Error("boom");
        },
        {
          maxAttempts: 2,
          initialDelayMs: 100,
          jitterRatio: 0,
          delayFor: (error) => (error instanceof RateLimitedError ? 5_000 : undefined),
          sleep: async (delay) => {
            delays.push(delay);
          },
        },
      ),
    ).rejects.toThrow(/boom/u);

    expect(delays).toEqual([5_000]);
  });

  it("stops retrying when shouldRetry returns false", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new Error("fatal");
        },
        {
          maxAttempts: 5,
          shouldRetry: () => false,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow(/fatal/u);
    expect(calls).toBe(1);
  });
});
