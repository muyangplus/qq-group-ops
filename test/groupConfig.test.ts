import { describe, expect, it } from "vitest";

import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";

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

  it("updates the global default config through the default group id", () => {
    const store = createStore();
    store.setOverride({ groupId: DEFAULT_GROUP_ID, keywords: ["全局词"] });
    store.setOverride({ groupId: DEFAULT_GROUP_ID, autoApproveJoin: true });

    expect(store.default.keywords).toEqual(["全局词"]);
    expect(store.default.autoApproveJoin).toBe(true);

    // 没有单独配置的群继承全局规则
    const inherited = store.get("g9");
    expect(inherited.keywords).toEqual(["全局词"]);
    expect(inherited.autoApproveJoin).toBe(true);

    // 单独配置过的群以自己的配置优先，未覆盖的字段仍继承全局
    store.setOverride({ groupId: "g1", keywords: ["本群词"] });
    expect(store.get("g1").keywords).toEqual(["本群词"]);
    expect(store.get("g1").autoApproveJoin).toBe(true);
  });

  it("keeps the global config out of listOverrides and can reset it", () => {
    const store = createStore();
    store.setOverride({ groupId: DEFAULT_GROUP_ID, keywords: ["全局词"] });
    store.setOverride({ groupId: "g1", autoApproveJoin: true });

    expect(store.listOverrides().map((item) => item.groupId)).toEqual(["g1"]);

    store.removeOverride(DEFAULT_GROUP_ID);

    expect(store.default.keywords).toEqual(["广告"]);
    expect(store.default.autoApproveJoin).toBe(false);
    // 单群覆盖不受影响
    expect(store.get("g1").autoApproveJoin).toBe(true);
  });
});
