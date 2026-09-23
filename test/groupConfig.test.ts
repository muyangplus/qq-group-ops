import { describe, expect, it } from "vitest";

import { GroupConfigStore } from "../src/services/groupConfig.js";

describe("GroupConfigStore", () => {
  function createStore(): GroupConfigStore {
    return new GroupConfigStore({
      groupId: "__default__",
      keywords: ["广告"],
      joinAuditEnabled: true,
      autoApproveJoin: false,
      rawMessageRetentionDays: 0,
    });
  }

  it("falls back to defaults", () => {
    const config = createStore().get("g1");
    expect(config.groupId).toBe("g1");
    expect(config.joinAuditEnabled).toBe(true);
    expect(config.autoApproveJoin).toBe(false);
    expect(config.keywords).toEqual(["广告"]);
  });

  it("inherits other fields when overriding one field", () => {
    const store = createStore();
    store.setOverride({ groupId: "g1", autoApproveJoin: true });
    const config = store.get("g1");
    expect(config.autoApproveJoin).toBe(true);
    expect(config.joinAuditEnabled).toBe(true);
    expect(config.keywords).toEqual(["广告"]);
  });

  it("overrides keywords per group", () => {
    const store = createStore();
    store.setOverride({ groupId: "g1", keywords: ["刷屏"] });
    expect(store.get("g1").keywords).toEqual(["刷屏"]);
    expect(store.get("g2").keywords).toEqual(["广告"]);
  });

  it("removes overrides", () => {
    const store = createStore();
    store.setOverride({ groupId: "g1", autoApproveJoin: true });
    store.removeOverride("g1");
    expect(store.get("g1").autoApproveJoin).toBe(false);
  });

  it("merges partial overrides instead of replacing them", () => {
    const store = createStore();
    store.setOverride({ groupId: "g1", keywords: ["刷屏"] });
    store.setOverride({ groupId: "g1", autoApproveJoin: true });

    const config = store.get("g1");
    expect(config.keywords).toEqual(["刷屏"]);
    expect(config.autoApproveJoin).toBe(true);
  });

  it("rejects overriding the default group id", () => {
    const store = createStore();
    expect(() => store.setOverride({ groupId: "__default__" })).toThrow(
      /cannot override/u,
    );
  });
});
