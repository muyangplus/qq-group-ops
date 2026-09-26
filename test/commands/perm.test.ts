import {
  describe,
  expect,
  it,
} from "vitest";
import {
  joinAudit,
  configStore,
  identityMap,
  permissions,
  service,
  withProfiles,
  privateText,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · perm（18 个用例）。
 */

describe("AdminCommandService · perm", () => {
  it("requires permission for /test", async () => {
    const result = await service.handle("g1", "member", "/test");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("shows own permissions", async () => {
    const result = await service.handle("g1", "member", "/myperm");
    expect(result.ok).toBe(true);
    expect(result.silent).toBe(true);
    expect(privateText("member")).toContain("权限等级：member");
    expect(privateText("member")).not.toContain("配置权限");
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
    expect(privateText("u3")).toContain("权限等级：moderator");

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

    await service.handle("g1", "u4", "/myperm");
    expect(privateText("u4")).toContain("权限等级：super_admin（本群超管）");

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

  it("configures group permissions from private with group_openid", async () => {
    const grant = await service.handle(undefined, "root", "/perm grant mod g1 u4");
    expect(grant.ok).toBe(true);
    // u4 已绑定 QQ 10006 → 只显示 QQ号
    expect(grant.text).toContain("已更新权限：mod 10006");

    await service.handle("g1", "u4", "/myperm");
    expect(privateText("u4")).toContain("权限等级：moderator");
  });

  it("resolves QQ numbers when granting permissions", async () => {
    await service.handle("g1", "member", "/bind qq 123456");
    const grant = await service.handle("g1", "root", "/perm grant mod 123456");
    expect(grant.ok).toBe(true);
    expect(identityMap.resolveUserId("123456")).toBe("member");

    await service.handle("g1", "member", "/myperm");
    expect(privateText("member")).toContain("权限等级：moderator");
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

  it("requires group admin permission to change rules", async () => {
    const result = await service.handle("g1", "mod", "/rules set keywords 广告");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
    expect(configStore.get("g1").keywords).toEqual(["广告"]);
  });

  it("requires moderator permission to read audit records", async () => {
    const result = await service.handle("g1", "member", "/audit");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("requires moderator permission to sync join requests", async () => {
    const result = await service.handle("g1", "member", "/sync");

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

  it("manages the class alias table via /alias (super admin only)", async () => {
    const { svc, profiles, aliases } = withProfiles();

    const empty = await svc.handle("g1", "root", "/alias");
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("别名表为空");
    // 卡片标准：所有指令输出都是卡片，固定动作走回调
    const buttons = (empty.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(buttons.find((button) => button.id === "refresh")?.action).toMatchObject(
      { type: 1, data: "cb:cmd:run:/alias" },
    );

    const saved = await svc.handle("g1", "root", "/alias set 环工2214 环工2414");
    expect(saved.ok).toBe(true);
    expect(saved.text).toContain("已保存别名");
    expect(aliases.get("环工2214")).toMatchObject({
      target: "环工2414",
      kind: "class",
    });

    const bad = await svc.handle("g1", "root", "/alias set 环工2214 不存在的班级");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("不在班级库");

    // 学生写别名也能填资料（别名先展开成规范名）
    const profile = await svc.handle(
      "g1",
      "member",
      "/profile set 环工2214 张三 22123456789",
    );
    expect(profile.ok).toBe(true);
    expect(profiles.get("member")).toMatchObject({
      className: "环工2414",
      college: "环境科学与工程学院",
    });

    await svc.handle("g1", "root", "/alias set 化生学院 化学与生命科学学院");
    const list = await svc.handle("g1", "root", "/alias list");
    expect(list.text).toContain("环工2214 → 环工2414（班级）");
    expect(list.text).toContain("化生学院 → 化学与生命科学学院（学院）");

    const removed = await svc.handle("g1", "root", "/alias del 环工2214");
    expect(removed.ok).toBe(true);
    expect(aliases.get("环工2214")).toBeUndefined();
    const again = await svc.handle("g1", "root", "/alias del 环工2214");
    expect(again.ok).toBe(false);
    expect(again.text).toContain("不存在");

    const denied = await svc.handle("g1", "admin", "/alias");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    const usage = await svc.handle("g1", "root", "/alias set 只有一个参数");
    expect(usage.ok).toBe(false);
    expect(usage.text).toContain("用法");
  });
});
