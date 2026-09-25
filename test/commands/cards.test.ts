import {
  describe,
  expect,
  it,
} from "vitest";
import {
  joinAudit,
  api,
  service,
  withSender,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · cards（8 个用例）。
 */

describe("AdminCommandService · cards", () => {
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

  it("keeps every sample card inside the layout limits", async () => {
    joinAudit.submit("g1", "u1", "理由", "r1");

    for (const command of [
      "/menu",
      "/help",
      "/help all",
      "/status",
      "/pending",
      "/rules",
      "/testmenu",
    ]) {
      const result = await service.handle("g1", "root", command);
      const rows = result.rich?.keyboard?.content.rows ?? [];
      expect(rows.length, command).toBeLessThanOrEqual(5);
      for (const row of rows) {
        // 标准：一行按钮文字总长 ≤12 字（个数不限，官方上限 5 个）
        const width = row.buttons.reduce(
          (sum, button) => sum + button.label.length,
          0,
        );
        expect(width, `${command} row`).toBeLessThanOrEqual(12);
        for (const button of row.buttons) {
          expect(
            button.label.length,
            `${command} ${button.label}`,
          ).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it("renders /test as a card with refresh and quick entries", async () => {
    const result = await service.handle("g1", "mod", "/test");

    expect(result.ok).toBe(true);
    expect(result.rich?.markdown).toContain("测试成功");
    const buttons = (result.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(
      buttons.find((button) => button.id === "refresh")?.action,
    ).toMatchObject({ type: 1, data: "cb:test:view:g1" });
  });

  it("reports the sync operator in the result card", async () => {
    const result = await service.syncCard("g1", "mod", "g1");

    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("<@!mod>");
    expect(result.rich.markdown).not.toContain("操作人：");
    expect(result.rich.markdown).toContain("待审批");
  });

  it("reports the operator in approval result cards", async () => {
    joinAudit.submit("g1", "u1", "理由", "r1");

    const result = await service.handle("g1", "admin", "/approve r1");

    expect(result.ok).toBe(true);
    expect(result.rich?.markdown).toContain("已通过入群申请");
    expect(result.rich?.markdown).toContain("<@!admin>");
    expect(result.rich?.markdown).not.toContain("操作人：");
  });

  it("returns a card for every command output", async () => {
    joinAudit.submit("g1", "u1", "理由", "r1");

    // 卡片标准的不变量：任何指令（含用法提示与错误提示）都必须给出卡片
    for (const command of [
      "/help",
      "/help nope",
      "/menu",
      "/menu nope",
      "/myperm",
      "/bind",
      "/bind qq 10004",
      "/whois nope",
      "/profile",
      "/activity",
      "/rules",
      "/rules all",
      "/perm list",
      "/pending",
      "/sync",
      "/notify",
      "/audit",
      "/status",
      "/test",
      "/testmenu",
      "/approve nope",
      "/reject nope",
      "/definitely-not-a-command",
    ]) {
      const result = await service.handle("g1", "root", command);
      expect(result.rich, command).toBeDefined();
      expect(result.rich?.markdown.length, command).toBeGreaterThan(0);
      expect(result.rich?.text.length, command).toBeGreaterThan(0);
    }
  });

  it("gives tailored cards to the remaining commands", async () => {
    const cases: Array<[string, string]> = [
      ["/myperm", "我的权限"],
      ["/bind", "绑定"],
      // `/whois` 在群里一律走私信（A4），群里只留静默占位卡，不再断言按钮
      ["/perm list", "权限配置"],
      ["/profile", "个人资料"],
    ];
    for (const [command, title] of cases) {
      const result = await service.handle("g1", "root", command);
      expect(result.rich?.markdown, command).toContain(title);
      expect(
        (result.rich?.keyboard?.content.rows ?? []).length,
        command,
      ).toBeGreaterThan(0);
      // 非 help 卡片不再罗列手动指令
      expect(result.text, command).not.toContain("手动指令");
    }
  });

  it("sends /testat variants so the @ rendering can be checked on device", async () => {
    const svc = withSender();

    // 只有全局超管能用；私聊里没意义
    const denied = await svc.handle("g1", "admin", "/testat");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
    const inPrivate = await svc.handle(undefined, "root", "/testat");
    expect(inPrivate.ok).toBe(false);
    expect(inPrivate.text).toContain("请在群里执行 /testat");
    expect(api.sentMessages).toHaveLength(0);

    const result = await svc.handle("g1", "root", "/testat");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("已在群里发送 3 条测试消息");

    // 第 1 条是纯文本（无 markdown），提及走 content
    const plain = api.sentMessages[0]!;
    expect(plain.groupId).toBe("g1");
    expect(plain.markdown).toBeUndefined();
    expect(String(plain.content)).toContain("<@!root>");
    expect(String(plain.content)).toContain("@测试 1");

    // 第 2、3 条是 Markdown 卡片：一个首行 @、一个正文中间 @
    const cardFirst = api.sentMessages[1]!;
    const cardMiddle = api.sentMessages[2]!;
    expect(String(cardFirst.markdown).startsWith("<@!root>")).toBe(true);
    expect(String(cardMiddle.markdown)).toContain("<@!root>");
    expect(String(cardMiddle.markdown).startsWith("<@!root>")).toBe(false);
    expect(api.sentMessages).toHaveLength(3);
  });
});
