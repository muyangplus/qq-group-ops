import { describe, expect, it, beforeEach } from "vitest";

import { JoinRequestStatus } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";
import { FakeIdentityBindingRepository } from "./helpers/fakeIdentityBindingRepository.js";

describe("AdminCommandService", async () => {
  let auditLog: InMemoryAuditLog;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let identityMap: IdentityMapService;
  let permissions: PermissionService;
  let service: AdminCommandService;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
    permissions = new PermissionService({
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

  it("shows only permitted commands in help", async () => {
    const member = await service.handle("g1", "member", "/help");
    expect(member.ok).toBe(true);
    expect(member.text).toContain("/help");
    expect(member.text).toContain("/bind qq");
    expect(member.text).toContain("/myperm");
    expect(member.text).not.toContain("/test");
    expect(member.text).not.toContain("/approve");
    expect(member.text).not.toContain("/perm");

    const mod = await service.handle("g1", "mod", "/help");
    expect(mod.text).toContain("/pending");
    expect(mod.text).toContain("/test");
    expect(mod.text).not.toContain("/approve");
    expect(mod.text).not.toContain("/perm");

    const admin = await service.handle("g1", "admin", "/help");
    expect(admin.text).toContain("/approve");
    expect(admin.text).not.toContain("/perm");

    const root = await service.handle("g1", "root", "/help");
    expect(root.text).toContain("/perm");
    expect(root.text).toContain("/whois");
  });

  it("shows binding help when user is not bound", async () => {
    const result = await service.handle("g1", "unbound", "/help");
    expect(result.text).toContain("/bind qq");
    expect(result.text).not.toContain("/myperm");
  });

  it("shows group binding help when group is not bound", async () => {
    const result = await service.handle("g2", "root", "/help");
    expect(result.text).toContain("/bind group");
    expect(result.text).not.toContain("/myperm");
  });

  it("rejects unknown commands", async () => {
    const result = await service.handle("g1", "member", "/unknown");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知指令");
  });

  it("requires permission for pending", async () => {
    const result = await service.handle("g1", "member", "/pending");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("lists pending requests for the group", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    joinAudit.submit("g2", "u2", "其他群", "r2");
    const result = await service.handle("g1", "mod", "/pending");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
    expect(result.text).not.toContain("r2");
  });

  it("approves requests", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await service.handle("g1", "admin", "/approve r1");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
  });

  it("rejects requests with reason", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await service.handle("g1", "admin", "/reject r1 资料不完整");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Rejected);
    expect(auditLog.all().at(-1)?.reason).toBe("资料不完整");
  });

  it("reports invalid request ids", async () => {
    const result = await service.handle("g1", "admin", "/approve missing");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("审批失败");
  });

  it("shows rules", async () => {
    const result = await service.handle("g1", "mod", "/rules");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("广告");
  });

  it("shows status", async () => {
    const result = await service.handle("g1", "mod", "/status");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("全量消息模式");
    expect(result.text).toContain("禁言时长");
  });

  it("responds to /test for reviewers", async () => {
    const result = await service.handle("g1", "mod", "/test");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("测试成功");
    expect(result.text).toContain("待审批申请");
  });

  it("requires permission for /test", async () => {
    const result = await service.handle("g1", "member", "/test");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("requires group binding before using group commands", async () => {
    const result = await service.handle("g2", "root", "/status");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("请先绑定本群");
  });

  it("shows own permissions", async () => {
    const result = await service.handle("g1", "member", "/myperm");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("你的权限等级：member");
    expect(result.text).toContain("配置权限：false");
  });

  it("allows super admin to list and grant permissions", async () => {
    const list = await service.handle("g1", "root", "/perm list");
    expect(list.ok).toBe(true);
    expect(list.text).toContain("超级管理员：root");

    const grant = await service.handle("g1", "root", "/perm grant mod u3");
    expect(grant.ok).toBe(true);
    expect(grant.text).toContain("u3");

    const memberPermission = await service.handle("g1", "u3", "/myperm");
    expect(memberPermission.text).toContain("你的权限等级：moderator");

    const revoke = await service.handle("g1", "root", "/perm revoke mod u3");
    expect(revoke.ok).toBe(true);
  });

  it("denies permission configuration to non-super-admin", async () => {
    const result = await service.handle("g1", "admin", "/perm list");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("仅超级管理员");
  });

  it("supports private binding commands", async () => {
    const result = await service.handle(undefined, "member", "/bind qq 999999");
    expect(result.ok).toBe(true);
    expect(identityMap.getQq("member")).toBe("999999");
  });

  it("requires group_openid for group commands in private", async () => {
    const missing = await service.handle(undefined, "root", "/pending");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("group_openid");

    const withGroup = await service.handle(undefined, "root", "/pending g1");
    expect(withGroup.ok).toBe(true);
  });

  it("configures group permissions from private with group_openid", async () => {
    const grant = await service.handle(undefined, "root", "/perm grant mod g1 u4");
    expect(grant.ok).toBe(true);
    expect(grant.text).toContain("u4");

    const groupPermission = await service.handle("g1", "u4", "/myperm");
    expect(groupPermission.text).toContain("你的权限等级：moderator");
  });

  it("binds and resolves user QQ numbers", async () => {
    const bind = await service.handle("g1", "member", "/bind qq 123456");
    expect(bind.ok).toBe(true);
    expect(identityMap.resolveUserId("123456")).toBe("member");
  });

  it("binds current group number and resolves it", async () => {
    const bind = await service.handle("g1", "admin", "/bind group 654321");
    expect(bind.ok).toBe(true);
    expect(identityMap.resolveGroupId("654321")).toBe("g1");

    const status = await service.handle(undefined, "root", "/status 654321");
    expect(status.ok).toBe(true);
    expect(status.text).toContain("群号：654321");
  });

  it("resolves QQ numbers when granting permissions", async () => {
    await service.handle("g1", "member", "/bind qq 123456");
    const grant = await service.handle("g1", "root", "/perm grant mod 123456");
    expect(grant.ok).toBe(true);
    expect(identityMap.resolveUserId("123456")).toBe("member");

    const permission = await service.handle("g1", "member", "/myperm");
    expect(permission.text).toContain("你的权限等级：moderator");
  });

  it("allows super admin to bind arbitrary ids and query mappings", async () => {
    const userBind = await service.handle(
      undefined,
      "root",
      "/bind user openid-user 111111",
    );
    expect(userBind.ok).toBe(true);
    const groupBind = await service.handle(
      undefined,
      "root",
      "/bind groupid openid-group 222222",
    );
    expect(groupBind.ok).toBe(true);

    const whoisUser = await service.handle(undefined, "root", "/whois 111111");
    expect(whoisUser.ok).toBe(true);
    expect(whoisUser.text).toContain("openid-user");
    const whoisGroup = await service.handle(undefined, "root", "/whois 222222");
    expect(whoisGroup.ok).toBe(true);
    expect(whoisGroup.text).toContain("openid-group");
  });

  it("denies arbitrary binding to non-super-admin", async () => {
    const result = await service.handle(
      undefined,
      "admin",
      "/bind user openid-user 111111",
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("仅超级管理员");
  });

  it("requires QQ binding before using commands", async () => {
    const denied = await service.handle("g1", "unbound", "/myperm");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("请先绑定 QQ 号");

    const bind = await service.handle("g1", "unbound", "/bind qq 999999");
    expect(bind.ok).toBe(true);

    const allowed = await service.handle("g1", "unbound", "/myperm");
    expect(allowed.ok).toBe(true);
  });

  it("rejects unbound group numbers in private", async () => {
    const result = await service.handle(undefined, "root", "/pending 999999");
    expect(result.ok).toBe(false);
  });

  it("surfaces persistence failures and keeps the previous binding", async () => {
    const repository = new FakeIdentityBindingRepository();
    const map = new IdentityMapService(repository);
    await map.bindUser("member", "10001");
    const localService = new AdminCommandService(
      permissions,
      joinAudit,
      configStore,
      undefined,
      map,
    );

    repository.failNextBind = true;
    const result = await localService.handle("g1", "member", "/bind qq 999999");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("绑定失败");
    expect(map.getQq("member")).toBe("10001");
    expect(map.resolveUserId("999999")).toBeUndefined();
  });

  it("marks persisted bindings when a repository is attached", async () => {
    const repository = new FakeIdentityBindingRepository();
    const map = new IdentityMapService(repository);
    await map.bindUser("member", "10001");
    const localService = new AdminCommandService(
      permissions,
      joinAudit,
      configStore,
      undefined,
      map,
    );

    const result = await localService.handle("g1", "member", "/bind qq 10002");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已保存到数据库");
    expect(repository.bindings).toEqual([
      { kind: "user", officialId: "member", externalId: "10002" },
    ]);
  });
});
