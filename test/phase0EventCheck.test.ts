import { describe, expect, it } from "vitest";

import { FakeEventGateway } from "../src/adapters/fakeEventGateway.js";
import { runPhase0EventCheck } from "../src/phase0EventCheck.js";

describe("runPhase0EventCheck", () => {
  it("detects the first event", async () => {
    const gateway = new FakeEventGateway();
    const check = runPhase0EventCheck(gateway, 50);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await gateway.emit({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
    });

    const result = await check;
    expect(result.received).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.event?.type).toBe("join_request");
  });

  it("times out when no event arrives", async () => {
    const gateway = new FakeEventGateway();
    const result = await runPhase0EventCheck(gateway, 5);
    expect(result.received).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});
