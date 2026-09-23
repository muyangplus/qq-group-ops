import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { JoinRequestStatus } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { AuditLogStore } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import { PermissionService } from "../src/services/permissions.js";
import { FakeIdentityBindingRepository } from "./helpers/fakeIdentityBindingRepository.js";

describe("AdminCommandService", async () => {
  let auditLog: AuditLogStore;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let identityMap: IdentityMapService;
  let permissions: PermissionService;
  let api: FakeQQOfficialAPI;
  let joinApproval: JoinApprovalService;
  let joinSync: JoinRequestSyncService;
  let service: AdminCommandService;

  beforeEach(() => {
    auditLog = new AuditLogStore();
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
    api = new FakeQQOfficialAPI();
    joinApproval = new JoinApprovalService(api, joinAudit, configStore);
    joinSync = new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 });
    identityMap = new IdentityMapService();
    identityMap.bindUser("member", "10001");
    identityMap.bindUser("mod", "10002");
    identityMap.bindUser("admin", "10003");
    identityMap.bindUser("root", "10004");
    identityMap.bindUser("u3", "10005");
    identityMap.bindUser("u4", "10006");
    identityMap.bindGroup("g1", "654321");
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
    });
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
    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
  });

  it("rejects requests with reason", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await service.handle("g1", "admin", "/reject r1 资料不完整");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Rejected);
    expect(auditLog.all().at(-1)?.reason).toBe("资料不完整");
    expect(api.joinRequestReviews).toEqual([
      {
        groupId: "g1",
        memberOpenid: "u1",
        op: "decline",
        joinRequestId: "r1",
        reason: "资料不完整",
      },
    ]);
  });

  it("keeps the request pending when the official approval fails", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    api.failJoinRequestApprovals = true;

    const result = await service.handle("g1", "admin", "/approve r1");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("审批失败");
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
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
    const localService = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap: map,
    });

    repository.failNextBind = true;
    const result = await localService.handle("g1", "member", "/bind qq 999999");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("绑定失败");
    expect(map.getQq("member")).toBe("10001");
    expect(map.resolveUserId("999999")).toBeUndefined();
  });

  it("writes bindings through to the repository", async () => {
    const repository = new FakeIdentityBindingRepository();
    const map = new IdentityMapService(repository);
    await map.bindUser("member", "10001");
    const localService = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap: map,
    });

    const result = await localService.handle("g1", "member", "/bind qq 10002");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已绑定");
    expect(repository.bindings).toEqual([
      { kind: "user", officialId: "member", externalId: "10002" },
    ]);
  });

  it("updates group keywords with /rules set", async () => {
    const result = await service.handle("g1", "admin", "/rules set keywords 广告,刷屏");

    expect(result.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);
    expect(result.text).toContain("刷屏");
  });

  it("clears keywords with /rules set keywords clear", async () => {
    await service.handle("g1", "admin", "/rules set keywords 广告");
    const result = await service.handle("g1", "admin", "/rules set keywords clear");

    expect(result.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual([]);
  });

  it("toggles switches and numbers with /rules set", async () => {
    await service.handle("g1", "admin", "/rules set autoApprove on");
    await service.handle("g1", "admin", "/rules set wordFilter off");
    await service.handle("g1", "admin", "/rules set muteDuration 120");
    await service.handle("g1", "admin", "/rules set warning 请勿刷屏");

    const config = configStore.get("g1");
    expect(config.autoApproveJoin).toBe(true);
    expect(config.wordFilterEnabled).toBe(false);
    expect(config.muteDurationSeconds).toBe(120);
    expect(config.warningMessage).toBe("请勿刷屏");
  });

  // README「配置群规则（完整示例）」里的私信流程与报错文案由该用例锁定
  it("supports the documented private rule flow with a bound group number", async () => {
    const keywords = await service.handle(
      undefined,
      "root",
      "/rules set 654321 keywords 广告,刷屏",
    );
    expect(keywords.ok).toBe(true);
    expect(configStore.get("g1").keywords).toEqual(["刷屏", "广告"]);

    const warning = await service.handle(
      undefined,
      "root",
      "/rules set 654321 warning 本群禁止广告与刷屏，请撤回并阅读群规。",
    );
    expect(warning.ok).toBe(true);
    expect(configStore.get("g1").warningMessage).toBe(
      "本群禁止广告与刷屏，请撤回并阅读群规。",
    );

    const view = await service.handle(undefined, "root", "/rules 654321");
    expect(view.ok).toBe(true);
    expect(view.text).toContain("本群禁止广告与刷屏");
    expect(view.text).toContain("刷屏");
    expect(view.text).toContain("禁言时长");

    const unknown = await service.handle(
      undefined,
      "root",
      "/rules set 654321 unknown 1",
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("未知字段");

    const badToggle = await service.handle(
      undefined,
      "root",
      "/rules set 654321 autoApprove maybe",
    );
    expect(badToggle.ok).toBe(false);
    expect(badToggle.text).toContain("需要 on 或 off");

    const badDuration = await service.handle(
      undefined,
      "root",
      "/rules set 654321 muteDuration abc",
    );
    expect(badDuration.ok).toBe(false);
    expect(badDuration.text).toContain("禁言时长需要非负整数（秒）");
  });

  it("caps muteDuration at 30 days", async () => {
    await service.handle("g1", "admin", "/rules set muteDuration 99999999999");

    expect(configStore.get("g1").muteDurationSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("lets a super admin view and update global rules with /rules all", async () => {
    const view = await service.handle("g1", "root", "/rules all");
    expect(view.ok).toBe(true);
    expect(view.text).toContain("全局默认规则");

    const set = await service.handle(
      "g1",
      "root",
      "/rules set all keywords 全局违禁词",
    );
    expect(set.ok).toBe(true);
    expect(set.text).toContain("已更新全局规则");
    expect(configStore.default.keywords).toEqual(["全局违禁词"]);

    // 未单独配置的群继承全局关键词
    expect(configStore.get("g-other").keywords).toEqual(["全局违禁词"]);
    // 已在群内配置过关键词的群保持自己的配置
    await service.handle("g1", "admin", "/rules set keywords 本群词");
    expect(configStore.get("g1").keywords).toEqual(["本群词"]);
    expect(configStore.get("g1").autoApproveJoin).toBe(false);
  });

  it("accepts the 全局 alias for global rules", async () => {
    const set = await service.handle("g1", "root", "/rules set 全局 autoApprove on");
    expect(set.ok).toBe(true);
    expect(configStore.default.autoApproveJoin).toBe(true);

    const view = await service.handle(undefined, "root", "/rules 全局");
    expect(view.ok).toBe(true);
    expect(view.text).toContain("全局默认规则");
  });

  it("denies global rules to non super admins", async () => {
    const view = await service.handle("g1", "admin", "/rules all");
    expect(view.ok).toBe(false);
    expect(view.text).toContain("仅超级管理员");

    const set = await service.handle(
      "g1",
      "admin",
      "/rules set all keywords 全局违禁词",
    );
    expect(set.ok).toBe(false);
    expect(set.text).toContain("仅超级管理员");
    expect(configStore.default.keywords).toEqual(["广告"]);
  });

  it("requires a field and value for global rules", async () => {
    const result = await service.handle("g1", "root", "/rules set all");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("/rules set all <字段> <值>");
  });

  it("resets global warning text to the builtin default with clear", async () => {
    await service.handle("g1", "root", "/rules set all warning 全局警告");
    expect(configStore.default.warningMessage).toBe("全局警告");

    await service.handle("g1", "root", "/rules set all warning clear");
    expect(configStore.default.warningMessage).toBe(
      "请遵守群规，不要发送违规内容。",
    );
  });

  it("clears global keywords with /rules set all keywords clear", async () => {
    await service.handle("g1", "root", "/rules set all keywords 全局词");
    expect(configStore.default.keywords).toEqual(["全局词"]);
    expect(configStore.get("g-other").keywords).toEqual(["全局词"]);

    const cleared = await service.handle(
      "g1",
      "root",
      "/rules set all keywords clear",
    );

    expect(cleared.ok).toBe(true);
    expect(configStore.default.keywords).toEqual([]);
    expect(configStore.get("g-other").keywords).toEqual([]);
  });

  it("rejects invalid /rules set values", async () => {
    const toggle = await service.handle("g1", "admin", "/rules set autoApprove maybe");
    expect(toggle.ok).toBe(false);
    expect(toggle.text).toContain("需要 on 或 off");

    const field = await service.handle("g1", "admin", "/rules set unknown 1");
    expect(field.ok).toBe(false);
    expect(field.text).toContain("未知字段");

    const missing = await service.handle("g1", "admin", "/rules set keywords");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("/rules set");
  });

  it("requires group admin permission to change rules", async () => {
    const result = await service.handle("g1", "mod", "/rules set keywords 广告");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
    expect(configStore.get("g1").keywords).toEqual(["广告"]);
  });

  it("supports /rules set from private with a group id", async () => {
    const result = await service.handle(
      undefined,
      "root",
      "/rules set g1 autoApprove on",
    );

    expect(result.ok).toBe(true);
    expect(configStore.get("g1").autoApproveJoin).toBe(true);
  });

  it("shows recent audit records", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    await service.handle("g1", "admin", "/approve r1");

    const result = await service.handle("g1", "mod", "/audit");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("approve_join_request");
    expect(result.text).toContain("admin");
  });

  it("limits and filters audit records per group", async () => {
    auditLog.append({
      recordId: "old",
      groupId: "g1",
      actorId: "admin",
      action: "manual_old",
      status: "executed",
      reason: "",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    auditLog.append({
      recordId: "new",
      groupId: "g1",
      actorId: "admin",
      action: "manual_new",
      status: "executed",
      reason: "",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    auditLog.append({
      recordId: "other",
      groupId: "g2",
      actorId: "admin",
      action: "other_group",
      status: "executed",
      reason: "",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    const result = await service.handle("g1", "mod", "/audit 1");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("manual_new");
    expect(result.text).not.toContain("manual_old");
    expect(result.text).not.toContain("other_group");
  });

  it("requires moderator permission to read audit records", async () => {
    const result = await service.handle("g1", "member", "/audit");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("syncs pending join requests from the official API", async () => {
    api.addJoinRequest("g1", "u1", "想加入", "r1");

    const result = await service.handle("g1", "mod", "/sync");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
    expect(joinAudit.pending("g1")).toHaveLength(1);
  });

  it("requires moderator permission to sync join requests", async () => {
    const result = await service.handle("g1", "member", "/sync");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("reports sync failures", async () => {
    api.failJoinRequestList = true;

    const result = await service.handle("g1", "mod", "/sync");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("同步失败");
  });
});
