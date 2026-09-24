import { describe, expect, it } from "vitest";

import { pageCallback } from "../src/services/callbackData.js";
import type { InteractionEvent } from "../src/services/eventRouter.js";
import { PermissionService } from "../src/services/permissions.js";
import {
  TEST_MENU_PAGE_COUNT,
  TestMenuService,
  buildTestMenuCard,
  clampTestMenuPage,
  parseTestMenuCallback,
} from "../src/services/testMenu.js";

function createPermissions(): PermissionService {
  return new PermissionService({ superAdminIds: new Set(["root"]) });
}

function interactionEvent(
  overrides: Partial<InteractionEvent> = {},
): InteractionEvent {
  return {
    type: "interaction",
    interactionId: "i1",
    interactionType: 11,
    scene: "group",
    chatType: 1,
    groupId: "g1",
    userId: "root",
    ...overrides,
  };
}

describe("test menu card", () => {
  it("renders three pages with callback buttons and a command fallback", () => {
    const first = buildTestMenuCard(1);
    expect(first.markdown).toContain("测试菜单（第 1 / 3 页）");
    expect(first.markdown).toContain("手动翻页：/testmenu <页码>");
    expect(first.keyboard).toBeDefined();

    const buttons = (card: typeof first) =>
      (card.keyboard?.content.rows ?? []).flatMap((row) => row.buttons);
    const labels = (card: typeof first) =>
      buttons(card).map((button) => button.label);

    // 第 1 页：没有「上一页」，有「下一页」+「返回第 1 页」+ 指令兜底
    expect(labels(first)).toEqual(["下一页", "返回第 1 页", "指令翻页 2"]);

    // 导航是回调按钮（type=1，标准要求），手动翻页是指令按钮（type=2）
    const firstButtons = buttons(first);
    expect(firstButtons[0]?.action).toMatchObject({
      type: 1,
      data: pageCallback("testmenu", 2),
    });
    expect(firstButtons[2]?.action).toMatchObject({
      type: 2,
      data: "/testmenu 2",
    });

    expect(labels(buildTestMenuCard(2))).toEqual([
      "上一页",
      "下一页",
      "返回第 1 页",
      "指令翻页 3",
    ]);
    // 第 3 页：没有「下一页」
    expect(labels(buildTestMenuCard(3))).toEqual(["上一页", "返回第 1 页"]);
  });

  it("clamps pages and parses callback data", () => {
    expect(clampTestMenuPage(0)).toBe(1);
    expect(clampTestMenuPage(99)).toBe(TEST_MENU_PAGE_COUNT);
    expect(clampTestMenuPage(Number.NaN)).toBe(1);
    expect(buildTestMenuCard(9).markdown).toContain("第 3 / 3 页");

    expect(parseTestMenuCallback(pageCallback("testmenu", 2))).toBe(2);
    expect(parseTestMenuCallback(pageCallback("testmenu", 99))).toBe(3);
    expect(parseTestMenuCallback("other:thing")).toBeUndefined();
    expect(parseTestMenuCallback("cb:menu:open:admin")).toBeUndefined();
    expect(parseTestMenuCallback(undefined)).toBeUndefined();
  });

  it("keeps the plain text fallback usable without buttons", () => {
    const card = buildTestMenuCard(2);
    expect(card.text).toContain("【测试菜单（第 2 / 3 页）】");
    expect(card.text).toContain("/testmenu 3");
  });
});

describe("TestMenuService renderer", () => {
  it("renders the requested page for super admins", async () => {
    const service = new TestMenuService({ permissions: createPermissions() });

    const card = await service.render(
      { namespace: "testmenu", action: "page", args: ["2"] },
      interactionEvent(),
    );

    expect(card?.markdown).toContain("第 2 / 3 页");
    expect(card?.keyboard).toBeDefined();
  });

  it("returns a denial card for other users", async () => {
    const service = new TestMenuService({ permissions: createPermissions() });

    const card = await service.render(
      { namespace: "testmenu", action: "page", args: ["2"] },
      interactionEvent({ userId: "member" }),
    );

    expect(card?.markdown).toContain("仅全局超级管理员");
  });

  it("ignores other namespaces and malformed pages", async () => {
    const service = new TestMenuService({ permissions: createPermissions() });

    await expect(
      service.render({ namespace: "menu", action: "open", args: [] }, interactionEvent()),
    ).resolves.toBeUndefined();
    await expect(
      service.render(
        { namespace: "testmenu", action: "page", args: ["x"] },
        interactionEvent(),
      ),
    ).resolves.toBeUndefined();
  });
});
