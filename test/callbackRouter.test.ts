import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { renderCard } from "../src/services/cardTemplate.js";
import {
  CallbackRouter,
  type CallbackRenderer,
} from "../src/services/callbackRouter.js";
import type { InteractionEvent } from "../src/services/eventRouter.js";
import { RichMessageSender } from "../src/services/richMessages.js";

const demoCard = renderCard({
  title: "演示卡片",
  lines: ["第 2 页"],
  rows: [[{ id: "next", label: "下一页", callbackData: "cb:demo:page:3" }]],
});

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
    userId: "u1",
    buttonData: "cb:demo:page:2",
    ...overrides,
  };
}

function createRouter(renderers: Record<string, CallbackRenderer>): {
  api: FakeQQOfficialAPI;
  router: CallbackRouter;
  sender: RichMessageSender;
} {
  const api = new FakeQQOfficialAPI();
  const sender = new RichMessageSender(api);
  const router = new CallbackRouter({
    api,
    sender,
    renderers: new Map(Object.entries(renderers)),
  });
  return { api, router, sender };
}

describe("CallbackRouter", () => {
  it("acks the interaction and actively sends the rendered card", async () => {
    const { api, router } = createRouter({
      demo: async () => demoCard,
    });

    const outcome = await router.handle(interactionEvent());

    expect(outcome.handled).toBe(true);
    expect(outcome.detail).toContain("demo:page");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    // 群聊里不能把 interaction id 当 msg_id（真机 400），所以是主动发送
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.msgId).toBeUndefined();
    expect(api.sentMessages[0]?.markdown).toContain("演示卡片");
    expect(api.sentMessages[0]?.keyboard).toBeDefined();
  });

  it("passes the parsed callback to the renderer", async () => {
    let seen: unknown;
    const { router } = createRouter({
      demo: async (parsed, event) => {
        seen = { parsed, userId: event.userId };
        return demoCard;
      },
    });

    await router.handle(interactionEvent({ buttonData: "cb:demo:page:7" }));

    expect(seen).toEqual({
      parsed: { namespace: "demo", action: "page", args: ["7"] },
      userId: "u1",
    });
  });

  it("acks foreign callbacks without sending anything", async () => {
    const { api, router } = createRouter({ demo: async () => demoCard });

    const outcome = await router.handle(
      interactionEvent({ buttonData: "someone-else:1" }),
    );

    expect(outcome.handled).toBe(false);
    expect(outcome.detail).toContain("unknown_callback");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    expect(api.sentMessages).toHaveLength(0);
  });

  it("acks and reports callbacks without a renderer", async () => {
    const { api, router } = createRouter({});

    const outcome = await router.handle(interactionEvent());

    expect(outcome.handled).toBe(false);
    expect(outcome.detail).toContain("no_route:demo");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    expect(api.sentMessages).toHaveLength(0);
  });

  it("still sends the card when the ack fails", async () => {
    const api = new FakeQQOfficialAPI();
    api.failInteractionResponses = true;
    const sender = new RichMessageSender(api);
    const router = new CallbackRouter({
      api,
      sender,
      renderers: new Map([["demo", async () => demoCard]]),
    });

    const outcome = await router.handle(interactionEvent());

    expect(outcome.handled).toBe(true);
    expect(outcome.detail).toContain("ack_failed");
    expect(api.sentMessages).toHaveLength(1);
  });

  it("does not send when the renderer returns nothing", async () => {
    const { api, router } = createRouter({ demo: async () => undefined });

    const outcome = await router.handle(interactionEvent());

    expect(outcome.handled).toBe(false);
    expect(outcome.detail).toContain("no_card");
    expect(api.interactionResponses).toEqual([["i1", 0]]);
    expect(api.sentMessages).toHaveLength(0);
  });

  it("sends to private chats when the interaction has no group", async () => {
    const { api, router } = createRouter({ demo: async () => demoCard });

    await router.handle(
      interactionEvent({ scene: "c2c", chatType: 2, groupId: undefined }),
    );

    expect(api.sentPrivateMessages).toHaveLength(1);
    expect(api.sentMessages).toHaveLength(0);
    // §F1：私聊不加 @
    expect(String(api.sentPrivateMessages[0]?.markdown ?? "")).not.toMatch(
      /^<@!/u,
    );
  });

  it("mentions the clicker on group callback cards", async () => {
    const { api, router } = createRouter({ demo: async () => demoCard });

    await router.handle(interactionEvent());

    // §F1：群内回调回复首行 @ 点击者
    expect(String(api.sentMessages[0]?.markdown ?? "")).toMatch(/^<@!u1>\n/u);
  });

  it("keeps the test module callbacks exempt from the mention", async () => {
    const { api, router } = createRouter({ testmenu: async () => demoCard });

    await router.handle(
      interactionEvent({ buttonData: "cb:testmenu:page:2" }),
    );

    expect(String(api.sentMessages[0]?.markdown ?? "")).not.toMatch(/^<@!/u);
  });
});
