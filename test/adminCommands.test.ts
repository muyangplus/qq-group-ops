import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { JoinRequestStatus } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DisplayNameService } from "../src/services/displayNames.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRuleEvaluator } from "../src/services/joinRules.js";
import { MemberRoster } from "../src/services/memberRoster.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import {
  NOTIFY_SCOPE_ALL,
  NotificationService,
} from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";
import { ShortCodeService } from "../src/services/shortCodes.js";
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
  let notifications: NotificationService;
  let service: AdminCommandService;
  let shortCodes: ShortCodeService;

  /** 带短码展示的服务：生产装配路径（DisplayNameService）的最小替身。 */
  function withShortCodes(): AdminCommandService {
    shortCodes = new ShortCodeService();
    return new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications,
      display: new DisplayNameService(identityMap, shortCodes),
    });
  }

  function scopedShortCodeLabel(
    kind: "user" | "group" | "join_request",
    targetId: string,
  ): string {
    return shortCodes.label(kind, targetId);
  }

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
    notifications = new NotificationService(api, permissions, {
      identityMap,
      configStore,
    });
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications,
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

  it("shows the detailed help for a topic", async () => {
    const result = await service.handle("g1", "admin", "/help rules");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("/rules — 群规则配置");
    expect(result.text).toContain("所需权限：");
    expect(result.text).toContain("/rules set keywords 广告,刷屏,加群");
    expect(result.text).toContain("/rules set autoApprove on|off");
    expect(result.text).toContain("/rules set all <字段> <值>");
    // 群内会附带当前生效值
    expect(result.text).toContain("当前生效值");
    expect(result.text).toContain("关键词：广告");
  });

  it("supports topic aliases and leading slash", async () => {
    const alias = await service.handle("g1", "admin", "/help 规则");
    expect(alias.ok).toBe(true);
    expect(alias.text).toContain("/rules — 群规则配置");

    const withSlash = await service.handle("g1", "admin", "/help /rules");
    expect(withSlash.ok).toBe(true);
    expect(withSlash.text).toContain("/rules set keywords");
  });

  it("hides topic details the user cannot execute", async () => {
    const result = await service.handle("g1", "member", "/help rules");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
    expect(result.text).toContain("需要");
    expect(result.text).not.toContain("/rules set keywords");
  });

  it("denies platform level topics to group roles", async () => {
    const rulesAdmin = await service.handle("g1", "admin", "/help perm");
    expect(rulesAdmin.ok).toBe(false);
    expect(rulesAdmin.text).toContain("仅全局超级管理员");

    const perm = await service.handle("g1", "root", "/help perm");
    expect(perm.ok).toBe(true);
    expect(perm.text).toContain("/perm grant gsuper");
  });

  it("allows binding help without permission and shows binding status", async () => {
    const result = await service.handle("g1", "unbound", "/help bind");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("/bind qq <QQ号>");
    expect(result.text).toContain("尚未绑定");
    // 群号已绑定：只显示群号，不再显示 group_openid
    expect(result.text).toContain("本群：群号 654321");
    expect(result.text).not.toContain("g1");
  });

  it("suggests topics for an unknown help argument", async () => {
    const result = await service.handle("g1", "admin", "/help nope");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("未找到「nope」的帮助");
    expect(result.text).toContain("/help <指令>");
    expect(result.text).toContain("可用指令：");
  });

  it("rejects unknown commands", async () => {
    const result = await service.handle("g1", "member", "/unknown");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知指令");
  });

  it("opens the main menu for everyone", async () => {
    const result = await service.handle("g1", "member", "/menu");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("系统菜单");
    expect(result.rich?.keyboard?.content.rows.length).toBeGreaterThan(0);
    // 纯文本降级里同样能拿到指令
    expect(result.text).toContain("/menu sys");
  });

  it("opens the main menu for empty and aliased input", async () => {
    const empty = await service.handle("g1", "member", "   ");
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("系统菜单");

    const alias = await service.handle("g1", "admin", "/菜单 管理菜单");
    expect(alias.ok).toBe(true);
    expect(alias.text).toContain("/pending");
  });

  it("lets unbound users open the menu", async () => {
    const result = await service.handle("g1", "unbound", "/menu");

    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("请先绑定 QQ 号");
    expect(result.text).toContain("/bind qq");
  });

  it("reports unknown sub menus with the main menu", async () => {
    const result = await service.handle("g1", "member", "/menu nope");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("未找到「nope」菜单");
    expect(result.text).toContain("系统菜单");
  });

  it("denies the admin menu to plain members", async () => {
    const result = await service.handle("g1", "member", "/menu admin");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("attaches menu buttons to unknown commands", async () => {
    const result = await service.handle("g1", "member", "/definitely-not-a-command");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知指令");
    expect(result.rich?.keyboard?.content.rows.length).toBeGreaterThan(0);
    expect(result.rich?.text).toContain("未知指令");
  });

  it("limits /testmenu to super admins and validates the page", async () => {
    const denied = await service.handle("g1", "admin", "/testmenu");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    const first = await service.handle("g1", "root", "/testmenu");
    expect(first.ok).toBe(true);
    expect(first.text).toContain("第 1 / 3 页");
    expect(first.rich?.keyboard?.content.rows.length).toBeGreaterThan(0);

    const second = await service.handle("g1", "root", "/testmenu 2");
    expect(second.ok).toBe(true);
    expect(second.text).toContain("第 2 / 3 页");

    const invalid = await service.handle("g1", "root", "/testmenu 9");
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("页码范围");
  });

  it("only lists /testmenu in super admin help", async () => {
    const root = await service.handle("g1", "root", "/help");
    expect(root.text).toContain("/testmenu");

    const member = await service.handle("g1", "member", "/help");
    expect(member.text).not.toContain("/testmenu");
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
    // 已绑定的用户只显示 QQ号，不显示内部 userId
    expect(list.text).toContain("全局超级管理员：10004");
    expect(list.text).not.toContain("root");

    const grant = await service.handle("g1", "root", "/perm grant mod u3");
    expect(grant.ok).toBe(true);
    expect(grant.text).toContain("已更新权限：mod 10005");

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

  it("scopes group super admins to their own group", async () => {
    const grant = await service.handle("g1", "root", "/perm grant gsuper u4");
    expect(grant.ok).toBe(true);
    expect(permissions.isGroupSuperAdmin("u4", "g1")).toBe(true);

    const myperm = await service.handle("g1", "u4", "/myperm");
    expect(myperm.text).toContain("你的权限等级：super_admin");
    expect(myperm.text).toContain("本群超级管理员：true");
    expect(myperm.text).toContain("全局超级管理员：false");
    expect(myperm.text).toContain("配置权限：false");

    // 在本群内可以做群管理与审批
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const approve = await service.handle("g1", "u4", "/approve r1");
    expect(approve.ok).toBe(true);
    const rules = await service.handle("g1", "u4", "/rules set keywords 本群词");
    expect(rules.ok).toBe(true);

    // 其他群没有任何权限
    expect(permissions.levelFor("u4", "g2")).toBe("member");

    // 拿不到平台级能力
    const perm = await service.handle("g1", "u4", "/perm list");
    expect(perm.ok).toBe(false);
    expect(perm.text).toContain("仅超级管理员");
    const globalRules = await service.handle("g1", "u4", "/rules all");
    expect(globalRules.ok).toBe(false);
    expect(globalRules.text).toContain("仅超级管理员");
  });

  it("revokes group super admins and supports the private form", async () => {
    const grant = await service.handle(
      undefined,
      "root",
      "/perm grant gsuper 654321 u4",
    );
    expect(grant.ok).toBe(true);
    expect(permissions.isGroupSuperAdmin("u4", "g1")).toBe(true);

    const list = await service.handle("g1", "root", "/perm list");
    expect(list.text).toContain("本群超级管理员");

    const revoke = await service.handle("g1", "root", "/perm revoke 群超管 u4");
    expect(revoke.ok).toBe(true);
    expect(permissions.isGroupSuperAdmin("u4", "g1")).toBe(false);
  });

  it("requires a group for group super admin grants", async () => {
    const result = await service.handle(
      undefined,
      "root",
      "/perm grant gsuper u4",
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("需要提供群号");
  });

  it("configures keyword recall and punishment", async () => {
    await service.handle("g1", "admin", "/rules set keywordRecall on");
    await service.handle("g1", "admin", "/rules set keywordPunish kick_blacklist");

    expect(configStore.get("g1").keywordRecall).toBe(true);
    expect(configStore.get("g1").keywordPunish).toBe("kick_blacklist");

    // 中文别名
    await service.handle("g1", "admin", "/rules set 处罚 禁言");
    expect(configStore.get("g1").keywordPunish).toBe("mute");

    await service.handle("g1", "admin", "/rules set 撤回 off");
    expect(configStore.get("g1").keywordRecall).toBe(false);

    const invalid = await service.handle(
      "g1",
      "admin",
      "/rules set keywordPunish nope",
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("none / mute / kick / kick_blacklist");
  });

  it("configures join decision and answer requirements", async () => {
    await service.handle("g1", "admin", "/rules set joinDecision reject_on_mismatch");
    await service.handle("g1", "admin", "/rules set joinRequireClass on");
    await service.handle("g1", "admin", "/rules set joinRequireName 是");
    await service.handle(
      "g1",
      "admin",
      "/rules set joinAnswerPattern ^材化\\d{4}\\s+\\S{2,4}$",
    );
    await service.handle("g1", "admin", "/rules set joinReviewOpinion off");

    const config = configStore.get("g1");
    expect(config.joinDecision).toBe("reject_on_mismatch");
    expect(config.joinRequireClass).toBe(true);
    expect(config.joinRequireName).toBe(true);
    expect(config.joinAnswerPattern).toContain("材化");
    expect(config.joinReviewOpinion).toBe(false);

    // 中文别名 + clear
    await service.handle("g1", "admin", "/rules set 入群决策 命中通过");
    expect(configStore.get("g1").joinDecision).toBe("approve_on_match");
    await service.handle("g1", "admin", "/rules set 入群正则 clear");
    expect(configStore.get("g1").joinAnswerPattern).toBe("");

    const invalidDecision = await service.handle(
      "g1",
      "admin",
      "/rules set joinDecision nope",
    );
    expect(invalidDecision.ok).toBe(false);
    expect(invalidDecision.text).toContain("manual / auto_approve");

    const invalidPattern = await service.handle(
      "g1",
      "admin",
      "/rules set joinAnswerPattern ([bad",
    );
    expect(invalidPattern.ok).toBe(false);
    expect(invalidPattern.text).toContain("不合法");
  });

  it("shows review opinions in /pending when enabled", async () => {
    const evaluator = new JoinRuleEvaluator(
      MemberRoster.fromIndex({
        classes: ["材化2211"],
        majors: ["材料化学"],
        classInfo: {
          材化2211: {
            major: "材料化学",
            college: "化学与生命科学学院",
            year: "2022",
          },
        },
      }),
    );
    const localService = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      joinRules: evaluator,
    });
    configStore.setOverride({
      groupId: "g1",
      joinDecision: "approve_on_match",
      joinRequireClass: true,
      joinRequireName: true,
      joinReviewOpinion: true,
    });
    joinAudit.submit("g1", "u1", "材化2211 张三", "r1");

    const result = await localService.handle("g1", "mod", "/pending");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("审核意见");
    expect(result.text).toContain("材化2211");
    expect(result.text).toContain("姓名 张三");
    expect(result.text).toContain("建议：通过");
  });

  it("hides review opinions when the group disables them", async () => {
    const evaluator = new JoinRuleEvaluator(
      MemberRoster.fromIndex({ classes: ["材化2211"] }),
    );
    const localService = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      joinRules: evaluator,
    });
    configStore.setOverride({ groupId: "g1", joinReviewOpinion: false });
    joinAudit.submit("g1", "u1", "材化2211 张三", "r1");

    const result = await localService.handle("g1", "mod", "/pending");

    expect(result.text).not.toContain("审核意见");
  });

  it("supports private binding commands", async () => {
    const result = await service.handle(undefined, "member", "/bind qq 999999");
    expect(result.ok).toBe(true);
    expect(identityMap.getQq("member")).toBe("999999");
  });

  it("requires group_openid for group commands in private", async () => {
    const missing = await service.handle(undefined, "root", "/pending");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("群号");

    const withGroup = await service.handle(undefined, "root", "/pending g1");
    expect(withGroup.ok).toBe(true);
  });

  it("configures group permissions from private with group_openid", async () => {
    const grant = await service.handle(undefined, "root", "/perm grant mod g1 u4");
    expect(grant.ok).toBe(true);
    // u4 已绑定 QQ 10006 → 只显示 QQ号
    expect(grant.text).toContain("已更新权限：mod 10006");

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
    // 群号已绑定：标题只显示群号，不再显示 group_openid
    expect(status.text).toContain("群 654321 状态：");
    expect(status.text).not.toContain("g1");
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
    // 操作人已绑定 → 显示 QQ号；申请人未绑定 → 回退 openid
    expect(result.text).toContain("by 10003");
    expect(result.text).toContain("→ u1");
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

  it("subscribes and unsubscribes join request push from a group", async () => {
    const on = await service.handle("g1", "admin", "/notify on");
    expect(on.ok).toBe(true);
    expect(on.text).toContain("已开启");
    expect(notifications.isSubscribed("admin", "g1")).toBe(true);

    const status = await service.handle("g1", "admin", "/notify");
    // 群号已绑定 → 只显示群号
    expect(status.text).toContain("群 654321：已开启");
    expect(status.text).not.toContain("（g1）");

    const off = await service.handle("g1", "admin", "/notify off");
    expect(off.text).toContain("已关闭");
    expect(notifications.isSubscribed("admin", "g1")).toBe(false);
  });

  it("treats /notify on in private as all reviewable groups", async () => {
    const result = await service.handle(undefined, "admin", "/notify on");
    expect(result.ok).toBe(true);
    expect(notifications.isSubscribed("admin", NOTIFY_SCOPE_ALL)).toBe(true);
  });

  it("supports subscribing to a specific group in private", async () => {
    const result = await service.handle(undefined, "admin", "/notify 654321 on");
    expect(result.ok).toBe(true);
    expect(notifications.isSubscribed("admin", "g1")).toBe(true);
  });

  it("refuses push subscriptions from users who cannot approve", async () => {
    const moderator = await service.handle("g1", "mod", "/notify on");
    expect(moderator.ok).toBe(false);
    expect(moderator.text).toContain("权限不足");

    const stranger = await service.handle(undefined, "member", "/notify all on");
    expect(stranger.ok).toBe(false);
    expect(stranger.text).toContain("权限不足");
    expect(notifications.listScopes("mod")).toEqual([]);
  });

  it("refuses subscribing to a group where the user has no role", async () => {
    identityMap.bindGroup("g2", "777777");
    const result = await service.handle(undefined, "admin", "/notify 777777 on");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("lists the push subscription status without leaking other groups", async () => {
    await service.handle("g1", "admin", "/notify on");
    const result = await service.handle(undefined, "admin", "/notify");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("可审批的群：654321");
    expect(result.text).not.toContain("（g1）");
    expect(result.text).toContain("用法：");
  });

  it("sends a push test card", async () => {
    await service.handle("g1", "admin", "/notify on");
    const result = await service.handle("g1", "admin", "/notify test");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已发送推送测试卡片");
    expect(api.sentPrivateMessages[0]?.userOpenid).toBe("admin");
    expect(api.sentPrivateMessages[0]?.markdown).toContain("推送测试");
  });

  it("mentions /notify in the admin help and help topic", async () => {
    const help = await service.handle("g1", "admin", "/help");
    expect(help.text).toContain("/notify");

    const topic = await service.handle("g1", "admin", "/help notify");
    expect(topic.ok).toBe(true);
    expect(topic.text).toContain("入群申请推送");
    expect(topic.text).toContain("/notify all on|off");
  });

  it("hides /notify help from users who cannot approve", async () => {
    const topic = await service.handle("g1", "mod", "/help notify");
    expect(topic.ok).toBe(false);
    expect(topic.text).toContain("权限不足");
  });

  it("lets a global super admin read group command help in private", async () => {
    for (const topic of [
      "rules",
      "approve",
      "reject",
      "notify",
      "pending",
      "sync",
      "audit",
      "status",
      "test",
    ]) {
      const result = await service.handle(undefined, "root", `/help ${topic}`);
      expect(result.ok, `${topic}: ${result.text}`).toBe(true);
      expect(result.text).toContain(`/${topic} —`);
      expect(result.text).not.toContain("权限不足");
    }
  });

  it("still denies group command help to users without any role", async () => {
    const result = await service.handle(undefined, "member", "/help rules");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("shows global rules when a super admin runs /rules in private", async () => {
    const result = await service.handle(undefined, "root", "/rules");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("全局");
  });

  it("keeps asking for a group id when /rules is used in private without super admin", async () => {
    const result = await service.handle(undefined, "admin", "/rules");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("#群短码");
  });

  it("persists the auto-decision notification switch", async () => {
    const result = await service.handle(
      "g1",
      "admin",
      "/rules set notifyAutoApproved on",
    );
    expect(result.ok).toBe(true);
    expect(configStore.get("g1").notifyAutoApproved).toBe(true);
    expect(result.text).toContain("自动处理也通知：true");

    const off = await service.handle(
      "g1",
      "admin",
      "/rules set 通知自动通过 off",
    );
    expect(off.ok).toBe(true);
    expect(configStore.get("g1").notifyAutoApproved).toBe(false);
  });

  it("uses short codes for join requests and approves by short code", async () => {
    const scoped = withShortCodes();
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const pending = await scoped.handle("g1", "admin", "/pending");
    const code = /#[0-9A-Za-z]{6}/u.exec(pending.text)?.[0];
    expect(code).toBeDefined();
    // 不再暴露长申请 id / 内部 user id
    expect(pending.text).not.toContain("r1");
    expect(pending.text).not.toContain("u1");

    const approve = await scoped.handle("g1", "admin", `/approve ${code}`);
    expect(approve.ok).toBe(true);
    expect(approve.text).toContain(code ?? "");
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
  });

  it("only lets /whois reveal the real system id behind a short code", async () => {
    const scoped = withShortCodes();
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const pending = await scoped.handle("g1", "admin", "/pending");
    const code = /#[0-9A-Za-z]{6}/u.exec(pending.text)?.[0] ?? "";

    const denied = await scoped.handle("g1", "admin", `/whois ${code}`);
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    const result = await scoped.handle("g1", "root", `/whois ${code}`);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("类型：入群申请");
    expect(result.text).toContain("真实申请 ID：r1");
  });

  it("renders /help as a card with callback entries", async () => {
    const result = await service.handle("g1", "root", "/help");

    expect(result.ok).toBe(true);
    const buttons = (result.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // 标准：导航 / 查看类按钮用回调
    expect(buttons.find((button) => button.id === "sys")?.action).toMatchObject({
      type: 1,
      data: "cb:menu:open:sys",
    });
    // 纯文本降级仍包含完整指令列表
    expect(result.text).toContain("可用指令：");
    expect(result.text).toContain("/menu");
  });

  it("renders /help <topic> with a related entry", async () => {
    const result = await service.handle("g1", "mod", "/help rules");

    expect(result.ok).toBe(true);
    expect(result.rich?.markdown).toContain("/rules — 群规则配置");
    const buttons = (result.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(buttons.find((button) => button.id === "view")?.action).toMatchObject({
      type: 1,
      data: "cb:rules:view:g1",
    });
  });

  it("renders /status as a card with refresh and action buttons", async () => {
    const result = await service.handle("g1", "mod", "/status");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("全量消息模式");
    const buttons = (result.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(
      buttons.find((button) => button.id === "refresh")?.action,
    ).toMatchObject({ type: 1, data: "cb:status:view:g1" });
    // 执行动作（自检）用指令按钮
    expect(buttons.find((button) => button.id === "test")?.action).toMatchObject({
      type: 2,
      data: "/test",
    });
  });

  it("renders /pending as a paged card with approve/reject buttons", async () => {
    for (let index = 1; index <= 5; index += 1) {
      joinAudit.submit("g1", `u${index}`, `理由${index}`, `r${index}`);
    }

    const first = await service.handle("g1", "mod", "/pending");
    expect(first.ok).toBe(true);
    expect(first.rich?.markdown).toContain("第 1 / 2 页");
    const firstButtons = (first.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // 每页 3 条，每条一个「通过」+「拒绝」指令按钮
    expect(
      firstButtons.filter((button) => button.id.startsWith("approve-")),
    ).toHaveLength(3);
    expect(firstButtons.find((button) => button.id === "approve-r1")?.action).toMatchObject({
      type: 2,
      data: "/approve r1",
    });
    // 翻页是回调
    expect(firstButtons.find((button) => button.id === "next")?.action).toMatchObject({
      type: 1,
      data: "cb:pending:page:g1:2",
    });
    // 纯文本降级必须能翻页
    expect(first.text).toContain("下一页：/pending +2");

    const second = await service.handle("g1", "mod", "/pending +2");
    expect(second.rich?.markdown).toContain("第 2 / 2 页");
    const secondButtons = (second.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(secondButtons.find((button) => button.id === "prev")?.action).toMatchObject({
      type: 1,
      data: "cb:pending:page:g1:1",
    });
    expect(secondButtons.some((button) => button.id === "next")).toBe(false);
  });

  it("renders /rules as a card with toggle command buttons", async () => {
    const result = await service.handle("g1", "admin", "/rules");

    expect(result.ok).toBe(true);
    const buttons = (result.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // 开关是执行动作 → 指令按钮，与手输指令同一条路径
    expect(
      buttons.find((button) => button.id === "wordFilter")?.action,
    ).toMatchObject({ type: 2, data: "/rules set wordFilter off" });
    // 帮助是查看 → 回调
    expect(buttons.find((button) => button.id === "help")?.action).toMatchObject({
      type: 1,
      data: "cb:help:topic:rules",
    });
  });

  it("resolves #group and #user short codes in commands", async () => {
    const scoped = withShortCodes();
    identityMap.bindGroup("g2", "777777");
    const groupCode = scopedShortCodeLabel("group", "g2");

    // 私信里用群短码查看状态（root 是超管）
    const status = await scoped.handle(
      undefined,
      "root",
      `/status ${groupCode}`,
    );
    expect(status.ok).toBe(true);
    expect(status.text).toContain("群 777777 状态：");
  });
});
