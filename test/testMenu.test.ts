import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import type { InteractionEvent } from "../src/services/eventRouter.js";
import { PermissionService } from "../src/services/permissions.js";
import { RichMessageSender } from "../src/services/richMessages.js";
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

function createService(api: FakeQQOfficialAPI): TestMenuService {
  return new TestMenuService({
    api,
    sender: new RichMessageSender(api),
    permissions: createPermissions(),
  });
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
    buttonId: "next",
    buttonData: "testmenu:page:2",
    ...overrides,
  };
}

describe("test menu card", () => {
  it("renders three pages with callback buttons and a command fallback", () => {
    const first = buildTestMenuCard(1);
    expect(first.markdown).toContain("测试菜单（第 1 / 3 页）");
    expect(first.markdown).toContain("手动翻页：/testmenu <页码>");
    expect(first.keyboard).toBeDefined();

    const labels = (card: typeof first): string[] =>
      (card.keyboard?.content.rows ?? [])
        .flatMap((row) => row.buttons)
        .map((button) => button.label);
    const buttons = (card: typeof first) =>
      (card.keyboard?.content.rows ?? []).flatMap((row) => row.buttons);

    // 第 1 页：没有「上一页」，有「下一页」+「返回第 1 页」+ 指令兜底
    expect(labels(first)).toEqual([
      "下一页",
      "返回第 1 页",
      "指令翻页 2",
    ]);

    // 回调按钮 type=1（点官方推 INTERACTION_CREATE），指令按钮 type=2
    const firstButtons = buttons(first);
    expect(firstButtons[0]?.action).toMatchObject({
      type: 1,
      data: "testmenu:page:2",
    });
    expect(firstButtons[2]?.action).toMatchObject({
      type: 2,
      data: "/testmenu 2",
    });

    const second = buttons(buildTestMenuCard(2));
    expect(second.map((button) => button.label)).toEqual([
      "上一页",
      "下一页",
      "返回第 1 页",
      "指令翻页 3",
    ]);
    // 第 3 页：没有「下一页」
    const third = buttons(buildTestMenuCard(3));
    expect(third.map((button) => button.label)).toEqual([
      "上一页",
      "返回第 1 页",
    ]);
  });

  it("clamps pages and parses callback data", () => {
    expect(clampTestMenuPage(0)).toBe(1);
    expect(clampTestMenuPage(99)).toBe(TEST_MENU_PAGE_COUNT);
    expect(clampTestMenuPage(Number.NaN)).toBe(1);
    expect(buildTestMenuCard(9).markdown).toContain("第 3 / 3 页");

    expect(parseTestMenuCallback("testmenu:page:2")).toBe(2);
    expect(parseTestMenuCallback("testmenu:page:99")).toBe(3);
    expect(parseTestMenuCallback("other:thing")).toBeUndefined();
    expect(parseTestMenuCallback(undefined)).toBeUndefined();
  });

  it("keeps the plain text fallback usable without buttons", () => {
    const card = buildTestMenuCard(2);
    expect(card.text).toContain("【测试菜单（第 2 / 3 页）】");
    expect(card.text).toContain("/testmenu 3");
  });
});

describe("TestMenuService", () => {
  it("acks the interaction and sends the next page", async () => {
    const api = new FakeQQOfficialAPI();
    const service = createService(api);

    const outcome = await service.handle(interactionEvent());

    expect(outcome.handled).toBe(true);
    expect(outcome.detail).toContain("page_2");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    expect(api.sentMessages).toHaveLength(1);
    // 实测群聊不能把 interaction id 当 msg_id（400 无效或越权），所以主动发送
    expect(api.sentMessages[0]?.msgId).toBeUndefined();
    expect(api.sentMessages[0]?.keyboard).toBeDefined();
    expect(api.sentMessages[0]?.markdown).toContain("第 2 / 3 页");
  });

  it("keeps keyboards usable for later pages", async () => {
    const api = new FakeQQOfficialAPI();
    const service = createService(api);

    await service.handle(interactionEvent());
    await service.handle(
      interactionEvent({ interactionId: "i2", buttonData: "testmenu:page:3" }),
    );

    expect(api.sentMessages).toHaveLength(2);
    // 真机回归：曾经因为把被动失败误判成「平台不支持按钮」，第 3 页丢了整个键盘
    for (const message of api.sentMessages) {
      expect(message.keyboard).toBeDefined();
    }
  });

  it("still delivers the page when the ack fails", async () => {
    const api = new FakeQQOfficialAPI();
    api.failInteractionResponses = true;
    const service = createService(api);

    const outcome = await service.handle(interactionEvent());

    expect(outcome.handled).toBe(true);
    expect(outcome.detail).toContain("ack_failed");
    expect(outcome.detail).toContain("page_2");
    expect(api.sentMessages).toHaveLength(1);
  });

  it("acks but does not page for non super admins", async () => {
    const api = new FakeQQOfficialAPI();
    const service = createService(api);

    const outcome = await service.handle(
      interactionEvent({ userId: "member" }),
    );

    expect(outcome.detail).toContain("permission_denied");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.markdown).toContain("仅全局超级管理员");
  });

  it("acks callbacks it does not own", async () => {
    const api = new FakeQQOfficialAPI();
    const service = createService(api);

    const outcome = await service.handle(
      interactionEvent({ buttonData: "someone-else:1" }),
    );

    expect(outcome.handled).toBe(false);
    expect(outcome.detail).toContain("unknown_callback");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    expect(api.sentMessages).toHaveLength(0);
  });

  it("replies in private chats too", async () => {
    const api = new FakeQQOfficialAPI();
    const service = createService(api);

    const outcome = await service.handle(
      interactionEvent({
        scene: "c2c",
        chatType: 2,
        groupId: undefined,
        userId: "root",
      }),
    );

    expect(outcome.detail).toContain("page_2");
    expect(api.sentPrivateMessages[0]?.msgId).toBeUndefined();
    expect(api.sentPrivateMessages[0]?.markdown).toContain("第 2 / 3 页");
  });
});
