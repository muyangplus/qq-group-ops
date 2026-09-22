import { describe, expect, it, beforeEach } from "vitest";

import { JoinRequestStatus } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";

describe("AdminCommandService", () => {
  let auditLog: InMemoryAuditLog;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let identityMap: IdentityMapService;
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
    identityMap = new IdentityMapService();
    identityMap.bindUser("member", "10001");
    identityMap.bindUser("mod", "10002");
    identityMap.bindUser("admin", "10003");
    identityMap.bindUser("root", "10004");
    identityMap.bindUser("u3", "10005");
    identityMap.bindUser("u4", "10006");
    identityMap.bindGroup("g1", "654321");
    service = new AdminCommandService(
      permissions,
      joinAudit,
      configStore,
      undefined,
      identityMap,
    );
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
    expect(result.text).toContain("全量消息模式");
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

  it("requires group binding before using group commands", () => {
    const result = service.handle("g2", "root", "/status");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("请先绑定本群");
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

  it("supports private binding commands", () => {
    const result = service.handle(undefined, "member", "/bind qq 999999");
    expect(result.ok).toBe(true);
    expect(identityMap.getQq("member")).toBe("999999");
  });

  it("requires group_openid for group commands in private", () => {
    const missing = service.handle(undefined, "root", "/pending");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("group_openid");

    const withGroup = service.handle(undefined, "root", "/pending g1");
    expect(withGroup.ok).toBe(true);
  });

  it("configures group permissions from private with group_openid", () => {
    const grant = service.handle(undefined, "root", "/perm grant mod g1 u4");
    expect(grant.ok).toBe(true);
    expect(grant.text).toContain("u4");

    const groupPermission = service.handle("g1", "u4", "/myperm");
    expect(groupPermission.text).toContain("你的权限等级：moderator");
  });

  it("binds and resolves user QQ numbers", () => {
    const bind = service.handle("g1", "member", "/bind qq 123456");
    expect(bind.ok).toBe(true);
    expect(identityMap.resolveUserId("123456")).toBe("member");
  });

  it("binds current group number and resolves it", () => {
    const bind = service.handle("g1", "admin", "/bind group 654321");
    expect(bind.ok).toBe(true);
    expect(identityMap.resolveGroupId("654321")).toBe("g1");

    const status = service.handle(undefined, "root", "/status 654321");
    expect(status.ok).toBe(true);
    expect(status.text).toContain("群号：654321");
  });

  it("resolves QQ numbers when granting permissions", () => {
    service.handle("g1", "member", "/bind qq 123456");
    const grant = service.handle("g1", "root", "/perm grant mod 123456");
    expect(grant.ok).toBe(true);
    expect(identityMap.resolveUserId("123456")).toBe("member");

    const permission = service.handle("g1", "member", "/myperm");
    expect(permission.text).toContain("你的权限等级：moderator");
  });

  it("allows super admin to bind arbitrary ids and query mappings", () => {
    const userBind = service.handle(
      undefined,
      "root",
      "/bind user openid-user 111111",
    );
    expect(userBind.ok).toBe(true);
    const groupBind = service.handle(
      undefined,
      "root",
      "/bind groupid openid-group 222222",
    );
    expect(groupBind.ok).toBe(true);

    const whoisUser = service.handle(undefined, "root", "/whois 111111");
    expect(whoisUser.ok).toBe(true);
    expect(whoisUser.text).toContain("openid-user");
    const whoisGroup = service.handle(undefined, "root", "/whois 222222");
    expect(whoisGroup.ok).toBe(true);
    expect(whoisGroup.text).toContain("openid-group");
  });

  it("denies arbitrary binding to non-super-admin", () => {
    const result = service.handle(
      undefined,
      "admin",
      "/bind user openid-user 111111",
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("仅超级管理员");
  });

  it("requires QQ binding before using commands", () => {
    const denied = service.handle("g1", "unbound", "/myperm");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("请先绑定 QQ 号");

    const bind = service.handle("g1", "unbound", "/bind qq 999999");
    expect(bind.ok).toBe(true);

    const allowed = service.handle("g1", "unbound", "/myperm");
    expect(allowed.ok).toBe(true);
  });

  it("rejects unbound group numbers in private", () => {
    const result = service.handle(undefined, "root", "/pending 999999");
    expect(result.ok).toBe(false);
  });
});
