import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { FakeIdentityBindingRepository } from "./helpers/fakeIdentityBindingRepository.js";

describe("createRuntime", () => {
  it("falls back to fake mode without credentials", () => {
    const runtime = createRuntime(loadSettings({}));
    expect(runtime.mode).toBe("fake");
    expect(runtime.api).toBeDefined();
    expect(runtime.groupMessageMode.get("g1")).toBe("unknown");
    expect(runtime.identityMap.listUsers()).toEqual([]);
  });

  it("wires join request routing", async () => {
    const runtime = createRuntime(loadSettings({}));
    const result = await runtime.router.handle({
      type: "join_request",
      groupId: "g1",
      userId: "u1",
      requestId: "r1",
      reason: "想加入",
    });
    expect(result.ok).toBe(true);
    expect(runtime.joinAudit.pending("g1")).toHaveLength(1);
  });

  it("wires admin commands with configured admins", async () => {
    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }));
    runtime.identityMap.bindUser("admin", "10001");
    runtime.identityMap.bindGroup("g1", "654321");
    runtime.joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await runtime.router.handle({
      type: "admin_command",
      groupId: "g1",
      userId: "admin",
      text: "/pending",
    });
    expect(result.kind).toBe("command");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
  });

  it("loads persisted bindings into the identity map", async () => {
    const repository = new FakeIdentityBindingRepository();
    await repository.bind("user", "admin", "10001");
    await repository.bind("group", "g1", "654321");

    const runtime = createRuntime(loadSettings({ ADMIN_USER_IDS: "admin" }), {
      identityBindings: repository,
    });
    await runtime.identityMap.reload();

    expect(runtime.identityMap.persistent).toBe(true);
    expect(runtime.identityMap.getQq("admin")).toBe("10001");
    expect(runtime.identityMap.getGroupNumber("g1")).toBe("654321");
  });

  it("persists bindings made through the router and restores them after restart", async () => {
    const repository = new FakeIdentityBindingRepository();
    const first = createRuntime(loadSettings({}), {
      identityBindings: repository,
    });

    const bind = await first.router.handle({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });
    expect(bind.ok).toBe(true);
    expect(repository.bindings).toEqual([
      { kind: "user", officialId: "u1", externalId: "123456" },
    ]);

    const restarted = createRuntime(loadSettings({}), {
      identityBindings: repository,
    });
    await restarted.identityMap.reload();
    const query = await restarted.router.handle({
      type: "private_message",
      userId: "u1",
      messageId: "m2",
      content: "/myperm",
    });
    expect(query.ok).toBe(true);
  });
});
