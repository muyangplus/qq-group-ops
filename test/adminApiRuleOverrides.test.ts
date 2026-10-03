import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { AuditStatus } from "../src/core/enums.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";

/**
 * 管理后台的**规则面**收尾（收尾批次 E）：
 * - 覆盖率总览（`GET /api/rules/overrides`，240）：哪些群覆盖了哪些字段，
 *   与机器人 `/rules overrides` 同一数据源（`listOverrideSummaries()`）；
 * - 一次改多项（`PUT /api/rules { group, updates }`）：**先全部解析、再落库** ——
 *   任一项不合法就整体 400、不写半套；回执带逐字段 diff（生效值的 旧值 → 新值）。
 */
interface Harness {
  backend: AdminApiBackend;
  auditLog: AuditLogStore;
  configStore: GroupConfigStore;
}

function harness(): Harness {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const permissions = new PermissionService({ superAdminIds: new Set(["boss"]) });
  permissions.grantGroupAdmin("g1", "admin");
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
    mode: "fake",
  });
  return { backend, auditLog, configStore };
}

function audits(auditLog: AuditLogStore, action: string) {
  return auditLog.all().filter((item) => item.action === action);
}

describe("管理 API 规则覆盖率总览（只读，240）", () => {
  it("按群列出覆盖字段与展示名；全局默认不算「覆盖」", async () => {
    const h = harness();
    h.configStore.setOverride({ groupId: "g2", autoApproveJoin: true });
    h.configStore.setOverride({ groupId: "g1", keywords: ["刷屏"] });
    // 全局默认（`__default__`）是基线，不是「某个群的覆盖」——它不该出现在这份列表里
    h.configStore.setOverride({ groupId: DEFAULT_GROUP_ID, warningMessage: "全局" });

    const view = await h.backend.ruleOverrides();

    expect(view.totalGroups).toBe(2);
    expect(view.totalFields).toBe(2);
    expect(view.items.map((item) => item.groupId)).toEqual(["g1", "g2"]);
    expect(view.items[0]).toMatchObject({
      groupId: "g1",
      fields: ["keywords"],
      fieldCount: 1,
    });
    // 展示名与机器人卡片同一套（`ruleFieldLabel`）
    expect(view.items[0]?.labels.join("、")).toContain("关键词");
    expect(view.items[0]?.group.officialId).toBe("g1");
    expect(view.items[1]).toMatchObject({ fields: ["autoApproveJoin"] });
  });
});

describe("管理 API 一次改多项（先全解析、再落库，回执带 diff）", () => {
  it("两项一起改：都生效、diff 用生效值、审计记逐字段变化", async () => {
    const h = harness();
    h.configStore.setOverride({ groupId: "g1", warningMessage: "旧文案" });

    const result = await h.backend.updateRules({
      group: "g1",
      updates: [
        { field: "warning", value: "新文案" },
        { field: "keywords", value: "刷屏,广告" },
      ],
      actorId: "admin",
    });

    expect(result).toMatchObject({ groupId: "g1", locale: "group" });
    expect(result.fields.sort()).toEqual(["keywords", "warningMessage"]);
    const warning = result.changes.find((item) => item.field === "warningMessage");
    expect(warning).toMatchObject({ before: "旧文案", after: "新文案" });
    const keywords = result.changes.find((item) => item.field === "keywords");
    expect(keywords?.after).toContain("刷屏");
    // 真的落库了（生效值）
    expect(h.configStore.get("g1").warningMessage).toBe("新文案");
    expect(h.configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);
    const audit = audits(h.auditLog, "admin_api:rule_update");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe(AuditStatus.Executed);
    expect(audit[0]?.reason).toContain("旧文案 → 新文案");
  });

  it("任一项不合法：整体 400，**一项都不落库**，审计记 rejected", async () => {
    const h = harness();

    const error = await h.backend
      .updateRules({
        group: "g1",
        updates: [
          { field: "warning", value: "合法值" },
          { field: "notAField", value: "x" },
        ],
        actorId: "admin",
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AdminApiRequestError);
    expect((error as AdminApiRequestError).statusCode).toBe(400);
    expect((error as AdminApiRequestError).message).toContain("规则值不合法");
    // 前半项也不能写进去（先全部解析、再落库）
    expect(h.configStore.get("g1").warningMessage).not.toBe("合法值");
    const audit = audits(h.auditLog, "admin_api:rule_update");
    expect(audit[0]?.status).toBe(AuditStatus.Rejected);
  });

  it("项数上限 20；空清单 400；非本群群管理员 403；单字段形状仍走同一条路", async () => {
    const h = harness();

    const tooMany = await h.backend
      .updateRules({
        group: "g1",
        updates: Array.from({ length: 21 }, (_value, index) => ({
          field: `field${index}`,
          value: "x",
        })),
        actorId: "admin",
      })
      .catch((thrown: unknown) => thrown);
    expect((tooMany as AdminApiRequestError).statusCode).toBe(400);
    expect((tooMany as AdminApiRequestError).message).toContain("最多改 20 项");

    const empty = await h.backend
      .updateRules({ group: "g1", updates: [], actorId: "admin" })
      .catch((thrown: unknown) => thrown);
    expect((empty as AdminApiRequestError).statusCode).toBe(400);

    const denied = await h.backend
      .updateRules({
        group: "g1",
        updates: [{ field: "warning", value: "越权" }],
        actorId: "nobody",
      })
      .catch((thrown: unknown) => thrown);
    expect((denied as AdminApiRequestError).statusCode).toBe(403);

    // 单字段端点（`updateRule`）就是批量传一项：回执里也有 changes
    const single = await h.backend.updateRule("g1", "warning", "单字段", "admin");
    expect(single.changes).toHaveLength(1);
    expect(single.changes[0]?.after).toBe("单字段");
  });

  it("全局规则（__default__）只有平台超管能改", async () => {
    const h = harness();

    const denied = await h.backend
      .updateRules({
        group: DEFAULT_GROUP_ID,
        updates: [{ field: "warning", value: "全局" }],
        actorId: "admin",
      })
      .catch((thrown: unknown) => thrown);
    expect((denied as AdminApiRequestError).statusCode).toBe(403);

    const ok = await h.backend.updateRules({
      group: DEFAULT_GROUP_ID,
      updates: [{ field: "warning", value: "全局新文案" }],
      actorId: "boss",
    });
    expect(ok).toMatchObject({ locale: "global" });
    expect(h.configStore.default.warningMessage).toBe("全局新文案");
  });
});
