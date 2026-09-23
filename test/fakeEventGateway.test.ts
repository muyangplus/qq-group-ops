import { describe, expect, it, vi } from "vitest";

import { FakeEventGateway } from "../src/adapters/fakeEventGateway.js";
import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
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

  it("sends command replies back to the group", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "group_message",
      groupId: "g1",
      userId: "mod",
      messageId: "m1",
      content: "/test",
    });

    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.content).toContain("测试成功");
    expect(api.sentMessages[0]?.msgId).toBe("m1");
  });

  it("sends private command replies", async () => {
    const runtime = createRuntime(loadSettings({}));
    const api = runtime.api as FakeQQOfficialAPI;
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await gateway.emit({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });

    expect(api.sentPrivateMessages).toHaveLength(1);
    expect(api.sentPrivateMessages[0]?.content).toContain("已绑定");
    expect(api.sentPrivateMessages[0]?.msgId).toBe("m1");
  });

  it("does not fail the event when a reply cannot be sent", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "mod" }));
    runtime.identityMap.bindUser("mod", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    const api = runtime.api as FakeQQOfficialAPI;
    vi.spyOn(api, "sendGroupMessage").mockRejectedValue(
      new Error("passive reply quota exhausted"),
    );
    const gateway = new FakeEventGateway();
    await attachGateway(runtime, gateway);

    await expect(
      gateway.emit({
        type: "group_message",
        groupId: "g1",
        userId: "mod",
        messageId: "m1",
        content: "/test",
      }),
    ).resolves.toBeUndefined();
  });
});
