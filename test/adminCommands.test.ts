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
    expect(result.text).toContain("/test");
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

  it("responds to /test for reviewers", () => {
    const result = service.handle("g1", "mod", "/test");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("测试成功");
    expect(result.text).toContain("待审批申请");
  });

  it("requires permission for /test", () => {
    const result = service.handle("g1", "member", "/test");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("shows own permissions", () => {
    const result = service.handle("g1", "member", "/myperm");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("你的权限等级：member");
    expect(result.text).toContain("配置权限：false");
  });

  it("allows super admin to list and grant permissions", () => {
    const list = service.handle("g1", "root", "/perm list");
    expect(list.ok).toBe(true);
    expect(list.text).toContain("超级管理员：root");

    const grant = service.handle("g1", "root", "/perm grant mod u3");
    expect(grant.ok).toBe(true);
    expect(grant.text).toContain("u3");

    const memberPermission = service.handle("g1", "u3", "/myperm");
    expect(memberPermission.text).toContain("你的权限等级：moderator");

    const revoke = service.handle("g1", "root", "/perm revoke mod u3");
    expect(revoke.ok).toBe(true);
  });

  it("denies permission configuration to non-super-admin", () => {
    const result = service.handle("g1", "admin", "/perm list");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("仅超级管理员");
  });
});
