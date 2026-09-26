import { describe, expect, it } from "vitest";

import { renderCard } from "../src/services/cardTemplate.js";
import { alreadyMentioned, withGroupMention } from "../src/services/groupMention.js";

/**
 * §F1：群内回复首行 @ 发起人（只在卡片 markdown 里加，纯文本降级不加）。
 */
describe("groupMention", () => {
  it("prepends the mention to card markdown only", () => {
    const card = renderCard({ title: "常用菜单", lines: ["**权限**：群成员"] });

    const mentioned = withGroupMention(card, "u1");

    expect(mentioned.markdown).toBe(`<@!u1>\n${card.markdown}`);
    // 纯文本 content 通道不支持提及，不写进去
    expect(mentioned.text).toBe(card.text);
    expect(mentioned.keyboard).toEqual(card.keyboard);
    // 不改原对象
    expect(card.markdown.startsWith("<@!")).toBe(false);
  });

  it("keeps cards that already mention someone", () => {
    const card = renderCard({
      title: "黑名单",
      lines: ["<@!u1>", "**结果**：已解除"],
    });

    expect(withGroupMention(card, "u1")).toEqual(card);
    expect(withGroupMention(card, "u2")).toEqual(card);
  });

  it("detects a mention on the first content line after the title", () => {
    expect(alreadyMentioned("## 标题\n<@!u1>\n正文")).toBe(true);
    // 纯文本通知：第一行就是提及
    expect(alreadyMentioned("<@!u1>\n私信发送失败")).toBe(true);
    expect(alreadyMentioned("## 标题\n**用户**：10001")).toBe(false);
  });

  it("ignores empty user ids", () => {
    const card = renderCard({ title: "常用菜单" });
    expect(withGroupMention(card, "   ")).toEqual(card);
  });
});
