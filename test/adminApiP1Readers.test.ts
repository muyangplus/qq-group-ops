import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import { createAdminApiEntities } from "../src/adminApi/entityRef.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { loadSettings } from "../src/config.js";
import { AuditStatus } from "../src/core/enums.js";
import type { NotificationDeliveryRepository } from "../src/db/notificationRepository.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AppealService } from "../src/services/appeals.js";
import { AuditLogStore } from "../src/services/audit.js";
import { BlacklistService } from "../src/services/blacklist.js";
import { ExportService } from "../src/services/export.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { HealthRegistry } from "../src/services/health.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import { PermissionService } from "../src/services/permissions.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import { PunishmentService } from "../src/services/punishments.js";
import { UserProfileService } from "../src/services/userProfiles.js";

/**
 * 管理后台 **P1 只读补齐**（处罚 / 黑名单 / 申诉 / 投递 / 运维 / 同步 / 审计导出）。
 *
 * 关注点：口径与指令层一致（门槛、排序、字段含义）、长码只出现在 `officialId`（展示走 `label`）、
 * 学号默认脱敏、以及「没有数据源时回 503 语义」而不是假装成空列表。
 */
interface Harness {
  backend: AdminApiBackend;
  api: FakeQQOfficialAPI;
  auditLog: AuditLogStore;
  joinAudit: JoinAuditService;
  punishments: PunishmentService;
  blacklist: BlacklistService;
  appeals: AppealService;
  profiles: UserProfileService;
  exportService: ExportService;
  writeQueue: WriteQueue;
  health: HealthRegistry;
  deliveries: NotificationDeliveryRepository;
  permissions: PermissionService;
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
  const blacklist = new BlacklistService(api, { auditLog });
  const punishments = new PunishmentService(api, blacklist, { auditLog });
  const appeals = new AppealService();
  const profiles = new UserProfileService();
  const exportService = new ExportService(permissions, auditLog);
  const health = new HealthRegistry([]);
  const rows: Array<{
    groupId: string;
    requestId: string;
    userId: string;
    status: string;
    detail: string;
    createdAt: Date;
  }> = [];
  const deliveries: NotificationDeliveryRepository = {
    async findAll() {
      return [...rows];
    },
    async save(delivery) {
      rows.push({ ...delivery });
    },
    async deleteOlderThan() {
      // 测试里不需要清理
    },
  };
  rows.push({
    groupId: "g1",
    requestId: "n1",
    userId: "u1",
    status: "sent",
    detail: "",
    createdAt: new Date("2026-10-02T01:00:00.000Z"),
  });
  rows.push({
    groupId: "g1",
    requestId: "n2",
    userId: "u2",
    status: "failed",
    detail: "rate limited",
    createdAt: new Date("2026-10-02T02:00:00.000Z"),
  });
  rows.push({
    groupId: "g2",
    requestId: "n3",
    userId: "u3",
    status: "sent",
    detail: "text_fallback",
    createdAt: new Date("2026-10-02T03:00:00.000Z"),
  });
  const backend = createAdminApiBackend({
    permissions,
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({
      profiles: { get: (userId) => profiles.get(userId) },
    }),
    database: "sqlite",
    platform: new PlatformSettingsStore(
      loadSettings({ APPEAL_HOLD_MINUTES: "15" }),
    ),
    entities: createAdminApiEntities({
      qqOf: (userId) => ({ u1: "10001", u2: "10002", mod: "10003" })[userId],
      groupNumberOf: (groupId) => ({ g1: "50001", g2: "50002" })[groupId],
    }),
    punishments,
    blacklist,
    appeals,
    userProfiles: profiles,
    notificationDeliveries: deliveries,
    health: () => health,
    writeQueue,
    exportService,
    mode: "fake",
  });
  return {
    backend,
    api,
    auditLog,
    joinAudit,
    punishments,
    blacklist,
    appeals,
    profiles,
    exportService,
    writeQueue,
    health,
    deliveries,
    permissions,
  };
}

/** 建一条处罚记录（走领域服务，保证字段与真机一致）。 */
async function seedPunishment(
  h: Harness,
  input: { groupId?: string; userId?: string; muted?: boolean } = {},
): Promise<string> {
  const record = await h.punishments.create({
    groupId: input.groupId ?? "g1",
    userId: input.userId ?? "u1",
    actorId: "mod",
    source: "manual",
    ruleReason: "广告",
    messageId: "m1",
    messageExcerpt: "加群发广告",
    actions: {
      recalled: true,
      muted: input.muted ?? true,
      muteDurationSeconds: 600,
      kicked: false,
      blacklist: "",
    },
  });
  // `detail` 是执行结果，由 `markExecuted` 写入（创建时不收这个字段）
  await h.punishments.markExecuted(record.recordId, "recall+mute");
  return record.recordId;
}

describe("管理 API P1：处罚记录（只读）", () => {
  it("带展示信息与短码，动作摘要用指令层同一套用词", async () => {
    const h = harness();
    const recordId = await seedPunishment(h);

    const items = await h.backend.punishments({ group: "g1" });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      recordId,
      code: `#${recordId}`,
      groupId: "g1",
      source: "manual",
      ruleReason: "广告",
      messageExcerpt: "加群发广告",
      actions: "撤回消息 + 禁言 600 秒",
      detail: "recall+mute",
      status: "active",
    });
    expect(items[0]?.target.label).toBe("10001");
    expect(items[0]?.actor.label).toBe("10003");
    expect(items[0]?.group.label).toBe("50001");
  });

  it("按群过滤、按状态过滤；平台视图（不传 group）能拿到跨群记录", async () => {
    const h = harness();
    await seedPunishment(h, { groupId: "g1" });
    const otherId = await seedPunishment(h, { groupId: "g2", userId: "u2" });
    await h.punishments.release({
      code: otherId,
      actorId: "mod",
      note: "申诉通过",
    });

    expect(await h.backend.punishments({ group: "g1" })).toHaveLength(1);
    expect(await h.backend.punishments({})).toHaveLength(2);
    expect(await h.backend.punishments({ status: "released" })).toHaveLength(1);
    expect(await h.backend.punishments({ status: "active" })).toHaveLength(1);
  });

  it("没装配处罚服务：明确抛「未装配」而不是回空列表", async () => {
    const h = harness();
    const bare = createAdminApiBackend({
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
      activityExport: new ActivityExportService({ profiles: { get: () => undefined } }),
    });

    await expect(bare.punishments({ group: "g1" })).rejects.toBeInstanceOf(
      AdminApiRequestError,
    );
  });
});

describe("管理 API P1：黑名单（只读）", () => {
  it("本群与全局分组返回；非平台超管拿不到全局那组（globalVisible=false）", async () => {
    const h = harness();
    await h.blacklist.add({
      scope: "group",
      groupId: "g1",
      userId: "u1",
      reason: "广告",
      actorId: "mod",
      source: "manual",
    });
    await h.blacklist.add({
      scope: "global",
      groupId: "",
      userId: "u2",
      reason: "屡犯",
      actorId: "mod",
      source: "manual",
    });

    const forMod = await h.backend.blacklist("g1", { includeGlobal: false });
    expect(forMod.entries.map((entry) => entry.user.label)).toEqual(["10001"]);
    expect(forMod.globalEntries).toEqual([]);
    expect(forMod.globalVisible).toBe(false);

    const forBoss = await h.backend.blacklist("g1", { includeGlobal: true });
    expect(forBoss.globalVisible).toBe(true);
    expect(forBoss.globalEntries.map((entry) => entry.user.label)).toEqual([
      "10002",
    ]);
    expect(forBoss.globalEntries[0]?.group).toBeUndefined();
    expect(forBoss.entries[0]?.scope).toBe("group");
  });
});

describe("管理 API P1：申诉（只读）", () => {
  it("带剩余时限与超时标记；处理人/申诉人都有展示信息", async () => {
    const h = harness();
    const punishmentId = await seedPunishment(h);
    const submitted = await h.appeals.submit({
      punishment: h.punishments.get(punishmentId)!,
      userId: "u1",
      reason: "手滑了",
    });
    expect(submitted.updated).toBe(false);

    const view = await h.backend.appeals({ group: "g1" });

    expect(view.holdMinutes).toBe(15);
    expect(view.pendingCount).toBe(1);
    expect(view.items[0]).toMatchObject({
      punishmentId,
      punishmentCode: `#${punishmentId}`,
      status: "pending",
      reason: "手滑了",
      overdue: false,
    });
    expect(view.items[0]?.appellant.label).toBe("10001");
    expect(view.items[0]?.holdRemainingMinutes).toBeLessThanOrEqual(15);
    expect(view.items[0]?.reviewer).toBeUndefined();
  });
});

describe("管理 API P1：通知投递（只读）", () => {
  it("按时间倒序、可按群与状态过滤，并带上收件人展示信息", async () => {
    const h = harness();

    const all = await h.backend.deliveries({});
    expect(all.map((item) => item.requestId)).toEqual(["n3", "n2", "n1"]);
    expect(all[0]?.recipient.officialId).toBe("u3");

    const g1 = await h.backend.deliveries({ group: "g1" });
    expect(g1.map((item) => item.requestId)).toEqual(["n2", "n1"]);

    const failed = await h.backend.deliveries({ status: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toBe("rate limited");
  });
});

describe("管理 API P1：运维只读（/api/health）", () => {
  it("进程 / 队列 / 模块 / 恢复现场都给得出来", async () => {
    const h = harness();

    const view = await h.backend.health();

    expect(view.process.mode).toBe("fake");
    expect(view.process.runningVersion).toBeTruthy();
    expect(view.process.pid).toBe(process.pid);
    expect(view.database.driver).toBe("sqlite");
    expect(view.queue).toEqual({ pending: 0, failures: 0 });
    expect(view.notify).toEqual({ subscribers: 0, deliveries: 0 });
    expect(view.modules).toEqual([]);
    // 本机没有 data/dist-broken 与 data/restart-failed.json → 干净状态
    expect(view.restart.brokenBuild).toBe(false);
    expect(view.restart.failure).toBeUndefined();
  });

  it("写队列的失败数与最近错误会被带出来", async () => {
    const h = harness();
    await h.writeQueue.enqueue("demo", async () => {
      throw new Error("boom");
    });
    await h.writeQueue.flush();

    const view = await h.backend.health();

    expect(view.queue.failures).toBe(1);
    expect(view.queue.lastError).toContain("boom");
  });
});

describe("管理 API P1：申请队列同步（写但幂等）", () => {
  function syncHarness(): ReturnType<typeof harness> {
    const h = harness();
    // 用带同步服务的后端替换（与运行时同一装配方式）
    const joinSync = new JoinRequestSyncService(h.api, h.joinAudit, {
      minIntervalMs: 0,
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
      joinSync,
    });
    return { ...h, backend };
  }

  it("审核员 120 就能同步；重复同步不产生重复申请，且写审计", async () => {
    const h = syncHarness();
    h.api.addJoinRequest("g1", "u1", "想加入", "r1");
    h.api.addJoinRequest("g2", "u2", "别的群", "r2");

    const first = await h.backend.syncJoinRequests("g1", "mod");
    const second = await h.backend.syncJoinRequests("g1", "mod");

    expect(first).toMatchObject({ fetched: 1, pending: 1 });
    expect(second.pending).toBe(1);
    expect(h.joinAudit.pending("g1")).toHaveLength(1);
    expect(
      h.auditLog.all().filter((row) => row.action === "admin_api:join_sync"),
    ).toHaveLength(2);
  });

  it("不够 120（普通成员）会被拒并写一条拒绝审计", async () => {
    const h = syncHarness();

    await expect(
      h.backend.syncJoinRequests("g1", "nobody"),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    expect(h.auditLog.all().map((row) => row.action)).toContain(
      "admin_api:denied",
    );
  });
});

describe("管理 API P1：审计导出（CSV）", () => {
  it("本群 130 可导出（默认脱敏），并写两条审计（领域层 + 管理面）", async () => {
    const h = harness();
    h.auditLog.append({
      recordId: "a1",
      groupId: "g1",
      actorId: "u1",
      action: "moderation:warn",
      status: AuditStatus.Executed,
      reason: "广告",
      targetUserId: "u2",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    });

    const result = await h.backend.exportAuditCsv("admin", {
      group: "g1",
      full: false,
    });

    expect(result.filename).toBe("audit-g1.csv");
    expect(result.rows).toBe(1);
    expect(result.csv).toContain("record_id");
    // 默认脱敏：actor / target 的 openid 打码（CSV 里不该出现完整值）
    expect(result.csv).not.toContain("u1");
    expect(result.csv).not.toContain("u2");
    const actions = h.auditLog.all().map((row) => row.action);
    expect(actions).toContain("export_audit_records");
    expect(actions).toContain("admin_api:audit_export");
  });

  it("完整导出要平台超管；全量（不带 group）也要平台超管", async () => {
    const h = harness();

    await expect(
      h.backend.exportAuditCsv("admin", { group: "g1", full: true }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    await expect(
      h.backend.exportAuditCsv("mod", { full: false }),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    const all = await h.backend.exportAuditCsv("boss", { full: true });
    expect(all.filename).toBe("audit-all.csv");
  });
});
