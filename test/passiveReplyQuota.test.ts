import { describe, expect, it } from "vitest";

import { PassiveReplyQuota } from "../src/adapters/passiveReplyQuota.js";

function createClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("PassiveReplyQuota", () => {
  it("allows up to five replies per message id", () => {
    const quota = new PassiveReplyQuota();

    for (let index = 0; index < 5; index += 1) {
      expect(quota.check("m1").allowed).toBe(true);
      quota.record("m1");
    }

    const decision = quota.check("m1");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("count");
    expect(decision.used).toBe(5);
    expect(decision.remaining).toBe(0);
    expect(quota.usage("m1")).toBe(5);
  });

  it("tracks message ids independently", () => {
    const quota = new PassiveReplyQuota();
    for (let index = 0; index < 5; index += 1) {
      quota.record("m1");
    }

    expect(quota.check("m1").allowed).toBe(false);
    expect(quota.check("m2").allowed).toBe(true);
  });

  it("rejects replies after the window expires", () => {
    const clock = createClock();
    const quota = new PassiveReplyQuota({
      windowMs: 5 * 60_000,
      clock: clock.now,
    });

    quota.record("m1");
    clock.advance(4 * 60_000);
    expect(quota.check("m1").allowed).toBe(true);

    clock.advance(61_000);
    const decision = quota.check("m1");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("expired");
  });

  it("starts a new window when recording an expired message id", () => {
    const clock = createClock();
    const quota = new PassiveReplyQuota({
      windowMs: 1_000,
      clock: clock.now,
    });

    quota.record("m1");
    clock.advance(2_000);
    quota.record("m1");

    expect(quota.usage("m1")).toBe(1);
  });

  it("evicts the oldest entries beyond the cache size", () => {
    const quota = new PassiveReplyQuota({ cacheSize: 2 });
    quota.record("m1");
    quota.record("m2");
    quota.record("m3");

    expect(quota.size).toBe(2);
    expect(quota.check("m1").used).toBe(0);
    expect(quota.check("m3").used).toBe(1);
  });
});
