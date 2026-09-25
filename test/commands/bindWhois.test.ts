import { AdminCommandService } from "../../src/services/adminCommands.js";
import { IdentityMapService } from "../../src/services/identityMap.js";
import { FakeIdentityBindingRepository } from "../helpers/fakeIdentityBindingRepository.js";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  auditLog,
  joinAudit,
  configStore,
  identityMap,
  permissions,
  api,
  joinApproval,
  joinSync,
  service,
  privateText,
  withShortCodes,
  withProfiles,
  scopedShortCodeLabel,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · bindWhois（13 个用例）。
 */

describe("AdminCommandService · bindWhois", () => {
  it("requires group binding before using group commands", async () => {
    const result = await service.handle("g2", "root", "/status");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("请先绑定本群");
  });

  it("supports private binding commands", async () => {
    const result = await service.handle(undefined, "member", "/bind qq 999999");
    expect(result.ok).toBe(true);
    expect(identityMap.getQq("member")).toBe("999999");
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
    // 群内完全静默（silent 由 gatewayRunner 拦下）：群里不出现真实 id
    expect(result.silent).toBe(true);
    expect(result.text).not.toContain("真实申请 ID");
    expect(result.text).not.toContain("r1");
    const dm = privateText("root");
    expect(dm).toContain("类型：入群申请");
    expect(dm).toContain("真实申请 ID：r1");
  });

  it("defaults /whois to the current context", async () => {
    // 群里：结果私信给操作人，群里完全静默（不发任何提示）
    const inGroup = await service.handle("g1", "root", "/whois");
    expect(inGroup.ok).toBe(true);
    expect(inGroup.silent).toBe(true);
    expect(inGroup.text).not.toContain("654321");
    const dm = privateText("root");
    expect(dm).toContain("类型：群（当前群）");
    expect(dm).toContain("654321");

    // 私聊：直接回复（本来就只有本人能看到）
    const inPrivate = await service.handle(undefined, "root", "/whois");
    expect(inPrivate.ok).toBe(true);
    expect(inPrivate.text).toContain("类型：用户（你自己）");
    expect(inPrivate.text).toContain("10004");

    // 非超管照旧被拒（这类提示不含隐私，仍在原处回）
    const denied = await service.handle("g1", "member", "/whois");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("仅超级管理员");
  });

  it("delivers /whois results privately and never falls back to the group", async () => {
    // 私信通道失败：群里只提示重试，绝不显示结果
    api.failPrivateMessages = true;
    const failed = await service.handle(undefined, "root", "/whois 654321");
    // 私聊里的失败也能直接看到（不需要私信发送）
    expect(failed.ok).toBe(true);
    expect(failed.text).toContain("类型：群");

    const inGroup = await service.handle("g1", "root", "/whois 654321");
    expect(inGroup.ok).toBe(true);
    expect(inGroup.text).toContain("私信发送失败");
    expect(inGroup.text).not.toContain("g1");
  });

  it("shows join request details for a /whois short code", async () => {
    const scoped = withShortCodes();
    joinAudit.submit("g1", "u1", "环工2214小明", "r1");
    const code = scopedShortCodeLabel("join_request", "r1");

    const result = await scoped.handle("g1", "root", `/whois ${code}`);

    expect(result.ok).toBe(true);
    expect(result.silent).toBe(true);
    const dm = privateText("root");
    expect(dm).toContain("类型：入群申请");
    expect(dm).toContain("申请人：");
    expect(dm).toContain("理由：环工2214小明");
    expect(dm).toContain("状态：pending");
    expect(dm).toContain("本地队列：待审批中");

    // 处理过之后不再进队列，但 /whois 仍能查到详情（同样走私信）
    joinAudit.approve("r1", "admin");
    const after = await scoped.handle("g1", "root", `/whois ${code}`);
    expect(after.ok).toBe(true);
    const afterDm = privateText("root");
    expect(afterDm).toContain("状态：approved");
    expect(afterDm).toContain("已不在队列");
  });

  it("shows profile + QQ mapping via /whois profile", async () => {
    const { svc, profiles } = withProfiles();
    await svc.handle("g1", "member", "/profile set 22123456789 材化2211 张三");

    // 群内：完全静默，详情走私信
    const byQq = await svc.handle("g1", "root", "/whois profile 10001");
    expect(byQq.ok).toBe(true);
    expect(byQq.silent).toBe(true);
    expect(byQq.text).not.toContain("张三");
    const dm = privateText("root");
    expect(dm).toContain("类型：用户资料");
    expect(dm).toContain("QQ：10001");
    expect(dm).toContain("姓名：张三");
    expect(dm).toContain("学号：22123456789");
    expect(dm).toContain("班级：材化2211");
    expect(dm).toContain("学院：化学与生命科学学院");

    // 私聊里直接回
    const inPrivate = await svc.handle(undefined, "root", "/whois profile 10001");
    expect(inPrivate.ok).toBe(true);
    expect(inPrivate.text).toContain("姓名：张三");

    // 未绑定 QQ 的用户：短码也能查到（走私信）
    profiles.set("ghost", "name", "赵六");
    const code = scopedShortCodeLabel("user", "ghost");
    const byCode = await svc.handle("g1", "root", `/whois profile ${code}`);
    expect(byCode.ok).toBe(true);
    const codeDm = privateText("root");
    expect(codeDm).toContain(`短码：${code}`);
    expect(codeDm).toContain("QQ：（未绑定）");
    expect(codeDm).toContain("姓名：赵六");

    // 群内 @ 指定对方
    const byMention = await svc.handle("g1", "root", "/whois profile <@!member>");
    expect(byMention.ok).toBe(true);
    expect(privateText("root")).toContain("姓名：张三");

    // 未填写资料：同样静默，只走私信
    const blank = await svc.handle("g1", "root", "/whois profile 10002");
    expect(blank.ok).toBe(true);
    expect(blank.silent).toBe(true);
    expect(privateText("root")).toContain("个人资料：尚未填写");

    // 未知映射 / 权限：不含隐私，群里直接回
    const missing = await svc.handle("g1", "root", "/whois profile nope");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("未找到");

    const denied = await svc.handle("g1", "admin", "/whois profile 10001");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
  });
});
