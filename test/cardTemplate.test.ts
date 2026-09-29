import { describe, expect, it } from "vitest";

import {
  buildKeyboard,
  CARD_MODAL_ACTION_MAX,
  CARD_MODAL_CONTENT_MAX,
  escapeCardText,
  renderCard,
} from "../src/services/cardTemplate.js";

describe("cardTemplate", () => {
  it("renders markdown, keyboard and plain text from one spec", () => {
    const message = renderCard({
      title: "系统菜单",
      lines: ["**用户**：10001"],
      rows: [[{ id: "sys", label: "系统菜单", command: "/menu sys" }]],
        footer: ["按钮不可用时可手输指令。"],
    });

    expect(message.markdown).toContain("## 系统菜单");
    expect(message.markdown).toContain("**用户**：10001");
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

  /**
   * 真机事故回归：`/migrate` 的二次确认弹窗文案 49 字，超过官方 `action.modal.content`
   * 的 40 字上限 → 官方判整个 payload 非法 → **整张卡片的按钮全部消失**
   * （用户看到「卡片上什么按钮都没有」，而其它弹窗都在限额内、一切正常）。
   */
  it("clamps over-long modal texts instead of losing the whole keyboard", () => {
    const message = renderCard({
      title: "t",
      rows: [
        [
          {
            id: "m",
            label: "迁移",
            callbackData: "cb:migrate:run",
            modal: {
              content: "确".repeat(49),
              confirmText: "确认迁移",
              cancelText: "取消",
            },
          },
        ],
      ],
    });

    const action = message.keyboard?.content.rows[0]?.buttons[0]?.action;
    expect(action?.modal?.content).toHaveLength(CARD_MODAL_CONTENT_MAX);
    expect(action?.modal?.content.endsWith("…")).toBe(true);
    // 4 字以内的按钮文字不动
    expect(action?.modal?.confirmText).toBe("确认迁移");
    // 键盘本身必须完好：按钮一个都不能丢
    expect(message.keyboard?.content.rows[0]?.buttons).toHaveLength(1);
    expect(message.keyboard?.content.rows[0]?.buttons[0]?.id).toBe("m");

    // 确认 / 取消文字超 4 字同样裁剪
    const clampedActions = renderCard({
      title: "t",
      rows: [
        [
          {
            id: "m",
            label: "迁移",
            callbackData: "cb:migrate:run",
            modal: {
              content: "确认？",
              confirmText: "确认执行迁移",
              cancelText: "先不要执行",
            },
          },
        ],
      ],
    }).keyboard?.content.rows[0]?.buttons[0]?.action;
    expect(clampedActions?.modal?.confirmText).toHaveLength(CARD_MODAL_ACTION_MAX);
    expect(clampedActions?.modal?.cancelText).toHaveLength(CARD_MODAL_ACTION_MAX);
  });

  it("rejects keyboards outside the project limits", () => {
    const sixRows = Array.from({ length: 6 }, (_value, index) => [
      { id: `row-${index}`, label: "x", command: "/x" },
    ]);
    expect(() => buildKeyboard(sixRows)).toThrow(/at most 5 rows/u);

    // 官方：一行最多 5 个按钮
    const sixButtons = Array.from({ length: 6 }, (_value, index) => ({
      id: `button-${index}`,
      label: "x",
      command: "/x",
    }));
    expect(() => buildKeyboard([sixButtons])).toThrow(/at most 5 buttons/u);

    // 项目标准：一行按钮文字总长 ≤12 字（6+7=13）
    expect(() =>
      buildKeyboard([
        [
          { id: "wide-a", label: "123456", command: "/a" },
          { id: "wide-b", label: "1234567", command: "/b" },
        ],
      ]),
    ).toThrow(/at most 12 label characters/u);

    // 3 个短按钮（2+2+2=6）允许通过
    expect(() =>
      buildKeyboard([
        [
          { id: "a", label: "aa", command: "/a" },
          { id: "b", label: "bb", command: "/b" },
          { id: "c", label: "cc", command: "/c" },
        ],
      ]),
    ).not.toThrow();
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
