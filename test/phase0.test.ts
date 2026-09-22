import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { isLikelyGroupNumber, runPhase0Check } from "../src/phase0.js";

describe("runPhase0Check", () => {
  it("reads join requests", async () => {
    const api = new FakeQQOfficialAPI();
    api.addJoinRequest("g1", "u1", "想加入", "r1");
    const result = await runPhase0Check(api, "g1");
    expect(result.tokenAcquired).toBe(true);
    expect(result.joinRequestCount).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("optionally sends and recalls a test message", async () => {
    const api = new FakeQQOfficialAPI();
    const result = await runPhase0Check(api, "g1", { sendTestMessage: true });
    expect(result.sentMessageId).toBeDefined();
    expect(result.recallAttempted).toBe(true);
    expect(api.recalledMessages).toHaveLength(1);
  });

  it("detects values that look like QQ group numbers", () => {
    expect(isLikelyGroupNumber("123456789")).toBe(true);
    expect(isLikelyGroupNumber("12345")).toBe(true);
    expect(isLikelyGroupNumber("group-openid-abc")).toBe(false);
  });
});
