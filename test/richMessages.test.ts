import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import {
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
  });

  it("stops using the keyboard after the platform rejects it", async () => {
    const api = new FakeQQOfficialAPI();
    api.failPrivateKeyboardMessages = true;
    const sender = new RichMessageSender(api);

    const result = await sender.sendToUser("u1", menuMessage);

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("markdown");
    expect(result.detail).toBe("markdown_fallback");
    expect(sender.keyboardAvailable).toBe(false);
    expect(api.sentPrivateMessages[0]?.keyboard).toBeUndefined();
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
});
