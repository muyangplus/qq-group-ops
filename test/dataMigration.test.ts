import { beforeEach, describe, expect, it } from "vitest";

import type { ActivityDetails } from "../src/services/activity.js";
import { DataMigrationService, totalPending } from "../src/services/dataMigration.js";
import { FakeGroupSettingsRepository } from "./helpers/fakeGroupConfigRepositories.js";
import {
  FakeMigrationActivityDetailsRepository,
  FakeMigrationProfileRepository,
  FakeMigrationShortCodeRepository,
} from "./helpers/fakeMigrationRepositories.js";

/**
 * 一次性数据迁移（`/migrate` 的服务层）：把老库内容转成现行格式。
 *
 * 主体代码不再兼容老格式，因此这里同时覆盖「扫描到的条数」与「改写成什么」，
 * 以及「重复执行等价于什么都不做」（幂等）。
 */
describe("DataMigrationService", () => {
  let settings: FakeGroupSettingsRepository;
  let profiles: FakeMigrationProfileRepository;
  let activityDetails: FakeMigrationActivityDetailsRepository;
  let shortCodes: FakeMigrationShortCodeRepository;
  let generated: string[];
  let reloads: number;

  function build(): DataMigrationService {
    return new DataMigrationService({
      settings,
      profiles,
      activityDetails,
      shortCodes,
      generateCode: () => generated.shift() ?? "AAA111",
      reload: async () => {
        reloads += 1;
      },
    });
  }

  beforeEach(() => {
    settings = new FakeGroupSettingsRepository();
    profiles = new FakeMigrationProfileRepository();
    activityDetails = new FakeMigrationActivityDetailsRepository();
    shortCodes = new FakeMigrationShortCodeRepository();
    generated = [];
    reloads = 0;
  });

  it("reports nothing to do on an already migrated database", async () => {
    await settings.save({
      groupId: "g1",
      key: "punishActions",
      value: JSON.stringify({
        warn: true,
        recall: true,
        mute: false,
        kick: false,
        blacklist: false,
      }),
    });
    await settings.save({
      groupId: "g1",
      key: "allowYears",
      value: JSON.stringify(["22", "23"]),
    });

    const service = build();
    expect(service.persistent).toBe(true);
    expect(totalPending(await service.plan())).toBe(0);

    expect(totalPending(await service.run())).toBe(0);
    // 没有改写就不重载内存态
    expect(reloads).toBe(0);
  });

  it("encodes bare string settings as JSON", async () => {
    await settings.save({ groupId: "g1", key: "welcomeMessage", value: "你好" });
    await settings.save({
      groupId: "g2",
      key: "joinAnswerPattern",
      value: "^\\d+$",
    });

    expect((await build().plan()).settings).toBe(2);

    await build().run();

    expect(settings.rows.get("g1\u0000welcomeMessage")?.value).toBe(
      JSON.stringify("你好"),
    );
    expect(settings.rows.get("g2\u0000joinAnswerPattern")?.value).toBe(
      JSON.stringify("^\\d+$"),
    );
  });

  it("folds legacy punish keys into punishActions and drops the old keys", async () => {
    await settings.save({
      groupId: "g1",
      key: "keywordPunish",
      value: JSON.stringify("kick_blacklist"),
    });
    await settings.save({
      groupId: "g1",
      key: "keywordRecall",
      value: JSON.stringify(true),
    });
    // 另一个群只有老枚举，没有撤回
    await settings.save({
      groupId: "g2",
      key: "keywordPunish",
      value: JSON.stringify("mute"),
    });
    // 裸字符串写法（早期直接写枚举名）也要认
    await settings.save({ groupId: "g3", key: "keywordPunish", value: "kick" });

    const plan = await build().plan();
    expect(plan.legacyPunishGroups).toBe(3);
    // 裸字符串那一行同时被 JSON 编码，两个计数各自算
    expect(plan.settings).toBe(1);

    await build().run();

    expect(JSON.parse(settings.rows.get("g1\u0000punishActions")!.value)).toEqual({
      warn: true,
      recall: true,
      mute: false,
      kick: true,
      blacklist: true,
    });
    expect(JSON.parse(settings.rows.get("g2\u0000punishActions")!.value)).toEqual({
      warn: true,
      recall: false,
      mute: true,
      kick: false,
      blacklist: false,
    });
    expect(JSON.parse(settings.rows.get("g3\u0000punishActions")!.value)).toEqual({
      warn: true,
      recall: false,
      mute: false,
      kick: true,
      blacklist: false,
    });
    expect(settings.rows.has("g1\u0000keywordPunish")).toBe(false);
    expect(settings.rows.has("g1\u0000keywordRecall")).toBe(false);
    expect(settings.rows.has("g3\u0000keywordPunish")).toBe(false);
    expect(reloads).toBe(1);
  });

  it("keeps an existing punishActions row and only clears the legacy keys", async () => {
    const current = {
      warn: true,
      recall: false,
      mute: false,
      kick: false,
      blacklist: true,
    };
    await settings.save({
      groupId: "g1",
      key: "punishActions",
      value: JSON.stringify(current),
    });
    await settings.save({
      groupId: "g1",
      key: "keywordPunish",
      value: JSON.stringify("kick"),
    });

    await build().run();

    expect(JSON.parse(settings.rows.get("g1\u0000punishActions")!.value)).toEqual(
      current,
    );
    expect(settings.rows.has("g1\u0000keywordPunish")).toBe(false);
  });

  it("collapses four-digit years in group settings, profiles and activities", async () => {
    await settings.save({
      groupId: "g1",
      key: "allowYears",
      value: JSON.stringify(["2022", "23"]),
    });
    await settings.save({
      groupId: "g1",
      key: "denyYears",
      value: JSON.stringify(["2026"]),
    });
    profiles.rows.set("u1", {
      userId: "u1",
      name: "小明",
      studentId: "22123456789",
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "2022",
    });
    profiles.rows.set("u2", {
      userId: "u2",
      name: "小红",
      studentId: "23123456789",
      className: "环工2414",
      college: "环境科学与工程学院",
      year: "23",
    });
    activityDetails.rows.push(activity("a1", "K2M7Q9", ["2023"], ["2022"]));

    const plan = await build().plan();
    expect(plan.settings).toBe(2);
    expect(plan.profileYears).toBe(1);
    expect(plan.activityYears).toBe(1);
    expect(plan.activityCodes).toBe(0);

    await build().run();

    expect(JSON.parse(settings.rows.get("g1\u0000allowYears")!.value)).toEqual([
      "22",
      "23",
    ]);
    expect(JSON.parse(settings.rows.get("g1\u0000denyYears")!.value)).toEqual([
      "26",
    ]);
    expect(profiles.rows.get("u1")?.year).toBe("22");
    expect(profiles.rows.get("u2")?.year).toBe("23");
    expect(activityDetails.rows[0]?.rules.allowYears).toEqual(["23"]);
    expect(activityDetails.rows[0]?.rules.denyYears).toEqual(["22"]);
  });

  it("regenerates lowercase short codes and activity codes", async () => {
    shortCodes.rows.push({
      code: "Ab12Cd",
      kind: "group",
      targetId: "group-openid",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    shortCodes.rows.push({
      code: "EF34GH",
      kind: "user",
      targetId: "user-openid",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    activityDetails.rows.push(activity("a1", "ab12cd", [], []));
    generated = ["Z9Y8X7", "Q1W2E3"];

    const plan = await build().plan();
    expect(plan.shortCodes).toBe(1);
    expect(plan.activityCodes).toBe(1);

    await build().run();

    // 换码后 (kind, targetId) 不变，只换主键；活动先换、短码后换
    expect(activityDetails.rows[0]?.code).toBe("Z9Y8X7");
    expect(shortCodes.rows[0]).toMatchObject({
      code: "Q1W2E3",
      kind: "group",
      targetId: "group-openid",
    });
    // 已经是大写的短码不动
    expect(shortCodes.rows[1]?.code).toBe("EF34GH");
  });

  it("does not consume generated codes while previewing", async () => {
    shortCodes.rows.push({
      code: "Ab12Cd",
      kind: "group",
      targetId: "group-openid",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    activityDetails.rows.push(activity("a1", "ab12cd", [], []));
    generated = ["Z9Y8X7", "Q1W2E3"];

    // 预览两次不占用码池
    await build().plan();
    await build().plan();

    await build().run();

    expect(activityDetails.rows[0]?.code).toBe("Z9Y8X7");
    expect(shortCodes.rows[0]?.code).toBe("Q1W2E3");
  });

  it("is idempotent: running twice changes nothing the second time", async () => {
    await settings.save({
      groupId: "g1",
      key: "keywordPunish",
      value: JSON.stringify("kick"),
    });
    await settings.save({ groupId: "g1", key: "welcomeMessage", value: "你好" });
    profiles.rows.set("u1", {
      userId: "u1",
      name: "小明",
      studentId: "22123456789",
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "2022",
    });
    shortCodes.rows.push({
      code: "Ab12Cd",
      kind: "group",
      targetId: "group-openid",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    activityDetails.rows.push(activity("a1", "ab12cd", ["2023"], []));
    generated = ["Z9Y8X7", "Q1W2E3"];

    const first = await build().run();
    const snapshot = databaseSnapshot();
    const reloadsAfterFirst = reloads;

    const second = await build().run();

    expect(totalPending(first)).toBeGreaterThan(0);
    expect(totalPending(second)).toBe(0);
    expect(reloads).toBe(reloadsAfterFirst);
    expect(databaseSnapshot()).toBe(snapshot);
  });

  it("refuses to run without a database connection", async () => {
    const service = new DataMigrationService({
      generateCode: () => "AAA111",
    });
    expect(service.persistent).toBe(false);
    await expect(service.run()).rejects.toThrow(/数据库/u);
  });

  function databaseSnapshot(): string {
    return JSON.stringify({
      settings: [...settings.rows.entries()],
      profiles: [...profiles.rows.entries()],
      shortCodes: shortCodes.rows,
      activities: activityDetails.rows,
    });
  }
});

function activity(
  activityId: string,
  code: string,
  allowYears: string[],
  denyYears: string[],
): ActivityDetails {
  return {
    activityId,
    code,
    groupNumber: "",
    links: [],
    rules: { allowColleges: [], denyColleges: [], allowYears, denyYears },
  };
}
