import { describe, expect, it } from "vitest";

import {
  MENU_SECTIONS,
  buildMenu,
  buildUnknownCommandMenu,
  findMenuSection,
  type MenuContext,
  type MenuView,
} from "../src/services/menu.js";
import { PermissionService } from "../src/services/permissions.js";

function createPermissions(): PermissionService {
  return new PermissionService({
    superAdminIds: new Set(["root"]),
    groupSuperAdminIds: new Map([["g1", new Set(["gsup"])]]),
    groupAdminIds: new Map([["g1", new Set(["admin"])]]),
    moderatorIds: new Map([["g1", new Set(["mod"])]]),
  });
}

function context(
  userId: string,
  overrides: Partial<MenuContext> = {},
): MenuContext {
  return {
    userId,
    groupId: "g1",
    bound: true,
    permissions: createPermissions(),
    ...overrides,
  };
}

function buttonIds(view: MenuView): string[] {
  const rows = view.message.keyboard?.content.rows ?? [];
  return rows.flatMap((row) => row.buttons.map((button) => button.id));
}

describe("menu", () => {
  it("shows member entries in group context without management entries", () => {
    const member = buttonIds(buildMenu("main", context("member")));
    expect(member).toEqual(
      expect.arrayContaining(["help", "profile", "myperm", "activity", "appeal"]),
    );
    expect(member).not.toContain("admin");
    expect(member).not.toContain("super");
    // 旧「系统菜单」入口不再出现在默认卡上
    expect(member).not.toContain("sys");
  });

  it("never exposes management entries inside a group, even to admins", () => {
    expect(buttonIds(buildMenu("main", context("mod")))).not.toContain("admin");
    expect(buttonIds(buildMenu("main", context("root")))).not.toContain("admin");
    expect(buttonIds(buildMenu("main", context("root")))).not.toContain("super");
  });

  it("shows management entries only in private chat", () => {
    const mod = buttonIds(buildMenu("main", context("mod", { groupId: undefined })));
    expect(mod).toContain("admin");
    expect(mod).not.toContain("super");

    const root = buttonIds(buildMenu("main", context("root", { groupId: undefined })));
    expect(root).toContain("admin");
    expect(root).toContain("super");

    const member = buttonIds(
      buildMenu("main", context("member", { groupId: undefined })),
    );
    expect(member).not.toContain("admin");
    expect(member).not.toContain("super");
  });

  it("keeps the system section equivalent to the common menu", () => {
    const main = buildMenu("main", context("member"));
    const sys = buildMenu("sys", context("member"));
    expect(sys.ok).toBe(true);
    expect(sys.message.markdown).toBe(main.message.markdown);
  });

  it("hides personal commands for unbound users", () => {
    const view = buildMenu("main", context("unbound", { bound: false }));
    const ids = buttonIds(view);
    expect(ids).toContain("bind");
    expect(ids).not.toContain("myperm");
    expect(ids).not.toContain("profile");
  });

  it("denies the admin menu without moderator permission", () => {
    const view = buildMenu("admin", context("member"));
    expect(view.ok).toBe(false);
    expect(view.message.text).toContain("权限不足");
    expect(view.message.text).toContain("审核员");
  });

  it("gates the review and ops sub menus behind group admin", () => {
    expect(buildMenu("admin", context("mod")).ok).toBe(true);
    expect(buildMenu("review", context("mod")).ok).toBe(false);
    expect(buildMenu("review", context("admin")).ok).toBe(true);
    expect(buildMenu("ops", context("admin")).ok).toBe(true);
  });

  it("limits the super menu to private chat and global super admins", () => {
    const groupSuper = buildMenu("super", context("gsup"));
    expect(groupSuper.ok).toBe(false);
    expect(groupSuper.message.text).toContain("本群超级管理员");

    // §F2：全局超管在群里明确请求也只提示去私信，不在群里展示平台级入口
    const rootInGroup = buildMenu("super", context("root"));
    expect(rootInGroup.ok).toBe(false);
    expect(rootInGroup.message.text).toContain("请在私信");

    const root = buildMenu("super", context("root", { groupId: undefined }));
    expect(root.ok).toBe(true);
    expect(buttonIds(root)).toContain("perm");
  });

  it("requires binding before group level menus", () => {
    const view = buildMenu("admin", context("unbound", { bound: false }));
    expect(view.ok).toBe(false);
    expect(view.message.text).toContain("/bind qq");
  });

  it("keeps every section inside the official keyboard limits", () => {
    for (const section of MENU_SECTIONS) {
      // 私信上下文才能渲染全部层级（含管理 / 超管菜单）
      const view = buildMenu(section, context("root", { groupId: undefined }));
      const rows = view.message.keyboard?.content.rows ?? [];
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const row of rows) {
        expect(row.buttons.length).toBeLessThanOrEqual(5);
        for (const button of row.buttons) {
          expect(button.label.length).toBeLessThanOrEqual(10);
          // 导航与固定动作走回调（type=1），需要参数的走指令按钮（type=2）
          expect([1, 2]).toContain(button.action.type);
          expect(
            button.action.type === 1
              ? button.action.data.startsWith("cb:")
              : button.action.data.startsWith("/"),
          ).toBe(true);
        }
      }
      expect(view.message.markdown).toContain("## ");
      expect(view.message.text.length).toBeGreaterThan(0);
    }
  });

  it("does not repeat manual commands on menu cards", () => {
    const view = buildMenu("admin", context("admin"));
    // 菜单卡只做导航：不再罗列手动指令（指令列表统一在 /help）
    expect(view.message.text).not.toContain("手动指令");
    expect(view.message.text).toContain("管理菜单");
    expect((view.message.keyboard?.content.rows ?? []).length).toBeGreaterThan(0);
  });

  it("builds an unknown-command card with menu entries", () => {
    const message = buildUnknownCommandMenu("nope", context("member"));
    expect(message.text).toContain("未知指令：nope");
    expect(message.markdown).toContain("## 未知指令");
    expect((message.keyboard?.content.rows ?? []).length).toBeGreaterThan(0);
  });

  it("resolves section aliases", () => {
    expect(findMenuSection("管理菜单")).toBe("admin");
    expect(findMenuSection("super")).toBe("super");
    expect(findMenuSection("活动")).toBe("activity");
    expect(findMenuSection("nope")).toBeUndefined();
    expect(findMenuSection(undefined)).toBeUndefined();
  });
});
