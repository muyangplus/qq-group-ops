import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

describe("createRuntime", () => {
  it("falls back to fake mode without credentials", () => {
    const runtime = createRuntime(loadSettings({}));
    expect(runtime.mode).toBe("fake");
    expect(runtime.api).toBeDefined();
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
});
