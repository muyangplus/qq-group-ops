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
import { HealthRegistry } from "../src/services/health.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";

/**
 * 管理后台的**运维写**：降级模块「重试加载」（平台超管 240）。
 *
 * 口径：与机器人 `/status proc` 的「重试加载」按钮**同一个领域入口**（`HealthRegistry.retry`）——
 * 幂等、只重跑该模块的 `load()`、不动业务数据、不重启进程。
 * 「仍然起不来」是**结果**而不是 HTTP 错误（200 + `recovered: false` + 原话原因），
 * 两种结局都写 `admin_api:module_retry` 审计（成功 `executed` / 仍失败 `rejected`）。
 */
interface Harness {
  backend: AdminApiBackend;
  auditLog: AuditLogStore;
  health: HealthRegistry;
  /** 模拟「把数据 / 环境修好了」：下次 `load()` 就会成功。 */
  setHealthy: (value: boolean) => void;
}

function harness(options: { withHealth?: boolean } = {}): Harness {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const permissions = new PermissionService({ superAdminIds: new Set(["boss"]) });
  let healthy = false;
  const health = new HealthRegistry([
    {
      key: "config",
      load: async () => {
        if (!healthy) {
          throw new Error("bad row");
        }
      },
    },
  ]);
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
    ...(options.withHealth === false ? {} : { health: () => health }),
    mode: "fake",
  });
  return {
    backend,
    auditLog,
    health,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
  };
}

/** 取最后一条某动作的审计（断言用）。 */
function lastAudit(
  auditLog: AuditLogStore,
  action: string,
): { status: string; reason: string } | undefined {
  const record = [...auditLog.all()]
    .reverse()
    .find((item) => item.action === action);
  return record === undefined
    ? undefined
    : { status: record.status, reason: record.reason ?? "" };
}

describe("管理 API 运维写：降级模块重试加载", () => {
  it("只有平台超管能重试（非超管 403 + 拒绝审计）", async () => {
    const h = harness();
    await h.health.loadAll();

    const error = await h.backend
      .retryModule("config", "mod")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AdminApiRequestError);
    expect((error as AdminApiRequestError).statusCode).toBe(403);
    expect(lastAudit(h.auditLog, "admin_api:denied")?.reason).toContain("240");
    // 被拒时**不能**真去重试（模块仍是降级态）
    expect(h.health.isAvailable("config")).toBe(false);
  });

  it("仍然起不来时如实回原因（ok=false 的结果，不是 HTTP 错误）+ rejected 审计", async () => {
    const h = harness();
    await h.health.loadAll();

    const result = await h.backend.retryModule("config", "boss");

    expect(result.recovered).toBe(false);
    expect(result.module).toMatchObject({ key: "config", label: "群规则", state: "degraded" });
    expect(result.module.error).toContain("bad row");
    expect(result.message).toContain("bad row");
    const audit = lastAudit(h.auditLog, "admin_api:module_retry");
    expect(audit?.status).toBe(AuditStatus.Rejected);
    expect(audit?.reason).toContain("→ degraded");
    expect(audit?.reason).toContain("bad row");
  });

  it("修好数据后再点一次就恢复（幂等，不用重启进程）+ executed 审计", async () => {
    const h = harness();
    await h.health.loadAll();
    expect(h.health.isAvailable("config")).toBe(false);

    h.setHealthy(true);
    const first = await h.backend.retryModule("config", "boss");
    expect(first.recovered).toBe(true);
    expect(first.module.state).toBe("ready");
    expect(first.message).toContain("已重新加载成功");
    expect(h.health.isAvailable("config")).toBe(true);
    const audit = lastAudit(h.auditLog, "admin_api:module_retry");
    expect(audit?.status).toBe(AuditStatus.Executed);
    expect(audit?.reason).toContain("→ ready");

    // 已经恢复的模块再重试一次：仍然成功、不产生第二套状态（幂等）
    const second = await h.backend.retryModule("config", "boss");
    expect(second.recovered).toBe(true);
    expect(second.module.state).toBe("ready");
  });

  it("未知模块 400、健康注册表未装配 503", async () => {
    const h = harness();
    await h.health.loadAll();

    const unknown = await h.backend
      .retryModule("nope", "boss")
      .catch((thrown: unknown) => thrown);
    expect((unknown as AdminApiRequestError).statusCode).toBe(400);
    expect((unknown as AdminApiRequestError).message).toContain("未知模块");

    const bare = harness({ withHealth: false });
    const unavailable = await bare.backend
      .retryModule("config", "boss")
      .catch((thrown: unknown) => thrown);
    expect((unavailable as AdminApiRequestError).statusCode).toBe(503);
    expect((unavailable as AdminApiRequestError).errorCode).toBe("unavailable");
  });
});
