import { describe, expect, it } from "vitest";

import {
  buildKeyboard,
  escapeCardText,
  renderCard,
} from "../src/services/cardTemplate.js";

describe("cardTemplate", () => {
  it("renders markdown, keyboard and plain text from one spec", () => {
    const message = renderCard({
      title: "系统菜单",
      lines: ["**用户**：10001"],
      rows: [[{ id: "sys", label: "系统菜单", command: "/menu sys" }]],
      buttonHint: "请选择入口：",
      footer: ["按钮不可用时可手输指令。"],
    });

    expect(message.markdown).toContain("## 系统菜单");
    expect(message.markdown).toContain("**用户**：10001");
    expect(message.markdown).toContain("请选择入口：");
    expect(message.markdown).toContain("按钮不可用时可手输指令。");
    expect(message.markdown).not.toContain("/menu sys");

    expect(message.keyboard?.content.rows[0]?.buttons[0]?.action).toMatchObject({
      type: 2,
      data: "/menu sys",
      enter: true,
      reply: false,
    });

    expect(message.text).toContain("【系统菜单】");
    expect(message.text).toContain("用户：10001");
    expect(message.text).toContain("系统菜单：/menu sys");
  });

  it("omits the keyboard when there are no buttons", () => {
    const message = renderCard({ title: "提示", lines: ["没有按钮"] });
    expect(message.keyboard).toBeUndefined();
    expect(message.text).toContain("【提示】");
    expect(message.text).not.toContain("可用指令");
  });

  it("clamps long labels", () => {
    const message = renderCard({
      title: "t",
      rows: [[{ id: "a", label: "这是一个很长的按钮文字", command: "/x" }]],
    });
    expect(message.keyboard?.content.rows[0]?.buttons[0]?.label).toHaveLength(10);
  });

  it("rejects keyboards outside the official limits", () => {
    const sixRows = Array.from({ length: 6 }, (_value, index) => [
      { id: `row-${index}`, label: "x", command: "/x" },
    ]);
    expect(() => buildKeyboard(sixRows)).toThrow(/at most 5 rows/u);

    const sixButtons = Array.from({ length: 6 }, (_value, index) => ({
      id: `button-${index}`,
      label: "x",
      command: "/x",
    }));
    expect(() => buildKeyboard([sixButtons])).toThrow(/at most 5 buttons/u);
  });

  it("rejects duplicated button ids", () => {
    expect(() =>
      buildKeyboard([
        [
          { id: "dup", label: "a", command: "/a" },
          { id: "dup", label: "b", command: "/b" },
        ],
      ]),
    ).toThrow(/duplicated/u);
  });

  it("supports callback buttons and rejects ambiguous ones", () => {
    const message = renderCard({
      title: "翻页",
      rows: [[{ id: "next", label: "下一页", callbackData: "testmenu:page:2" }]],
    });
    expect(message.keyboard?.content.rows[0]?.buttons[0]?.action).toMatchObject({
      type: 1,
      data: "testmenu:page:2",
    });
    // 回调按钮没有可复制的指令文本，纯文本降级里不列「可用指令」
    expect(message.text).not.toContain("可用指令");

    expect(() => buildKeyboard([[{ id: "bad", label: "x" }]])).toThrow(/二选一/u);
    expect(() =>
      buildKeyboard([
        [{ id: "bad", label: "x", command: "/a", callbackData: "b" }],
      ]),
    ).toThrow(/二选一/u);
  });

  it("escapes markdown-breaking characters", () => {
    expect(escapeCardText("广告 #1\n*加粗*")).toBe("广告 \\#1 \\*加粗\\*");
    expect(escapeCardText("x".repeat(300))).toHaveLength(200);
  });
});
