import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import { ActivityStatus, JoinRequestStatus } from "../src/core/enums.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AuditLogStore } from "../src/services/audit.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";

/**
 * 管理 API 的**写端点后端**（E1-d）。
 *
 * 关注点：写操作确实落到领域服务（官方接口被调 / 内存态改了）、权限判据与指令层一致、
 * 越权抛 403 且写审计、不合法输入整体拒绝（不留半套状态）。
 */

/** 超管 `boss` 在任意群都够用；`op1` 只是群 g1 的管理员。 */
function harness(): {
  api: FakeQQOfficialAPI;
  auditLog: AuditLogStore;
  joinAudit: JoinAuditService;
  configStore: GroupConfigStore;
  activity: ActivityService;
  permissions: PermissionService;
  backend: AdminApiBackend;
} {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const joinApproval = new JoinApprovalService(api, joinAudit, configStore);
  const activity = new ActivityService();
  const permissions = new PermissionService({
    superAdminIds: new Set(["boss"]),
  });
  permissions.grantGroupAdmin("g1", "op1");
  const profiles = new Map([
    [
      "u1",
      {
        userId: "u1",
        name: "小明",
        studentId: "1234",
        className: "计科1班",
        college: "计算机学院",
        year: "22",
      },
    ],
  ]);
  const activityExport = new ActivityExportService({
    profiles: { get: (userId: string) => profiles.get(userId) },
  });
  const backend = createAdminApiBackend({
    permissions,
    auditLog,
    joinAudit,
    joinApproval,
    configStore,
    activity,
    activityExport,
    database: "memory",
  });
  return { api, auditLog, joinAudit, configStore, activity, permissions, backend };
}

describe("createAdminApiBackend：入群审批", () => {
  it("超管通过：先调官方接口、再落本地状态，两条审计都留痕", async () => {
    const { api, auditLog, joinAudit, backend } = harness();
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const result = await backend.approveJoin("r1", "boss");

    expect(result.status).toBe(JoinRequestStatus.Approved);
    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
    const actions = auditLog.all().map((record) => record.action);
    // 领域层一条（joinAudit）+ 管理 API 一条（来源=管理后台）
    expect(actions).toContain("approve_join_request");
    expect(actions).toContain("admin_api:approve_join");
    const apiRecord = auditLog
      .all()
      .find((record) => record.action === "admin_api:approve_join");
    expect(apiRecord?.actorId).toBe("boss");
    expect(apiRecord?.groupId).toBe("g1");
  });

  it("拒绝：理由传给官方接口，也进审计", async () => {
    const { api, auditLog, joinAudit, backend } = harness();
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const result = await backend.rejectJoin("r1", "boss", "资料不完整");

    expect(result.status).toBe(JoinRequestStatus.Rejected);
    expect(api.joinRequestReviews[0]?.reason).toBe("资料不完整");
    expect(
      auditLog.all().find((record) => record.action === "admin_api:reject_join")
        ?.reason,
    ).toContain("理由=资料不完整");
  });

  it("群管理员只能审自己的群，别人的群 403 且写拒绝审计、状态不变", async () => {
    const { api, auditLog, joinAudit, backend } = harness();
    joinAudit.submit("g2", "u2", "想加入", "r2");

    await expect(backend.approveJoin("r2", "op1")).rejects.toMatchObject({
      name: "AdminApiRequestError",
      statusCode: 403,
    });
    expect(api.joinRequestReviews).toEqual([]);
    expect(joinAudit.get("r2").status).toBe(JoinRequestStatus.Pending);
    expect(auditLog.all().at(-1)?.action).toBe("admin_api:denied");
  });

  it("不存在 → 404；已经被处理过 → 409", async () => {
    const { joinAudit, backend } = harness();
    await expect(backend.approveJoin("nope", "boss")).rejects.toMatchObject({
      statusCode: 404,
    });

    joinAudit.submit("g1", "u1", "想加入", "r1");
    await backend.approveJoin("r1", "boss");
    await expect(backend.rejectJoin("r1", "boss", "反悔")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("待审批列表跨群汇总（老队列在前）", async () => {
    const { joinAudit, backend } = harness();
    joinAudit.submit("g1", "u1", "想加入", "r1");
    joinAudit.submit("g2", "u2", "也想加入", "r2");

    const pending = await backend.pending();

    expect(pending.map((item) => item.requestId)).toEqual(["r1", "r2"]);
    expect(pending[0]?.groupId).toBe("g1");
  });
});

describe("createAdminApiBackend：规则写回", () => {
  it("群管理员改本群字段：覆盖生效、审计带字段名", async () => {
    const { auditLog, configStore, backend } = harness();

    const result = await backend.updateRule("g1", "warning", "本群新文案", "op1");

    expect(result.fields).toContain("warningMessage");
    expect(configStore.get("g1").warningMessage).toBe("本群新文案");
    // 没改的字段仍然继承全局默认
    expect(configStore.get("g1").enabled).toBe(configStore.default.enabled);
    expect(auditLog.all().at(-1)).toMatchObject({
      action: "admin_api:rule_update",
      groupId: "g1",
      actorId: "op1",
      status: "executed",
    });
  });

  it("非法值整体拒绝：400 + 拒绝审计，配置一动不动", async () => {
    const { auditLog, configStore, backend } = harness();
    const before = configStore.get("g1");

    await expect(
      backend.updateRule("g1", "mute", "不是数字", "op1"),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(configStore.get("g1")).toEqual(before);
    expect(auditLog.all().at(-1)?.status).toBe("rejected");
  });

  it("全局规则（__default__）只有平台超管能改", async () => {
    const { configStore, backend } = harness();

    await expect(
      backend.updateRule(DEFAULT_GROUP_ID, "warning", "全局文案", "op1"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(configStore.default.warningMessage).not.toBe("全局文案");

    const result = await backend.updateRule(
      DEFAULT_GROUP_ID,
      "warning",
      "全局文案",
      "boss",
    );
    expect(result.locale).toBe("global");
    expect(configStore.default.warningMessage).toBe("全局文案");
  });

  it("读规则视图：覆盖字段 + 合并后的生效配置", async () => {
    const { configStore, backend } = harness();
    await backend.updateRule("g1", "keywords", "刷屏,广告", "op1");

    const view = await backend.rules("g1");

    expect(view.override).toMatchObject({ groupId: "g1" });
    expect(view.effective?.["keywords"]).toEqual(["刷屏", "广告"]);
    // 没有覆盖的群：override 为 null，但仍然给得出生效配置
    const bare = await backend.rules("g2");
    expect(bare.override).toBeNull();
    expect(bare.effective?.["groupId"]).toBe("g2");
    expect(configStore.get("g2").keywords).toEqual(configStore.default.keywords);
  });
});

describe("createAdminApiBackend：活动与导出", () => {
  it("活动状态按 open / close / cancel 切换并写审计", async () => {
    const { auditLog, activity, backend } = harness();
    activity.createActivity({
      groupId: "g1",
      title: "周末活动",
      createdBy: "boss",
      activityId: "a1",
    });
    const code = activity.getActivity("a1").code;

    expect((await backend.setActivityStatus(code, "open", "boss")).status).toBe(
      ActivityStatus.Open,
    );
    expect(activity.getActivity("a1").status).toBe(ActivityStatus.Open);

    await backend.setActivityStatus(code, "close", "boss");
    await backend.setActivityStatus(code, "cancel", "boss");
    expect(activity.getActivity("a1").status).toBe(ActivityStatus.Cancelled);

    const actions = auditLog
      .all()
      .map((record) => record.action)
      .filter((action) => action.startsWith("admin_api:activity"));
    expect(actions).toEqual([
      "admin_api:activity_open",
      "admin_api:activity_close",
      "admin_api:activity_cancel",
    ]);
  });

  it("活动不存在 / 没有权限：404 与 403", async () => {
    const { activity, backend } = harness();
    activity.createActivity({
      groupId: "g1",
      title: "周末活动",
      createdBy: "boss",
      activityId: "a1",
    });
    const code = activity.getActivity("a1").code;

    await expect(
      backend.setActivityStatus("NOSUCH", "open", "boss"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      backend.setActivityStatus(code, "open", "someone-else"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(activity.getActivity("a1").status).toBe(ActivityStatus.Draft);
  });

  it("名单 CSV：默认脱敏，full=1 才带学号等隐私列（两种都写审计）", async () => {
    const { auditLog, activity, backend } = harness();
    activity.createActivity({
      groupId: "g1",
      title: "周末活动",
      createdBy: "boss",
      activityId: "a1",
    });
    const code = activity.getActivity("a1").code;
    activity.openActivity("a1");
    activity.register({ activityId: "a1", userId: "u1", displayName: "小明" });

    const masked = await backend.exportActivityCsv(code, "op1", { full: false });
    expect(masked.rows).toBe(1);
    expect(masked.filename).toBe(`activity-${code}.csv`);
    expect(masked.csv).toContain("序号,姓名,学号,班级,学院,备注,候补");
    expect(masked.csv).toContain("小明");
    expect(masked.csv).not.toContain("1234");

    const full = await backend.exportActivityCsv(code, "op1", { full: true });
    expect(full.csv).toContain("1234");
    expect(full.csv).toContain("计科1班");

    const reasons = auditLog
      .all()
      .filter((record) => record.action === "admin_api:activity_export")
      .map((record) => record.reason);
    expect(reasons).toEqual([
      "活动=" + code + " 行=1 含隐私=否",
      "活动=" + code + " 行=1 含隐私=是",
    ]);
  });
});

describe("createAdminApiBackend：权限画像与状态", () => {
  it("permissionsOf 复用 describePermissions（只列能真正干事的群）", async () => {
    const { configStore, backend } = harness();
    configStore.setOverride({ groupId: "g9", enabled: true });

    const boss = await backend.permissionsOf("boss");
    expect(boss.platformLevel).toBe(240);
    expect(boss.groups.map((group) => group.groupId)).toEqual(["g1", "g9"]);

    const op1 = await backend.permissionsOf("op1");
    expect(op1.platformLevel).toBe(0);
    expect(op1.groups).toEqual([{ groupId: "g1", level: 130 }]);

    const stranger = await backend.permissionsOf("nobody");
    expect(stranger.groups).toEqual([]);
  });

  it("status 汇总数据库类型、迁移问题与未用令牌数", async () => {
    const { backend } = harness();

    await expect(backend.status()).resolves.toEqual({
      database: "memory",
      migrationIssues: 0,
      activeTokens: 0,
    });
  });

  it("错误类型可被 HTTP 层识别", async () => {
    const { backend } = harness();
    await expect(backend.approveJoin("nope", "boss")).rejects.toBeInstanceOf(
      AdminApiRequestError,
    );
  });
});
