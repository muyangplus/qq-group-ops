import { describe, expect, it, beforeEach } from "vitest";

import { JoinRequestStatus } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";

describe("AdminCommandService", () => {
  let auditLog: InMemoryAuditLog;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let service: AdminCommandService;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    joinAudit = new JoinAuditService(auditLog);
    configStore = new GroupConfigStore({
      groupId: "__default__",
      keywords: ["广告"],
    });
    service = new AdminCommandService(permissions, joinAudit, configStore);
  });

  it("shows help", () => {
    const result = service.handle("g1", "member", "/help");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("可用指令");
  });

  it("rejects unknown commands", () => {
    const result = service.handle("g1", "member", "/unknown");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知指令");
  });

  it("requires permission for pending", () => {
    const result = service.handle("g1", "member", "/pending");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("lists pending requests for the group", () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    joinAudit.submit("g2", "u2", "其他群", "r2");
    const result = service.handle("g1", "mod", "/pending");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
    expect(result.text).not.toContain("r2");
  });

  it("approves requests", () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = service.handle("g1", "admin", "/approve r1");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
  });

  it("rejects requests with reason", () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = service.handle("g1", "admin", "/reject r1 资料不完整");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Rejected);
    expect(auditLog.all().at(-1)?.reason).toBe("资料不完整");
  });

  it("reports invalid request ids", () => {
    const result = service.handle("g1", "admin", "/approve missing");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("审批失败");
  });

  it("shows rules", () => {
    const result = service.handle("g1", "mod", "/rules");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("广告");
  });

  it("shows status", () => {
    const result = service.handle("g1", "mod", "/status");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("禁言时长");
  });
});
