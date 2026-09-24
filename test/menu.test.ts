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
  it("shows section entries according to permission", () => {
    const member = buttonIds(buildMenu("main", context("member")));
    expect(member).toContain("sys");
    expect(member).toContain("myperm");
    expect(member).not.toContain("admin");
    expect(member).not.toContain("super");

    const moderator = buttonIds(buildMenu("main", context("mod")));
    expect(moderator).toContain("admin");
    expect(moderator).not.toContain("super");

    const root = buttonIds(buildMenu("main", context("root")));
    expect(root).toContain("admin");
    expect(root).toContain("super");
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

  it("limits the super menu to global super admins", () => {
    const groupSuper = buildMenu("super", context("gsup"));
    expect(groupSuper.ok).toBe(false);
    expect(groupSuper.message.text).toContain("本群超级管理员");

    const root = buildMenu("super", context("root"));
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
      const view = buildMenu(section, context("root"));
      const rows = view.message.keyboard?.content.rows ?? [];
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const row of rows) {
        expect(row.buttons.length).toBeLessThanOrEqual(5);
        for (const button of row.buttons) {
          expect(button.label.length).toBeLessThanOrEqual(10);
          // 菜单按钮全部是指令按钮（点击=发送指令），不需要新增事件类型
          expect(button.action.type).toBe(2);
          expect(button.action.data.startsWith("/")).toBe(true);
        }
      }
      expect(view.message.markdown).toContain("## ");
      expect(view.message.text.length).toBeGreaterThan(0);
    }
  });

  it("falls back to plain text with the same commands", () => {
    const view = buildMenu("admin", context("admin"));
    expect(view.message.text).toContain("/pending");
    expect(view.message.text).toContain("/menu review");
    expect(view.message.text).toContain("/audit");
  });

  it("builds an unknown-command card with menu entries", () => {
    const message = buildUnknownCommandMenu("nope", context("member"));
    expect(message.text).toContain("未知指令：nope");
    expect(message.text).toContain("系统菜单");
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
