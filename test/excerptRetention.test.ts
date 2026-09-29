import { beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import type { PlatformSettingsRepository } from "../src/db/platformSettingsRepository.js";
import { rawMessageDaysResolver } from "../src/services/excerptRetention.js";
import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import { FakeGroupConfigRepository } from "./helpers/fakeGroupConfigRepositories.js";

class FakeRepository implements PlatformSettingsRepository {
  public readonly rows = new Map<string, string>();
  public async findAll() {
    return [...this.rows.entries()].map(([key, value]) => ({ key, value }));
  }
  public async save(setting: { key: string; value: string }) {
    this.rows.set(setting.key, setting.value);
  }
  public async remove(key: string) {
    this.rows.delete(key);
  }
}

/**
 * P1：处罚原文保留期的取值口径 —— 按群算，群没设过就用平台默认值（`/config` 里那一项）。
 */
describe("rawMessageDaysResolver", () => {
  let platform: PlatformSettingsStore;
  let configStore: GroupConfigStore;

  beforeEach(async () => {
    platform = new PlatformSettingsStore(loadSettings({}), new FakeRepository());
    await platform.load();
    configStore = new GroupConfigStore(
      { groupId: DEFAULT_GROUP_ID },
      new FakeGroupConfigRepository(),
    );
  });

  it("群没设过 → 用平台默认值（含 -1 / 0）", async () => {
    const daysOf = rawMessageDaysResolver(configStore, platform);
    expect(daysOf("g1")).toBe(0);

    await platform.set("rawMessageRetentionDays", "7");
    expect(daysOf("g1")).toBe(7);

    // 永久保留也照传（调用方按 <= 0 跳过清理）
    await platform.set("rawMessageRetentionDays", "-1");
    expect(daysOf("g1")).toBe(-1);
  });

  it("群显式设过 → 用群值，且不受平台默认值影响", async () => {
    await platform.set("rawMessageRetentionDays", "7");
    configStore.setOverride({
      groupId: "g1",
      rawMessageRetentionDays: 30,
    });
    const daysOf = rawMessageDaysResolver(configStore, platform);

    expect(daysOf("g1")).toBe(30);
    // 别的群仍然吃平台默认值
    expect(daysOf("g2")).toBe(7);
  });

  it("全局默认规则设过 → 所有群都用它（平台默认不覆盖）", async () => {
    await platform.set("rawMessageRetentionDays", "7");
    configStore.setOverride({
      groupId: DEFAULT_GROUP_ID,
      rawMessageRetentionDays: 3,
    });
    const daysOf = rawMessageDaysResolver(configStore, platform);

    expect(daysOf("g1")).toBe(3);
    expect(daysOf("g2")).toBe(3);
  });

  it("群设 0（不存原文）不会被平台默认值顶回来", async () => {
    await platform.set("rawMessageRetentionDays", "7");
    configStore.setOverride({ groupId: "g1", rawMessageRetentionDays: 0 });
    const daysOf = rawMessageDaysResolver(configStore, platform);

    expect(daysOf("g1")).toBe(0);
    expect(daysOf("g2")).toBe(7);
  });
});
