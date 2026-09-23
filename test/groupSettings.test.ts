import { describe, expect, it } from "vitest";

import { JoinDecisionMode, KeywordPunish } from "../src/core/enums.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import {
  FakeGroupConfigRepository,
  FakeGroupSettingsRepository,
} from "./helpers/fakeGroupConfigRepositories.js";

describe("GroupConfigStore extended settings", () => {
  it("persists and reloads extended settings for a group", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({
      groupId: "g1",
      keywordRecall: true,
      keywordPunish: KeywordPunish.KickBlacklist,
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

    expect(config.keywordRecall).toBe(true);
    expect(config.keywordPunish).toBe(KeywordPunish.KickBlacklist);
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

    store.setOverride({ groupId: "g1", keywordRecall: true });
    await store.flush();

    // 只改扩展字段时不能写整行快照，否则会把已有的列清成 NULL
    expect(sql.overrides.size).toBe(0);
    expect(settings.rows.size).toBe(1);
  });

  it("still writes group_configs when SQL backed fields change", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({ groupId: "g1", keywordRecall: true });
    store.setOverride({ groupId: "g1", autoApproveJoin: true });
    await store.flush();

    expect(sql.overrides.size).toBe(1);
    expect(sql.overrides.get("g1")?.autoApproveJoin).toBe(true);
    // 同一次合并里仍然保留扩展字段（内存态）
    expect(store.get("g1").keywordRecall).toBe(true);
  });

  it("supports global extended settings through __default__", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({
      groupId: DEFAULT_GROUP_ID,
      keywordRecall: true,
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

    expect(reloaded.default.keywordRecall).toBe(true);
    expect(reloaded.default.joinDecision).toBe(JoinDecisionMode.ApproveOnMatch);
    expect(reloaded.default.joinRequireClass).toBe(true);
    // 未单独配置的群继承全局扩展设置
    expect(reloaded.get("brand-new").joinRequireClass).toBe(true);
  });

  it("resets extended settings on removeOverride", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);

    store.setOverride({ groupId: "g1", keywordRecall: true });
    await store.flush();
    store.removeOverride("g1");
    await store.flush();

    expect(settings.rows.size).toBe(0);
    expect(store.get("g1").keywordRecall).toBe(false);
  });

  it("ignores unknown or malformed persisted settings", async () => {
    const sql = new FakeGroupConfigRepository();
    const settings = new FakeGroupSettingsRepository();
    await settings.save({ groupId: "g1", key: "unknownKey", value: JSON.stringify(1) });
    await settings.save({
      groupId: "g1",
      key: "keywordPunish",
      value: JSON.stringify("not-a-punish"),
    });
    await settings.save({
      groupId: "g1",
      key: "keywordRecall",
      value: JSON.stringify(true),
    });

    const store = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }, sql, undefined, settings);
    await store.load();

    expect(store.get("g1").keywordRecall).toBe(true);
    expect(store.get("g1").keywordPunish).toBe(KeywordPunish.None);
  });
});
