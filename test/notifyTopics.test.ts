import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { PermissionLevel, PlatformLevel } from "../src/core/enums.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import { DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import {
  NotificationService,
  NOTIFY_SCOPE_ALL,
} from "../src/services/notifications.js";
import {
  defaultNotifyTopicLevels,
  meetsNotifyLevel,
  NOTIFY_TOPIC_LEVELS_KEY,
  NotifyTopicLevelStore,
  parseNotifyTopicLevels,
  type NotifyChannel,
} from "../src/services/notifyTopics.js";
import { PermissionService } from "../src/services/permissions.js";
import { FakeGroupSettingsRepository } from "./helpers/fakeGroupConfigRepositories.js";

const EVENT_TOPICS: readonly NotifyChannel[] = [
  "bot_join",
  "bot_leave",
  "friend",
  "member_join",
  "unknown_event",
];

function permissionsFixture(): PermissionService {
  return new PermissionService({
    superAdminIds: new Set(["root"]),
    groupAdminIds: new Map([["g1", new Set(["admin"])]]),
    moderatorIds: new Map([["g2", new Set(["mod"])]]),
  });
}

describe("notifyTopics · 默认门槛", () => {
  it("入群 130 / 处罚 120 / 活动 -1（不限） / 事件类 240", () => {
    const levels = defaultNotifyTopicLevels();
    expect(levels.join).toBe(PermissionLevel.GroupAdmin);
    expect(levels.punish).toBe(PermissionLevel.Moderator);
    expect(levels.activity).toBe(PermissionLevel.Blacklisted);
    for (const topic of EVENT_TOPICS) {
      expect(levels[topic], topic).toBe(PlatformLevel.GlobalSuperAdmin);
    }
  });

  it("老库缺键 / 坏 JSON / 非法值逐项回落默认", () => {
    const defaults = defaultNotifyTopicLevels();

    expect(parseNotifyTopicLevels(undefined)).toEqual(defaults);
    expect(parseNotifyTopicLevels("")).toEqual(defaults);
    expect(parseNotifyTopicLevels("{不是 json")).toEqual(defaults);
    expect(parseNotifyTopicLevels("[]")).toEqual(defaults);
    // 只改一项时，其余保持默认
    expect(
      parseNotifyTopicLevels(
        JSON.stringify({ join: PlatformLevel.GlobalSuperAdmin }),
      ),
    ).toEqual({ ...defaults, join: PlatformLevel.GlobalSuperAdmin });
    // 非法值（类型错 / 越界）忽略该项
    expect(parseNotifyTopicLevels(JSON.stringify({ punish: "高" }))).toEqual(
      defaults,
    );
    expect(parseNotifyTopicLevels(JSON.stringify({ punish: 999 }))).toEqual(
      defaults,
    );
  });
});

describe("notifyTopics · 门槛判据（两轴）", () => {
  const permissions = permissionsFixture();

  it("<= 0 不限权限（活动通知口径）", () => {
    expect(
      meetsNotifyLevel(
        permissions,
        "stranger",
        PermissionLevel.Blacklisted,
        "g1",
      ),
    ).toBe(true);
    expect(
      meetsNotifyLevel(
        permissions,
        "stranger",
        PermissionLevel.Blacklisted,
        NOTIFY_SCOPE_ALL,
      ),
    ).toBe(true);
  });

  it(">= 200 走平台轴，群内角色压不过它", () => {
    expect(
      meetsNotifyLevel(
        permissions,
        "root",
        PlatformLevel.GlobalSuperAdmin,
        "g1",
      ),
    ).toBe(true);
    expect(
      meetsNotifyLevel(
        permissions,
        "admin",
        PlatformLevel.GlobalSuperAdmin,
        "g1",
      ),
    ).toBe(false);
  });

  it("群内档：具体群按该群折算判定", () => {
    expect(
      meetsNotifyLevel(permissions, "admin", PermissionLevel.GroupAdmin, "g1"),
    ).toBe(true);
    expect(
      meetsNotifyLevel(permissions, "mod", PermissionLevel.GroupAdmin, "g1"),
    ).toBe(false);
    expect(
      meetsNotifyLevel(permissions, "mod", PermissionLevel.Moderator, "g2"),
    ).toBe(true);
  });

  it("群内档 + 「全部群」= 全局超管或任一群够档", () => {
    expect(
      meetsNotifyLevel(
        permissions,
        "admin",
        PermissionLevel.GroupAdmin,
        NOTIFY_SCOPE_ALL,
      ),
    ).toBe(true);
    expect(
      meetsNotifyLevel(
        permissions,
        "mod",
        PermissionLevel.GroupAdmin,
        NOTIFY_SCOPE_ALL,
      ),
    ).toBe(false);
    expect(
      meetsNotifyLevel(
        permissions,
        "mod",
        PermissionLevel.Moderator,
        NOTIFY_SCOPE_ALL,
      ),
    ).toBe(true);
    expect(
      meetsNotifyLevel(
        permissions,
        "stranger",
        PermissionLevel.GroupAdmin,
        NOTIFY_SCOPE_ALL,
      ),
    ).toBe(false);
  });
});

describe("notifyTopics · 全局存储", () => {
  it("从库里的 __default__ 行读取，缺项回落默认", async () => {
    const repository = new FakeGroupSettingsRepository();
    await repository.save({
      groupId: DEFAULT_GROUP_ID,
      key: NOTIFY_TOPIC_LEVELS_KEY,
      value: JSON.stringify({ join: PermissionLevel.SuperAdmin }),
    });

    const store = new NotifyTopicLevelStore(repository);
    await store.load();

    expect(store.levelOf("join")).toBe(PermissionLevel.SuperAdmin);
    expect(store.levelOf("punish")).toBe(PermissionLevel.Moderator);
    expect(store.superAdminTopics()).toEqual(EVENT_TOPICS);
  });

  it("setLevel 会落库，并把话题纳入/移出「超管专属」", async () => {
    const repository = new FakeGroupSettingsRepository();
    const queue = new WriteQueue();
    const store = new NotifyTopicLevelStore(repository, queue);

    store.setLevel("join", PlatformLevel.GlobalSuperAdmin);
    await store.flush();

    expect(store.superAdminTopics()).toContain("join");
    const row = (await repository.findAll()).find(
      (setting) => setting.key === NOTIFY_TOPIC_LEVELS_KEY,
    );
    expect(row?.groupId).toBe(DEFAULT_GROUP_ID);
    expect(JSON.parse(row!.value)).toMatchObject({
      join: PlatformLevel.GlobalSuperAdmin,
    });

    // 热改回群内档后立即生效（无需重启）
    store.setLevel("join", PermissionLevel.GroupAdmin);
    expect(store.superAdminTopics()).not.toContain("join");
  });

  it("非法门槛直接拒绝", () => {
    const store = new NotifyTopicLevelStore();
    expect(() => store.setLevel("join", 999)).toThrow();
    expect(() => store.setLevel("join", 130.5)).toThrow();
  });
});

interface Harness {
  notifications: NotificationService;
  store: NotifyTopicLevelStore;
}

async function createHarness(): Promise<Harness> {
  const repository = new FakeGroupSettingsRepository();
  const queue = new WriteQueue();
  const store = new NotifyTopicLevelStore(repository, queue);
  await store.load();
  const identityMap = new IdentityMapService();
  identityMap.bindUser("member", "10001");
  const notifications = new NotificationService(
    new FakeQQOfficialAPI(),
    permissionsFixture(),
    { identityMap, notifyTopics: store, queue },
  );
  return { notifications, store };
}

describe("NotificationService · 订阅与推送同一判据", () => {
  it("三个老话题的订阅资格与历史行为一致", async () => {
    const { notifications } = await createHarness();

    expect(notifications.checkTopicReach("admin", "join", "g1")).toEqual({
      ok: true,
      reason: "",
    });
    const deniedJoin = notifications.checkTopicReach("mod", "join", "g1");
    expect(deniedJoin.ok).toBe(false);
    expect(deniedJoin.reason).toContain("群管理员");

    expect(notifications.checkTopicReach("mod", "punish", "g2").ok).toBe(true);
    expect(notifications.checkTopicReach("admin", "punish", "g2").ok).toBe(
      false,
    );

    // 活动不限权限；「全部群」要求已绑定 QQ 号
    expect(notifications.checkTopicReach("member", "activity", "g1").ok).toBe(
      true,
    );
    expect(
      notifications.checkTopicReach("member", "activity", "g2").ok,
    ).toBe(true);
    const unbound = notifications.checkTopicReach(
      "stranger",
      "activity",
      NOTIFY_SCOPE_ALL,
    );
    expect(unbound.ok).toBe(false);
    expect(unbound.reason).toContain("绑定");
    expect(
      notifications.checkTopicReach("member", "activity", NOTIFY_SCOPE_ALL).ok,
    ).toBe(true);
  });

  it("推送按具体群判定：订阅了「全部群」也要在该群有角色", async () => {
    const { notifications } = await createHarness();
    notifications.subscribe("admin", NOTIFY_SCOPE_ALL, "join");
    notifications.subscribe("mod", NOTIFY_SCOPE_ALL, "punish");

    expect(notifications.subscribersFor("g1", "join")).toEqual(["admin"]);
    expect(notifications.subscribersFor("g2", "punish")).toEqual(["mod"]);
    // mod 只在 g2 有审核员角色，g1 的处罚推送不发给他
    expect(notifications.subscribersFor("g1", "punish")).toEqual([]);
  });

  it("门槛提高后订阅失效，超管默认开订阅可补上", async () => {
    const { notifications, store } = await createHarness();
    notifications.subscribe("admin", "g1", "join");
    expect(notifications.subscribersFor("g1", "join")).toEqual(["admin"]);

    store.setLevel("join", PlatformLevel.GlobalSuperAdmin);
    expect(notifications.subscribersFor("g1", "join")).toEqual([]);

    expect(notifications.seedSuperAdminDefaults(["root"])).toBe(6);
    expect(notifications.subscribersFor("g1", "join")).toEqual(["root"]);
    // 幂等：再种一次不新增
    expect(notifications.seedSuperAdminDefaults(["root"])).toBe(0);
    expect(
      notifications.isSubscribed("root", NOTIFY_SCOPE_ALL, "bot_join"),
    ).toBe(true);
  });

  it("话题门槛走全局一行：所有群共享同一份配置", async () => {
    const { notifications, store } = await createHarness();
    expect(notifications.topicLevel("punish")).toBe(PermissionLevel.Moderator);
    store.setLevel("punish", PermissionLevel.GroupAdmin);
    expect(notifications.topicLevel("punish")).toBe(PermissionLevel.GroupAdmin);
    expect(notifications.checkTopicReach("mod", "punish", "g2").ok).toBe(false);
  });
});
