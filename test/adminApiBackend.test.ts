import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import { loadSettings } from "../src/config.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import {
  createAdminApiEntities,
  type AdminApiEntities,
} from "../src/adminApi/entityRef.js";
import { ActivityStatus, AuditStatus, JoinRequestStatus } from "../src/core/enums.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AuditLogStore } from "../src/services/audit.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import type { InstallerControl } from "../src/services/deployInstaller.js";

/**
 * 管理 API 的**写端点后端**（E1-d）。
 *
 * 关注点：写操作确实落到领域服务（官方接口被调 / 内存态改了）、权限判据与指令层一致、
 * 越权抛 403 且写审计、不合法输入整体拒绝（不留半套状态）。
 */

/** 超管 `boss` 在任意群都够用；`op1` 只是群 g1 的管理员。 */
function harness(options: {
  entities?: AdminApiEntities | undefined;
} = {}): {
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
    ...(options.entities !== undefined ? { entities: options.entities } : {}),
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

describe("createAdminApiBackend：展示层（群号 / QQ号 / 短码）", () => {
  /** 只读列表里「人念得出来的名字」优先：绑定号 → 短码 → 截断 id。 */
  function displayHarness(): ReturnType<typeof harness> {
    return harness({
      entities: createAdminApiEntities({
        qqOf: (userId) => ({ boss: "10001", u1: "10002" })[userId],
        groupNumberOf: (groupId) => ({ g1: "50001" })[groupId],
        shortCodeOf: (kind, targetId) =>
          kind === "join_request" && targetId === "r1" ? "ABC123" : undefined,
      }),
    });
  }

  it("待审批：群出群号、申请人出 QQ 号、申请出短码，长码留在 officialId", async () => {
    const { joinAudit, backend } = displayHarness();
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const [item] = await backend.pending();

    expect(item?.group).toEqual({
      kind: "group",
      officialId: "g1",
      label: "50001",
      externalId: "50001",
    });
    expect(item?.applicant).toEqual({
      kind: "user",
      officialId: "u1",
      label: "10002",
      externalId: "10002",
    });
    expect(item?.request).toEqual({
      kind: "request",
      officialId: "r1",
      label: "#ABC123",
      shortCode: "#ABC123",
    });
    // 原始字段仍是完整官方 id（过滤器/写端点要继续用它）
    expect(item?.groupId).toBe("g1");
    expect(item?.userId).toBe("u1");
  });

  it("审计：群 / 操作人 / 操作对象三份展示信息，绑定号优先", async () => {
    const { api, joinAudit, backend } = displayHarness();
    joinAudit.submit("g1", "u1", "想加入", "r1");
    await backend.approveJoin("r1", "boss");
    expect(api.joinRequestReviews).toHaveLength(1);

    const record = (await backend.audit()).find(
      (row) => row.action === "admin_api:approve_join",
    );

    expect(record?.group.label).toBe("50001");
    expect(record?.actor.label).toBe("10001");
    expect(record?.target?.label).toBe("10002");
    // 完整官方 id 一直是可用值（前端详情行用它）
    expect(record?.group.officialId).toBe("g1");
    expect(record?.target?.officialId).toBe("u1");
  });

  it("平台级动作（groupId 为空）：群展示信息仍给得出来，不炸", async () => {
    const { auditLog, backend } = displayHarness();
    auditLog.append({
      recordId: "a1",
      groupId: "",
      actorId: "boss",
      action: "export_audit_records",
      status: AuditStatus.Executed,
      reason: "",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    });

    const [record] = await backend.audit();

    expect(record?.group.officialId).toBe("");
    expect(record?.actor.label).toBe("10001");
    expect(record?.target).toBeUndefined();
  });

  it("规则视图带上群的展示信息", async () => {
    const { backend } = displayHarness();

    const view = await backend.rules("g1");

    expect(view.group.label).toBe("50001");
    expect(view.group.officialId).toBe("g1");
  });
});

describe("createAdminApiBackend：周期任务监测（/api/tasks）", () => {
  it("没装配调度器时返回 undefined（端点据此回 503，而不是给空列表）", () => {
    const { backend } = harness();

    expect(backend.tasks()).toBeUndefined();
  });

  it("装配后原样透传任务状态，并把部署监测的待重启一起带上", () => {
    const backend = createAdminApiBackend({
      permissions: new PermissionService({ superAdminIds: new Set(["boss"]) }),
      auditLog: new AuditLogStore(),
      joinAudit: new JoinAuditService(new AuditLogStore()),
      joinApproval: new JoinApprovalService(
        new FakeQQOfficialAPI(),
        new JoinAuditService(new AuditLogStore()),
        new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      ),
      configStore: new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      activity: new ActivityService(),
      activityExport: new ActivityExportService({ profiles: { get: () => undefined } }),
      tickTasks: () => ({
        intervalMs: 60_000,
        started: true,
        tasks: [
          {
            name: "retention",
            minIntervalMs: 86_400_000,
            runOnStart: true,
            enabled: false,
            lastRunAt: "2026-10-01T00:00:00.000Z",
            nextRunAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
      deploy: {
        pending: () => ({
          targetVersion: "0.24.0",
          currentVersion: "0.23.2",
          detectedAt: "2026-10-02T00:00:00.000Z",
          deadlineAt: "2026-10-02T00:10:00.000Z",
        }),
        cancel: () => false,
        restartNow: () => false,
      },
    });

    expect(backend.tasks()).toEqual({
      intervalMs: 60_000,
      started: true,
      tasks: [
        {
          name: "retention",
          minIntervalMs: 86_400_000,
          runOnStart: true,
          enabled: false,
          lastRunAt: "2026-10-01T00:00:00.000Z",
          nextRunAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      deploy: {
        targetVersion: "0.24.0",
        currentVersion: "0.23.2",
        detectedAt: "2026-10-02T00:00:00.000Z",
        deadlineAt: "2026-10-02T00:10:00.000Z",
      },
    });
  });
});

describe("createAdminApiBackend：配置页（/api/settings）", () => {
  function settingsHarness(): {
    backend: AdminApiBackend;
    auditLog: AuditLogStore;
    platform: PlatformSettingsStore;
  } {
    const auditLog = new AuditLogStore();
    const platform = new PlatformSettingsStore(
      loadSettings({ SCAN_INTERVAL_MS: "60000" }),
    );
    const permissions = new PermissionService({
      superAdminIds: new Set(["boss"]),
    });
    const joinAudit = new JoinAuditService(new AuditLogStore());
    const backend = createAdminApiBackend({
      permissions,
      auditLog,
      joinAudit,
      joinApproval: new JoinApprovalService(
        new FakeQQOfficialAPI(),
        joinAudit,
        new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      ),
      configStore: new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      activity: new ActivityService(),
      activityExport: new ActivityExportService({
        profiles: { get: () => undefined },
      }),
      platform,
    });
    return { backend, auditLog, platform };
  }

  it("没装配配置存储时 settings() 返回 undefined（端点回 503）", () => {
    const { backend } = harness();

    expect(backend.settings()).toBeUndefined();
  });

  it("超管改一项：立即生效、来源变 override、审计记下旧值→新值", async () => {
    const { backend, auditLog, platform } = settingsHarness();

    const item = await backend.updateSetting("scanIntervalMs", "30000", "boss");

    expect(item).toMatchObject({
      key: "scanIntervalMs",
      value: 30_000,
      source: "override",
    });
    expect(platform.get("scanIntervalMs")).toBe(30_000);
    const record = auditLog
      .all()
      .find((row) => row.action === "admin_api:setting_update");
    expect(record?.actorId).toBe("boss");
    expect(record?.groupId).toBe("");
    expect(record?.reason).toContain("60000 → 30000");
  });

  it("值不合法 / 键名不存在：回 400，不落库也不写审计", async () => {
    const { backend, auditLog, platform } = settingsHarness();

    await expect(
      backend.updateSetting("scanIntervalMs", "abc", "boss"),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    // 超出范围（扫描周期上限 3600000）
    await expect(
      backend.updateSetting("scanIntervalMs", "3600001", "boss"),
    ).rejects.toBeInstanceOf(AdminApiRequestError);
    await expect(
      backend.updateSetting("noSuchKey", "1", "boss"),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    expect(platform.get("scanIntervalMs")).toBe(60_000);
    expect(auditLog.all()).toHaveLength(0);
  });

  it("非平台超管改配置：403 且写一条拒绝审计", async () => {
    const { backend, auditLog, platform } = settingsHarness();

    await expect(
      backend.updateSetting("scanIntervalMs", "30000", "op1"),
    ).rejects.toBeInstanceOf(AdminApiRequestError);

    expect(platform.get("scanIntervalMs")).toBe(60_000);
    expect(auditLog.all().map((row) => row.action)).toContain("admin_api:denied");
  });

  it("恢复默认值：回到 .env 值、来源变 env、写审计", async () => {
    const { backend, auditLog, platform } = settingsHarness();
    await backend.updateSetting("scanIntervalMs", "30000", "boss");

    const item = await backend.clearSetting("scanIntervalMs", "boss");

    expect(item).toMatchObject({ value: 60_000, source: "env" });
    expect(platform.get("scanIntervalMs")).toBe(60_000);
    expect(auditLog.all().map((row) => row.action)).toContain(
      "admin_api:setting_clear",
    );
  });

  it("配置视图：可改项 + `.env` 只读项，密钥不回传值", async () => {
    const { backend } = settingsHarness();

    const view = backend.settings();

    expect(view?.settings.some((item) => item.key === "scanIntervalMs")).toBe(
      true,
    );
    expect(view?.env.some((item) => item.key === "EVENT_MODE")).toBe(true);
    expect(view?.env.every((item) => item.secret || item.value !== "***")).toBe(
      true,
    );
  });
});

describe("createAdminApiBackend：规则写回", () => {  it("群管理员改本群字段：覆盖生效、审计带字段名", async () => {
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
    // 没注入展示层解析器时退回「官方 id 自己当展示文本」（完整 id 仍在 officialId 里）
    expect(op1.groups).toEqual([
      {
        groupId: "g1",
        level: 130,
        group: { kind: "group", officialId: "g1", label: "g1" },
      },
    ]);

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

/** 部署回滚（ADR-0065）：同一套安装器、平台超管 240、回执写 `vX → vY`、审计留痕。 */
describe("createAdminApiBackend：部署回滚", () => {
  function installerHarness(options: {
    version?: string;
    current?: string;
    fail?: string;
  } = {}) {
    const auditLog = new AuditLogStore();
    const permissions = new PermissionService({ superAdminIds: new Set(["boss"]) });
    const rolledBack: string[] = [];
    const installer: InstallerControl = {
      rollbackTarget: () =>
        options.version === undefined
          ? undefined
          : {
              version: options.version,
              currentVersion: options.current ?? "0.28.1",
              sha256: "abc",
            },
      appliedVersion: () => options.current ?? "0.28.1",
      rollback: async () => {
        rolledBack.push(options.version ?? "");
        return options.fail !== undefined
          ? {
              ok: false,
              version: options.version ?? "",
              code: "no_package",
              message: options.fail,
            }
          : {
              ok: true,
              version: options.version ?? "",
              code: "ok",
              message: `已回滚到 v${options.version ?? ""}（v${options.current ?? "0.28.1"} → v${options.version ?? ""}），重启后生效。`,
              rolledBack: true,
            };
      },
    };
    const backend = createAdminApiBackend({
      permissions,
      auditLog,
      joinAudit: new JoinAuditService(auditLog),
      joinApproval: new JoinApprovalService(
        new FakeQQOfficialAPI(),
        new JoinAuditService(auditLog),
        new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      ),
      configStore: new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      activity: new ActivityService(),
      activityExport: new ActivityExportService({ profiles: { get: () => undefined } }),
      installer,
    });
    return { backend, auditLog, rolledBack };
  }

  it("平台超管回滚：调同一个安装器、回执写 vX → vY、审计记 Executed", async () => {
    const h = installerHarness({ version: "0.28.0" });

    const result = await h.backend.rollbackDeploy("boss");

    expect(result).toMatchObject({
      ok: true,
      fromVersion: "0.28.1",
      toVersion: "0.28.0",
    });
    expect(h.rolledBack).toEqual(["0.28.0"]);
    const records = h.auditLog.all();
    expect(records.at(-1)?.action).toBe("admin_api:deploy_rollback");
    expect(records.at(-1)?.status).toBe(AuditStatus.Executed);
    expect(records.at(-1)?.reason).toContain("v0.28.1 → v0.28.0");
  });

  it("非平台超管：403 + 拒绝审计，安装器一次都没被调", async () => {
    const h = installerHarness({ version: "0.28.0" });

    await expect(h.backend.rollbackDeploy("op1")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.rolledBack).toEqual([]);
    expect(h.auditLog.all().at(-1)?.action).toBe("admin_api:denied");
  });

  it("没得回滚 / 回滚失败：ok=false 如实回原因（不是 500）", async () => {
    const none = installerHarness();
    await expect(none.backend.rollbackDeploy("boss")).resolves.toMatchObject({
      ok: false,
      toVersion: "",
    });
    expect(none.auditLog.all().at(-1)?.status).toBe(AuditStatus.Rejected);

    const failing = installerHarness({ version: "0.28.0", fail: "归档里找不到 v0.28.0 的包。" });
    await expect(failing.backend.rollbackDeploy("boss")).resolves.toMatchObject({
      ok: false,
      message: "归档里找不到 v0.28.0 的包。",
    });
    expect(failing.auditLog.all().at(-1)?.status).toBe(AuditStatus.Rejected);
  });

  it("只读巡检模式（没装配安装器）：503，不假装成功", async () => {
    const auditLog = new AuditLogStore();
    const backend = createAdminApiBackend({
      permissions: new PermissionService({ superAdminIds: new Set(["boss"]) }),
      auditLog,
      joinAudit: new JoinAuditService(auditLog),
      joinApproval: new JoinApprovalService(
        new FakeQQOfficialAPI(),
        new JoinAuditService(auditLog),
        new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      ),
      configStore: new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      activity: new ActivityService(),
      activityExport: new ActivityExportService({ profiles: { get: () => undefined } }),
    });

    await expect(backend.rollbackDeploy("boss")).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("health 视图带上部署状态（当前生效 + 可回滚版本）", async () => {
    const h = installerHarness({ version: "0.28.0", current: "0.28.1" });
    const view = await h.backend.health();
    expect(view.deploy).toEqual({
      appliedVersion: "0.28.1",
      rollbackVersion: "0.28.0",
    });

    // 没得回滚时只给当前版本（界面据此隐藏按钮）
    const none = installerHarness({ current: "0.28.1" });
    expect((await none.backend.health()).deploy).toEqual({ appliedVersion: "0.28.1" });
  });
});
