import { describe, expect, it } from "vitest";

import { WriteQueue } from "../src/db/writeQueue.js";
import {
  DEFAULT_GROUP_ID,
  GroupConfigStore,
} from "../src/services/groupConfig.js";
import {
  FakeGroupConfigRepository,
  FakeGroupSettingsRepository,
} from "./helpers/fakeGroupConfigRepositories.js";

/**
 * B6b：全局规则的「已覆盖」在**重启前后**必须一致（ADR-0072）。
 *
 * 老实现把**整行快照**（含继承来的种子默认值）写进 `group_configs.__default__`，
 * 于是 `load()` 里的 `overriddenFieldsOf(整行)` 会把所有 SQL 列都算成「已覆盖」——
 * 生效值没错，但 `/rules all` 的覆盖率总览 / 后台规则页会虚报一堆根本没配过的字段。
 */
describe("全局规则覆盖的持久化口径（B6b / ADR-0072）", () => {
  function makeStore(
    repo: FakeGroupConfigRepository,
    settings: FakeGroupSettingsRepository,
  ): GroupConfigStore {
    // 与生产同一姿势：只有 repository / settingsRepository，**没有**构造函数种子字段
    return new GroupConfigStore(
      { groupId: DEFAULT_GROUP_ID },
      repo,
      new WriteQueue(),
      settings,
    );
  }

  it("重启前后「已覆盖」完全一致：没碰过的字段不会被算成覆盖", async () => {
    const repo = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = makeStore(repo, settings);
    store.setOverride({ groupId: DEFAULT_GROUP_ID, warningMessage: "全局文案" });
    await store.flush();

    const before = [...store.overriddenFields(DEFAULT_GROUP_ID)].sort();
    expect(before).toEqual(["warningMessage"]);

    const restarted = makeStore(repo, settings);
    await restarted.load();

    expect([...restarted.overriddenFields(DEFAULT_GROUP_ID)].sort()).toEqual(
      before,
    );
    // 生效值也一致：显式项照旧，其余仍然跟着种子默认
    expect(restarted.default.warningMessage).toBe("全局文案");
    expect(restarted.default.wordFilterEnabled).toBe(
      store.default.wordFilterEnabled,
    );
    expect(restarted.default.muteDurationSeconds).toBe(
      store.default.muteDurationSeconds,
    );
  });

  it("多项覆盖（含关键词）：谁显式配过，重启后还是谁", async () => {
    const repo = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = makeStore(repo, settings);
    store.setOverride({ groupId: DEFAULT_GROUP_ID, warningMessage: "全局" });
    store.setOverride({ groupId: DEFAULT_GROUP_ID, autoApproveJoin: true });
    store.setOverride({ groupId: DEFAULT_GROUP_ID, keywords: ["广告"] });
    await store.flush();

    const restarted = makeStore(repo, settings);
    await restarted.load();

    expect([...restarted.overriddenFields(DEFAULT_GROUP_ID)].sort()).toEqual([
      "autoApproveJoin",
      "keywords",
      "warningMessage",
    ]);
    expect(restarted.default.keywords).toEqual(["广告"]);
    expect(restarted.default.autoApproveJoin).toBe(true);
    expect(restarted.default.warningMessage).toBe("全局");
  });

  it("全局清一个字段后重启：它不再算覆盖，值回落种子", async () => {
    const repo = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = makeStore(repo, settings);
    store.setOverride({ groupId: DEFAULT_GROUP_ID, warningMessage: "全局文案" });
    store.setOverride({ groupId: DEFAULT_GROUP_ID, autoApproveJoin: true });
    await store.flush();

    store.clearFields(DEFAULT_GROUP_ID, ["warningMessage"]);
    await store.flush();

    const restarted = makeStore(repo, settings);
    await restarted.load();

    expect([...restarted.overriddenFields(DEFAULT_GROUP_ID)].sort()).toEqual([
      "autoApproveJoin",
    ]);
    expect(restarted.default.warningMessage).toBe(store.default.warningMessage);
    expect(restarted.default.autoApproveJoin).toBe(true);
  });

  it("全局清关键词后重启：不再算覆盖，回落种子关键词", async () => {
    const repo = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = makeStore(repo, settings);
    store.setOverride({ groupId: DEFAULT_GROUP_ID, keywords: ["广告"] });
    await store.flush();

    store.clearFields(DEFAULT_GROUP_ID, ["keywords"]);
    await store.flush();

    const restarted = makeStore(repo, settings);
    await restarted.load();

    expect(restarted.overriddenFields(DEFAULT_GROUP_ID).has("keywords")).toBe(
      false,
    );
    expect(restarted.default.keywords).toEqual(store.default.keywords);
  });
});
