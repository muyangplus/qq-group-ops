import { describe, expect, it } from "vitest";

import { GroupMessageModeRegistry } from "../src/services/groupMessageMode.js";

describe("GroupMessageModeRegistry", () => {
  it("tracks group message modes", () => {
    const registry = new GroupMessageModeRegistry();
    expect(registry.get("g1")).toBe("unknown");

    registry.setEnabled("g1", true);
    expect(registry.get("g1")).toBe("all");
    expect(registry.list()).toEqual([{ groupId: "g1", mode: "all" }]);

    registry.setEnabled("g1", false);
    expect(registry.get("g1")).toBe("at_only");
  });
});
