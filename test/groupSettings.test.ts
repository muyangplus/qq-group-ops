import { describe, expect, it } from "vitest";

import { JoinDecisionMode } from "../src/core/enums.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import {
  FakeGroupConfigRepository,
  FakeGroupSettingsRepository,
} from "./helpers/fakeGroupConfigRepositories.js";

/**
 * §B2 多选重构：`punishActions` 走 `group_settings` 键值表（免迁移），
 * 老库里的 `keywordPunish` + `keywordRecall` 读取时自动换算。
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

  it("converts legacy punish settings and ignores malformed values", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    await settings.save({ groupId: "g1", key: "unknownKey", value: JSON.stringify(1) });
    // 非法枚举被忽略，合法的 keywordRecall 仍然换算成 punishActions.recall
    await settings.save({
      groupId: "g2",
      key: "keywordPunish",
      value: JSON.stringify("not-a-punish"),
    });
    await settings.save({
      groupId: "g2",
      key: "keywordRecall",
      value: JSON.stringify(true),
    });
    // 老库完整写法：kick_blacklist + 撤回 → 踢出 + 拉黑 + 撤回（警告默认开）
    await settings.save({
      groupId: "g3",
      key: "keywordPunish",
      value: JSON.stringify("kick_blacklist"),
    });
    await settings.save({
      groupId: "g3",
      key: "keywordRecall",
      value: JSON.stringify(true),
    });

    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);
    await store.load();

    // 未知键被忽略 → 还是默认值（只警告）
    expect(store.get("g1").punishActions).toEqual({
      warn: true,
      recall: false,
      mute: false,
      kick: false,
      blacklist: false,
    });
    expect(store.get("g2").punishActions).toEqual(RECALL_ONLY);
    expect(store.get("g3").punishActions).toEqual({
      warn: true,
      recall: true,
      mute: false,
      kick: true,
      blacklist: true,
    });
  });
});
