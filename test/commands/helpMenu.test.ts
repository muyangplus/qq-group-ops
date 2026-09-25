import {
  describe,
  expect,
  it,
} from "vitest";
import {
  service,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · helpMenu（21 个用例）。
 */

describe("AdminCommandService · helpMenu", () => {
  it("shows only permitted commands in help", async () => {
    // /help 现在是伞形卡，完整列表在 /help all
    const member = await service.handle("g1", "member", "/help all");
    expect(member.ok).toBe(true);
    expect(member.text).toContain("/help");
    expect(member.text).toContain("/bind qq");
    expect(member.text).toContain("/myperm");
    expect(member.text).not.toContain("/test");
    expect(member.text).not.toContain("/approve");
    expect(member.text).not.toContain("/perm");

    const mod = await service.handle("g1", "mod", "/help all");
    expect(mod.text).toContain("/pending");
    expect(mod.text).toContain("/test");
    expect(mod.text).not.toContain("/approve");
    expect(mod.text).not.toContain("/perm");

    const admin = await service.handle("g1", "admin", "/help all");
    expect(admin.text).toContain("/approve");
    expect(admin.text).not.toContain("/perm");

    const root = await service.handle("g1", "root", "/help all");
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
    // 菜单导航是回调按钮（点击即出下一张卡）
    const buttons = (result.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(buttons.find((button) => button.id === "sys")?.action).toMatchObject({
      type: 1,
      data: "cb:menu:open:sys",
    });
    // 菜单卡不再罗列手动指令（指令列表统一在 /help）
    expect(result.text).not.toContain("手动指令");
  });

  it("opens the main menu for empty and aliased input", async () => {
    const empty = await service.handle("g1", "member", "   ");
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("系统菜单");

    const alias = await service.handle("g1", "admin", "/菜单 管理菜单");
    expect(alias.ok).toBe(true);
    expect(alias.rich?.markdown).toContain("管理菜单");
    const aliasButtons = (alias.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(aliasButtons.find((button) => button.id === "pending")?.action).toMatchObject({
      type: 1,
      data: "cb:cmd:run:/pending",
    });
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
    const root = await service.handle("g1", "root", "/help all");
    expect(root.text).toContain("/testmenu");

    const member = await service.handle("g1", "member", "/help all");
    expect(member.text).not.toContain("/testmenu");
  });

  it("mentions /notify in the admin help and help topic", async () => {
    const help = await service.handle("g1", "admin", "/help all");
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

  it("renders /help as an umbrella card and /help all as the full list", async () => {
    const umbrella = await service.handle("g1", "root", "/help");
    expect(umbrella.ok).toBe(true);
    const buttons = (umbrella.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // 标准：导航 / 查看类按钮用回调
    expect(buttons.find((button) => button.id === "sys")?.action).toMatchObject({
      type: 1,
      data: "cb:menu:open:sys",
    });
    expect(buttons.find((button) => button.id === "all")?.action).toMatchObject({
      type: 1,
      data: "cb:help:list",
    });
    // 伞形卡本身是短的，完整列表在二级卡
    expect(umbrella.rich?.markdown).not.toContain("可用指令：");

    const list = await service.handle("g1", "root", "/help all");
    expect(list.text).toContain("可用指令：");
    expect(list.text).toContain("/menu");
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
});
