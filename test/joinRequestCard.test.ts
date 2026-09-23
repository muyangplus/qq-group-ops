import { describe, expect, it } from "vitest";

import { NotificationDeliveryStatus } from "../src/core/enums.js";
import {
  buildJoinRequestCard,
  renderJoinRequestCardText,
} from "../src/services/joinRequestCard.js";

describe("join request card", () => {
  const input = {
    groupId: "g1",
    groupNumber: "654321",
    requestId: "r1",
    userId: "u1",
    reason: "材化2211 张三",
    recipientId: "admin",
  };

  it("builds markdown with approve/reject command buttons", () => {
    const card = buildJoinRequestCard(input);

    expect(card.markdown).toContain("## 新的入群申请");
    expect(card.markdown).toContain("654321（g1）");
    expect(card.markdown).toContain("材化2211 张三");

    const buttons = card.keyboard?.content.rows[0]?.buttons ?? [];
    expect(buttons.map((button) => button.label)).toEqual(["同意", "拒绝"]);
    expect(buttons[0]?.action.data).toBe("/approve g1 r1");
    expect(buttons[1]?.action.data).toBe("/reject g1 r1 审核未通过");
    // 指令按钮：点击即发送指令，并限制只有接收者能点
    expect(buttons[0]?.action.type).toBe(2);
    expect(buttons[0]?.action.enter).toBe(true);
    expect(buttons[0]?.action.permission).toEqual({
      type: 0,
      specifyUserIds: ["admin"],
    });
    expect(buttons[0]?.action.modal?.content).toContain("确认");
  });

  it("includes the rule-engine opinion as a quote", () => {
    const card = buildJoinRequestCard({
      ...input,
      opinion: "审核意见（按当前入群规则自动生成）：\n  识别到：姓名 张三\n  建议：通过",
    });
    expect(card.markdown).toContain("> 审核意见（按当前入群规则自动生成）：");
    expect(card.markdown).toContain("> 建议：通过");
  });

  it("omits buttons when they are disabled", () => {
    const card = buildJoinRequestCard({ ...input, withButtons: false });
    expect(card.keyboard).toBeUndefined();
    expect(card.markdown).toContain("/approve g1 r1");
  });

  it("escapes markdown-breaking characters in the answer", () => {
    const card = buildJoinRequestCard({
      ...input,
      reason: "*加粗* #\n# 标题",
    });
    expect(card.markdown).toContain("\\*加粗\\* \\# \\# 标题");
  });

  it("renders a plain text fallback with the same commands", () => {
    const text = renderJoinRequestCardText({
      ...input,
      opinion: "建议：人工核实",
    });
    expect(text).toContain("【新的入群申请】");
    expect(text).toContain("同意：/approve g1 r1");
    expect(text).toContain("拒绝：/reject g1 r1 [原因]");
    expect(text).toContain("建议：人工核实");
  });

  it("keeps delivery status values stable", () => {
    expect(NotificationDeliveryStatus.Sent).toBe("sent");
    expect(NotificationDeliveryStatus.Failed).toBe("failed");
  });
});
