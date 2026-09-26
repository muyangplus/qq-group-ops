import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import {
  classifyKeyboardFailure,
  RichMessageSender,
  type RichMessage,
} from "../src/services/richMessages.js";

const menuMessage: RichMessage = {
  markdown: "## 系统菜单",
  text: "【系统菜单】\n菜单：/menu",
  keyboard: {
    content: {
      rows: [
        {
          buttons: [
            { id: "menu", label: "菜单", action: { type: 2, data: "/menu" } },
          ],
        },
      ],
    },
  },
};

describe("RichMessageSender", () => {
  it("replies passively when a msg_id is available", async () => {
    const api = new FakeQQOfficialAPI();
    const sender = new RichMessageSender(api);

    const result = await sender.replyToGroup("g1", menuMessage, { msgId: "m1" });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("markdown+keyboard");
    expect(result.detail).toBe("");
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.msgId).toBe("m1");
    expect(api.sentMessages[0]?.markdown).toContain("系统菜单");
  });

  it("falls back to an active send when the passive reply fails", async () => {
    const api = new FakeQQOfficialAPI();
    const sender = new RichMessageSender(api);
    const original = api.sendGroupMessage.bind(api);
    api.sendGroupMessage = async (groupId, content, msgId, options) => {
      if (msgId) {
        throw new Error("passive reply quota exhausted");
      }
      return original(groupId, content, msgId, options);
    };

    const result = await sender.replyToGroup("g1", menuMessage, { msgId: "m1" });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("active_fallback");
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0]?.msgId).toBeUndefined();
    // 关键回归：被动失败（msg_id 无效/越权）不代表平台不支持按钮，
    // 不能把 keyboardDisabled 置真，否则后续所有卡片都会丢按钮
    expect(sender.keyboardAvailable).toBe(true);
    expect(api.sentMessages[0]?.keyboard).toBeDefined();
  });

  it("stops using the keyboard after the platform rejects it", async () => {
    const api = new FakeQQOfficialAPI();
    api.failPrivateKeyboardMessages = true;
    const sender = new RichMessageSender(api);

    const result = await sender.sendToUser("u1", menuMessage);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("markdown");
    expect(result.detail).toBe("markdown_fallback");
    expect(sender.keyboardAvailableFor("user")).toBe(false);
    // 真机回归：私信失败不能连累群卡片
    expect(sender.keyboardAvailableFor("group")).toBe(true);
    expect(api.sentPrivateMessages[0]?.keyboard).toBeUndefined();
  });

  it("keeps the keyboard when the rejection is a content-moderation error", async () => {
    const api = new FakeQQOfficialAPI();
    api.failPrivateKeyboardMessages = true;
    // 真机现象：群规则卡片把违规词列在正文/按钮里 → 400「消息内容违规」
    api.keyboardRejectionMessage = "QQ official API error 400: 消息内容违规";
    const sender = new RichMessageSender(api);

    const result = await sender.sendToUser("u1", menuMessage);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("markdown");
    // 内容类错误只跳过这一条；不能据此断定「平台不支持按钮」（否则该目标后续卡片全丢按钮）
    expect(sender.keyboardAvailableFor("user")).toBe(true);
    expect(sender.keyboardAvailableFor("group")).toBe(true);
  });

  it("classifies keyboard rejections", () => {
    expect(classifyKeyboardFailure("QQ official API error 400: 消息内容违规")).toBe("content");
    expect(classifyKeyboardFailure("QQ official API error 400: 沙箱环境不能访问此资源")).toBe("sandbox");
    expect(classifyKeyboardFailure("QQ official API error 403: 应用无接口访问权限")).toBe("permission");
    expect(classifyKeyboardFailure("QQ official API error 400: 键盘不支持")).toBe("unsupported");
  });

  it("reports failure when every channel fails", async () => {
    const api = new FakeQQOfficialAPI();
    api.failPrivateMessages = true;
    const sender = new RichMessageSender(api);

    const result = await sender.replyToUser(
      "u1",
      { markdown: "## x", text: "x" },
      { msgId: "m1" },
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("none");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("sends plain text where inline mentions (@user / @everyone) can work", async () => {
    const api = new FakeQQOfficialAPI();
    const sender = new RichMessageSender(api);

    const plain = await sender.sendPlainToGroup("g1", "hello <@!u1>");
    expect(plain).toMatchObject({ ok: true, mode: "text" });
    // 纯文本通道不带 markdown，提及才会被官方解析
    expect(api.sentMessages[0]).toMatchObject({ groupId: "g1", content: "hello <@!u1>" });
    expect(api.sentMessages[0]?.markdown).toBeUndefined();

    await expect(sender.sendPlainToUser("u1", "@everyone")).resolves.toMatchObject({
      ok: true,
      mode: "text",
    });
    expect(api.sentPrivateMessages[0]).toMatchObject({
      userOpenid: "u1",
      content: "@everyone",
    });

    api.failGroupMessages = true;
    const failed = await sender.sendPlainToGroup("g1", "x");
    expect(failed.ok).toBe(false);
    expect(failed.mode).toBe("none");
    expect(failed.detail).toContain("fake group message failure");
  });
});
