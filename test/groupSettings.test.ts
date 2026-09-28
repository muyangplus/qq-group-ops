import { describe, expect, it } from "vitest";

import { JoinDecisionMode } from "../src/core/enums.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import {
  FakeGroupConfigRepository,
  FakeGroupSettingsRepository,
} from "./helpers/fakeGroupConfigRepositories.js";

/**
 * `punishActions` 等扩展字段走 `group_settings` 键值表（免迁移）：
 * 值一律是 JSON 编码，老格式由 `/migrate` 一次性转换。
 */
const RECALL_ONLY = {
  warn: true,
  recall: true,
  mute: false,
  kick: false,
  blacklist: false,
};

describe("GroupConfigStore extended settings", () => {
  it("persists and reloads extended settings for a group", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({
      groupId: "g1",
      punishActions: { warn: true, recall: true, mute: false, kick: true, blacklist: true },
      joinDecision: JoinDecisionMode.RejectOnMismatch,
      joinRequireClass: true,
      joinRequireName: true,
      joinAnswerPattern: "^材化\\d{4}\\s+\\S{2,4}$",
      joinReviewOpinion: false,
    });
    await store.flush();

    const reloaded = new GroupConfigStore(
      { groupId: DEFAULT_GROUP_ID },
      sql,
      undefined,
      settings,
    );
    await reloaded.load();
    const config = reloaded.get("g1");

    expect(config.punishActions).toEqual({
      warn: true,
      recall: true,
      mute: false,
      kick: true,
      blacklist: true,
    });
    expect(config.joinDecision).toBe(JoinDecisionMode.RejectOnMismatch);
    expect(config.joinRequireClass).toBe(true);
    expect(config.joinRequireName).toBe(true);
    expect(config.joinAnswerPattern).toBe("^材化\\d{4}\\s+\\S{2,4}$");
    expect(config.joinReviewOpinion).toBe(false);
  });

  it("does not touch group_configs when only extended fields change", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({ groupId: "g1", punishActions: RECALL_ONLY });
    await store.flush();

    // 只改扩展字段时不能写整行快照，否则会把已有的列清成 NULL
    expect(sql.overrides.size).toBe(0);
    expect(settings.rows.size).toBe(1);
  });

  it("still writes group_configs when SQL backed fields change", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({ groupId: "g1", punishActions: RECALL_ONLY });
    store.setOverride({ groupId: "g1", autoApproveJoin: true });
    await store.flush();

    expect(sql.overrides.size).toBe(1);
    expect(sql.overrides.get("g1")?.autoApproveJoin).toBe(true);
    // 同一次合并里仍然保留扩展字段（内存态）
    expect(store.get("g1").punishActions.recall).toBe(true);
  });

  it("supports global extended settings through __default__", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({
      groupId: DEFAULT_GROUP_ID,
      punishActions: RECALL_ONLY,
      joinDecision: JoinDecisionMode.ApproveOnMatch,
      joinRequireClass: true,
    });
    await store.flush();

    const reloaded = new GroupConfigStore(
      { groupId: DEFAULT_GROUP_ID },
      sql,
      undefined,
      settings,
    );
    await reloaded.load();

    expect(reloaded.default.punishActions.recall).toBe(true);
    expect(reloaded.default.joinDecision).toBe(JoinDecisionMode.ApproveOnMatch);
    expect(reloaded.default.joinRequireClass).toBe(true);
    // 未单独配置的群继承全局扩展设置
    expect(reloaded.get("brand-new").joinRequireClass).toBe(true);
  });

  it("resets extended settings on removeOverride", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({ groupId: "g1", punishActions: RECALL_ONLY });
    await store.flush();
    store.removeOverride("g1");
    await store.flush();

    expect(settings.rows.size).toBe(0);
    expect(store.get("g1").punishActions.recall).toBe(false);
  });

  it("ignores unknown keys and non-JSON values", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    await settings.save({ groupId: "g1", key: "unknownKey", value: JSON.stringify(1) });
    // 非法枚举被忽略 → 保持默认动作
    await settings.save({
      groupId: "g2",
      key: "punishActions",
      value: JSON.stringify({ warn: "yes" }),
    });
    // 早期版本直接写入裸字符串：不是合法 JSON，读取时跳过（改由 /migrate 转换）
    await settings.save({
      groupId: "g3",
      key: "welcomeMessage",
      value: "同学们好",
    });

    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);
    await store.load();

    const fallback = {
      warn: true,
      recall: false,
      mute: false,
      kick: false,
      blacklist: false,
    };
    expect(store.get("g1").punishActions).toEqual(fallback);
    expect(store.get("g2").punishActions).toEqual(fallback);
    // 裸字符串被跳过 → 欢迎语停在默认值
    expect(store.get("g3").welcomeMessage).toBe(
      store.builtinDefault.welcomeMessage,
    );
  });
});
