import { describe, expect, it } from "vitest";

import { FakeEventGateway } from "../src/adapters/fakeEventGateway.js";
import { loadSettings } from "../src/config.js";
import { attachGateway } from "../src/gatewayRunner.js";
import { createRuntime } from "../src/runtime.js";

describe("FakeEventGateway", () => {
  it("dispatches events after start", async () => {
    const gateway = new FakeEventGateway();
    const received: string[] = [];
    await gateway.start((event) => {
      received.push(event.type);
    });

    await gateway.emit({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
    });

    expect(received).toEqual(["join_request"]);
    expect(gateway.isRunning).toBe(true);
  });

  it("rejects events after stop", async () => {
    const gateway = new FakeEventGateway();
    await gateway.start(() => undefined);
    await gateway.stop();

    await expect(
      gateway.emit({
        type: "join_request",
        groupId: "g1",
        userId: "u1",
        requestId: "r1",
      }),
    ).rejects.toThrow(/not running/u);
  });

  it("attaches to the runtime and routes events", async () => {
    const runtime = createRuntime(loadSettings({}));
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });

    expect(runtime.joinAudit.pending("g1")).toHaveLength(1);
  });
});
