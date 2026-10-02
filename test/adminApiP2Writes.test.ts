import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import { createAdminApiEntities } from "../src/adminApi/entityRef.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { loadSettings } from "../src/config.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AppealService } from "../src/services/appeals.js";
import { AuditLogStore } from "../src/services/audit.js";
import { BlacklistService } from "../src/services/blacklist.js";
import { ClassAliasService } from "../src/services/classAliases.js";
import { MemberRoster } from "../src/services/memberRoster.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { NotificationService } from "../src/services/notifications.js";
import { NotifyTopicLevelStore } from "../src/services/notifyTopics.js";
import { PermissionService } from "../src/services/permissions.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import { PunishmentService } from "../src/services/punishments.js";

/**
 * 管理后台 **P2 写操作**（处罚动作 / 黑名单增删 / 申诉复核）。
 *
 * 口径是「与指令层同源」：同一个领域服务、同样的门槛（本群 120 / 全局 240）、
 * 同样的连带效果（处置即把该处罚下待处理申诉判为已通过；通过申诉 = 撤销处罚），
 * 区别只在**入口**（浏览器）+ 每条都写 `admin_api:*` 审计。
 */
interface Harness {
  backend: AdminApiBackend;
  api: FakeQQOfficialAPI;
  auditLog: AuditLogStore;
  punishments: PunishmentService;
  blacklist: BlacklistService;
  appeals: AppealService;
  permissions: PermissionService;
  configStore: GroupConfigStore;
  classAliases: ClassAliasService;
}

function harness(): Harness {
  const api = new FakeQQOfficialAPI();
  const writeQueue = new WriteQueue();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const permissions = new PermissionService({
    superAdminIds: new Set(["boss"]),
  });
  permissions.grantModerator("g1", "mod");
  permissions.grantGroupAdmin("g1", "admin");
  const blacklist = new BlacklistService(api, { auditLog, queue: writeQueue });
  const punishments = new PunishmentService(api, blacklist, {
    auditLog,
    queue: writeQueue,
  });
  const appeals = new AppealService({ queue: writeQueue });
  const classAliases = new ClassAliasService();
  // 别名类型判定依赖班级库（线上来自 class:index）；测试里给一份最小索引
  classAliases.setRoster(
    MemberRoster.fromIndex({
      classes: ["材化2211", "环境类2214"],
      majors: ["材料化学", "环境工程"],
      classInfo: {
        材化2211: {
          major: "材料化学",
          college: "化学与生命科学学院",
          year: "2022",
        },
        环境类2214: {
          major: "环境工程",
          college: "环境科学与工程学院",
          year: "2022",
        },
      },
    }),
  );
  const backend = createAdminApiBackend({
    permissions,
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({
      profiles: { get: () => undefined },
    }),
    database: "sqlite",
    platform: new PlatformSettingsStore(loadSettings({ APPEAL_HOLD_MINUTES: "15" })),
    entities: createAdminApiEntities({
      qqOf: (userId) => ({ u1: "10001", mod: "10003" })[userId],
      groupNumberOf: (groupId) => ({ g1: "50001" })[groupId],
    }),
    punishments,
    blacklist,
    appeals,
    classAliases,
  });
  return {
    backend,
    api,
    auditLog,
    punishments,
    blacklist,
    appeals,
    permissions,
    configStore,
    classAliases,
  };
}

/** 建一条处罚（带禁言，便于验证撤销效果）。 */
async function seedPunishment(h: Harness): Promise<string> {
  const record = await h.punishments.create({
    groupId: "g1",
    userId: "u1",
    actorId: "bot",
    source: "keyword",
    ruleReason: "广告",
    actions: {
      recalled: true,
      muted: true,
      muteDurationSeconds: 600,
      kicked: false,
      blacklist: "",
    },
  });
  return record.recordId;
}

describe("管理 API P2：处罚动作", () => {
  it("解除处罚：状态变 released、写审计、并把待处理申诉判为已通过", async () => {
    const h = harness();
    const recordId = await seedPunishment(h);
    // 当事人提过一条申诉（待处理）
    const submitted = await h.appeals.submit({
      punishment: h.punishments.get(recordId)!,
      userId: "u1",
      reason: "手滑了",
    });

    const result = await h.backend.punish({
      code: recordId,
      action: "release",
      actorId: "mod",
      note: "申诉通过",
    });

    expect(result.ok).toBe(true);
    expect(result.punishment.status).toBe("released");
    // 「处置即回应申诉」：与指令层一致
    expect(result.acceptedAppeals).toBe(1);
    expect(h.appeals.get(submitted.appeal.appealId)?.status).toBe("accepted");
    const audit = h.auditLog
      .all()
      .find((row) => row.action === "admin_api:punish_release");
    expect(audit?.actorId).toBe("mod");
    expect(audit?.targetUserId).toBe("u1");
  });

  it("改禁言时长：0 = 解除禁言，动作摘要跟着变", async () => {
    const h = harness();
    const recordId = await seedPunishment(h);

    const result = await h.backend.punish({
      code: recordId,
      action: "mute",
      actorId: "mod",
      seconds: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.punishment.actions).not.toContain("禁言");
    expect(h.auditLog.all().some((row) => row.action === "admin_api:punish_mute")).toBe(
      true,
    );
  });

  it("移出群：调官方接口并写审计（不可逆动作）", async () => {
    const h = harness();
    const recordId = await seedPunishment(h);

    const result = await h.backend.punish({
      code: recordId,
      action: "kick",
      actorId: "mod",
    });

    expect(result.ok).toBe(true);
    expect(h.api.removedMembers).toEqual([["g1", "u1"]]);
    expect(result.punishment.actions).toContain("移出群");
  });

  it("拉黑：本群 120 可以；全局要平台超管 240", async () => {
    const h = harness();
    const recordId = await seedPunishment(h);

    const group = await h.backend.punish({
      code: recordId,
      action: "blacklist",
      actorId: "mod",
      scope: "group",
      reason: "屡犯",
    });
    expect(group.ok).toBe(true);
    expect(h.blacklist.hasGroup("g1", "u1")).toBe(true);

    const otherId = await seedPunishment(h);
    await expect(
      h.backend.punish({
        code: otherId,
        action: "blacklist",
        actorId: "mod",
        scope: "global",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    const global = await h.backend.punish({
      code: otherId,
      action: "blacklist",
      actorId: "boss",
      scope: "global",
    });
    expect(global.ok).toBe(true);
    expect(h.blacklist.hasGlobal("u1")).toBe(true);
  });

  it("不在本群 120 的人被拒，并写一条拒绝审计", async () => {
    const h = harness();
    const recordId = await seedPunishment(h);

    await expect(
      h.backend.punish({ code: recordId, action: "kick", actorId: "nobody" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    expect(h.auditLog.all().map((row) => row.action)).toContain("admin_api:denied");
  });

  it("短码不存在 → 404 语义（不是静默成功）", async () => {
    const h = harness();

    await expect(
      h.backend.punish({ code: "NOPE1", action: "release", actorId: "mod" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
  });
});

describe("管理 API P2：黑名单增删", () => {
  it("本群加入：写审计、并把人移出群", async () => {
    const h = harness();

    const result = await h.backend.addBlacklist({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
      reason: "广告",
    });

    expect(result).toMatchObject({
      action: "add",
      ok: true,
      scope: "group",
      groupId: "g1",
      userId: "u1",
    });
    expect(h.blacklist.hasGroup("g1", "u1")).toBe(true);
    expect(h.api.removedMembers).toContainEqual(["g1", "u1"]);
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:blacklist_add"),
    ).toBe(true);
  });

  it("全局加入要 240；解除本群 120 即可", async () => {
    const h = harness();
    await expect(
      h.backend.addBlacklist({
        scope: "global",
        userId: "u1",
        actorId: "mod",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    await h.backend.addBlacklist({
      scope: "global",
      userId: "u1",
      actorId: "boss",
      reason: "屡犯",
    });
    expect(h.blacklist.hasGlobal("u1")).toBe(true);

    const removed = await h.backend.removeBlacklist({
      scope: "global",
      userId: "u1",
      actorId: "boss",
    });
    expect(removed).toMatchObject({ action: "remove", ok: true });
    expect(h.blacklist.hasGlobal("u1")).toBe(false);

    await h.backend.addBlacklist({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
    });
    const groupRemoved = await h.backend.removeBlacklist({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      actorId: "mod",
    });
    expect(groupRemoved.ok).toBe(true);
    expect(h.blacklist.hasGroup("g1", "u1")).toBe(false);
  });

  it("解除一个不在名单里的人：ok=false 但写审计（不是异常）", async () => {
    const h = harness();

    const result = await h.backend.removeBlacklist({
      scope: "group",
      groupId: "g1",
      userId: "nobody",
      actorId: "mod",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("不在");
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:blacklist_remove"),
    ).toBe(true);
  });
});

describe("管理 API P2：通知门槛与测试推送", () => {
  function notifyHarness(): Harness & {
    notifications: NotificationService;
    notifyTopics: NotifyTopicLevelStore;
  } {
    const h = harness();
    const subscriptions = [
      { userId: "u1", scope: "join:__all__" },
      { userId: "u1", scope: "punish:g1" },
    ];
    const queue = new WriteQueue();
    const notifyTopics = new NotifyTopicLevelStore(
      {
        async findAll() {
          return [];
        },
        async save() {
          // 测试不需要落库
        },
        async remove() {
          // 测试不需要删行
        },
      },
      queue,
    );
    const notifications = new NotificationService(h.api, h.permissions, {
      // 与运行时同一份装配：门槛存储既给推送服务（判门槛）也给管理后端（改门槛）
      notifyTopics,
      subscriptions: {
        async findAll() {
          return subscriptions;
        },
        async save() {
          // 测试不需要写订阅
        },
        async remove() {
          // 测试不需要删订阅
        },
      },
      deliveries: {
        async findAll() {
          return [];
        },
        async save() {
          // 测试不需要写投递
        },
        async deleteOlderThan() {
          // 测试不需要清理
        },
      },
    });
    const backend = createAdminApiBackend({
      permissions: h.permissions,
      auditLog: h.auditLog,
      joinAudit: h.joinAudit,
      joinApproval: new JoinApprovalService(
        h.api,
        h.joinAudit,
        new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      ),
      configStore: new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      activity: new ActivityService(),
      activityExport: new ActivityExportService({
        profiles: { get: () => undefined },
      }),
      notifications,
      notifyTopics,
      notificationSubscriptions: {
        async findAll() {
          return subscriptions;
        },
      } as never,
    });
    return { ...h, backend, notifications, notifyTopics };
  }

  it("改门槛：平台超管才行；写审计；返回的视图带当前门槛与订阅计数", async () => {
    const h = notifyHarness();

    await expect(
      h.backend.setNotifyLevel({ topic: "join", level: 130, actorId: "mod" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    const result = await h.backend.setNotifyLevel({
      topic: "join",
      level: 140,
      actorId: "boss",
    });

    expect(result.message).toContain("入群申请");
    const join = result.topics.find((topic) => topic.topic === "join");
    expect(join).toMatchObject({ level: 140, allScope: 1, groupScopes: 0 });
    // 提示文案与订阅计数都在（界面直接用，不需要再取一次）
    expect(join?.hint).toBeTruthy();
    expect(h.notifications.topicLevel("join")).toBe(140);
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:notify_level"),
    ).toBe(true);
  });

  it("未知话题 / 非法数值都明确报错", async () => {
    const h = notifyHarness();

    await expect(
      h.backend.setNotifyLevel({ topic: "nope", level: 130, actorId: "boss" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    await expect(
      h.backend.setNotifyLevel({ topic: "join", level: 999, actorId: "boss" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
  });

  it("恢复默认：写审计", async () => {
    const h = notifyHarness();
    await h.backend.setNotifyLevel({ topic: "join", level: 140, actorId: "boss" });

    const result = await h.backend.resetNotifyLevels("boss");

    expect(result.message).toContain("恢复默认");
    expect(
      h.auditLog
        .all()
        .some((row) => row.action === "admin_api:notify_level_reset"),
    ).toBe(true);
  });

  it("测试推送只发给自己：失败时把原因带回来", async () => {
    const h = notifyHarness();

    const ok = await h.backend.sendNotifyTest({ userId: "mod" });
    expect(ok.ok).toBe(true);
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:notify_test"),
    ).toBe(true);

    h.api.failPrivateRichMessages = true;
    h.api.failPrivateKeyboardMessages = true;
    h.api.failPrivateMessages = true;
    const failed = await h.backend.sendNotifyTest({ userId: "mod" });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("没发出去");
  });
});

describe("管理 API P2：规则关键词与恢复继承", () => {
  it("加词：逐词校验（空 / 超长 / 重复跳过并如实报告），成功写审计", async () => {
    const h = harness();

    const result = await h.backend.addRuleKeywords({
      groupId: "g1",
      words: ["广告", " 刷屏 ", "", "广告", "x".repeat(60)],
      actorId: "admin",
    });

    // 只有「广告」「刷屏」真的加进去了（trim + 去重，与指令层同一套规则）
    expect(result.added).toEqual(["广告", "刷屏"]);
    expect(result.keywords).toEqual(["刷屏", "广告"]);
    expect(result.skipped.map((item) => item.reason)).toEqual([
      "空词",
      "已存在",
      "超过 50 字",
    ]);
    expect(result.message).toContain("已添加 2 个");
    expect(h.configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);
    const audit = h.auditLog
      .all()
      .find((row) => row.action === "admin_api:rule_keywords");
    expect(audit?.actorId).toBe("admin");
    expect(audit?.groupId).toBe("g1");
  });

  it("删词：不存在的词进 skipped（不静默成功）", async () => {
    const h = harness();
    await h.backend.addRuleKeywords({
      groupId: "g1",
      words: ["广告"],
      actorId: "admin",
    });

    const result = await h.backend.removeRuleKeywords({
      groupId: "g1",
      words: ["广告", "从没有过的词"],
      actorId: "admin",
    });

    expect(result.removed).toEqual(["广告"]);
    expect(result.keywords).toEqual([]);
    expect(result.skipped).toEqual([{ word: "从没有过的词", reason: "不存在" }]);
    expect(result.message).toContain("不存在");
  });

  it("恢复字段继承 / 整群重置：覆盖字段列表如实返回；门槛同 /rules", async () => {
    const h = harness();
    await h.backend.updateRule("g1", "keywords", "广告,刷屏", "admin");
    await h.backend.updateRule("g1", "warning", "请勿发广告", "admin");

    const fields = await h.backend.resetRuleFields({
      groupId: "g1",
      fields: ["keywords"],
      actorId: "admin",
    });

    expect(fields.scope).toBe("fields");
    expect(fields.fields).toEqual(["keywords"]);
    expect(fields.overriddenFields).not.toContain("keywords");
    expect(fields.overriddenFields).toContain("warningMessage");
    expect(h.configStore.get("g1").keywords).toEqual(
      h.configStore.default.keywords,
    );

    const all = await h.backend.resetRuleGroup({ groupId: "g1", actorId: "admin" });
    expect(all.scope).toBe("all");
    expect(all.overriddenFields).toEqual([]);
    expect(
      h.auditLog.all().filter((row) => row.action === "admin_api:rule_reset"),
    ).toHaveLength(2);
  });

  it("未知字段 / 没权限改全局规则都明确报错", async () => {
    const h = harness();

    await expect(
      h.backend.resetRuleFields({
        groupId: "g1",
        fields: ["noSuchField"],
        actorId: "admin",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    // 全局规则只有平台超管能改（与指令层 canManageRules 同口径）
    await expect(
      h.backend.addRuleKeywords({
        groupId: "__default__",
        words: ["广告"],
        actorId: "admin",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
  });
});

describe("管理 API P2：别名表", () => {
  it("只有平台超管能改；写入后回整表", async () => {
    const h = harness();

    await expect(
      h.backend.setAlias({
        alias: "环工2214",
        target: "环境类2214",
        actorId: "op1",
      }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    const saved = await h.backend.setAlias({
      alias: "环工2214",
      target: "环境类2214",
      actorId: "boss",
    });

    expect(saved.ok).toBe(true);
    expect(saved.aliases).toHaveLength(1);
    expect(saved.aliases[0]).toMatchObject({
      alias: "环工2214",
      target: "环境类2214",
    });
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:alias_set"),
    ).toBe(true);
  });

  it("删除：不存在时 ok=false 且如实说明（不静默成功）", async () => {
    const h = harness();
    await h.backend.setAlias({
      alias: "化生学院",
      target: "化学与生命科学学院",
      actorId: "boss",
    });

    const removed = await h.backend.removeAlias({
      alias: "化生学院",
      actorId: "boss",
    });
    expect(removed.ok).toBe(true);
    expect(removed.aliases).toEqual([]);

    const missing = await h.backend.removeAlias({
      alias: "化生学院",
      actorId: "boss",
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("没有");
  });
});

describe("管理 API P2：申诉复核", () => {
  async function seedAppeal(h: Harness): Promise<string> {
    const recordId = await seedPunishment(h);
    const submitted = await h.appeals.submit({
      punishment: h.punishments.get(recordId)!,
      userId: "u1",
      reason: "冤枉",
    });
    return submitted.appeal.appealId;
  }

  it("通过 = 撤销处罚（逐项），申诉状态变 accepted，并写审计", async () => {
    const h = harness();
    const appealId = await seedAppeal(h);

    const result = await h.backend.decideAppeal({
      code: appealId,
      decision: "accepted",
      actorId: "mod",
    });

    expect(result.decision).toBe("accepted");
    expect(result.appeal.status).toBe("accepted");
    expect(result.message).toContain("解除");
    const punishment = h.punishments.get(
      h.appeals.get(appealId)!.punishmentId,
    );
    expect(punishment?.status).toBe("released");
    expect(
      h.auditLog.all().some((row) => row.action === "admin_api:appeal_accept"),
    ).toBe(true);
  });

  it("驳回：备注默认「已驳回」，可自定义理由", async () => {
    const h = harness();
    const appealId = await seedAppeal(h);

    const result = await h.backend.decideAppeal({
      code: appealId,
      decision: "rejected",
      actorId: "mod",
      note: "证据充分，维持原处罚",
    });

    expect(result.decision).toBe("rejected");
    expect(result.appeal.status).toBe("rejected");
    expect(result.appeal.note).toContain("维持原处罚");
    expect(h.punishments.get(h.appeals.get(appealId)!.punishmentId)?.status).toBe(
      "active",
    );
  });

  it("重复处理 / 不存在 / 权限不足都明确报错", async () => {
    const h = harness();
    const appealId = await seedAppeal(h);
    await h.backend.decideAppeal({
      code: appealId,
      decision: "rejected",
      actorId: "mod",
    });

    await expect(
      h.backend.decideAppeal({ code: appealId, decision: "accepted", actorId: "mod" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    await expect(
      h.backend.decideAppeal({ code: "NOPE1", decision: "accepted", actorId: "mod" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    const fresh = await seedAppeal(h);
    await expect(
      h.backend.decideAppeal({ code: fresh, decision: "accepted", actorId: "nobody" }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
  });
});
