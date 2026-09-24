import { describe, expect, it } from "vitest";

import { NotificationDeliveryStatus } from "../src/core/enums.js";
import {
  buildJoinRequestCard,
  JOIN_REJECT_PRESETS,
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

  it("builds markdown with quick approve/reject buttons", () => {
    const card = buildJoinRequestCard(input);

    expect(card.markdown).toContain("## 新的入群申请");
    // 群号已绑定 → 只显示群号，不显示 group_openid
    expect(card.markdown).toContain("**群**：654321");
    expect(card.markdown).not.toContain("g1");
    expect(card.markdown).toContain("材化2211 张三");
    expect(card.markdown).toContain("**申请ID**：r1");
    expect(card.markdown).toContain("请审核：点击下方按钮。");
    // 有按钮时正文不再堆完整指令（太长），指令只放在按钮数据里
    expect(card.markdown).not.toContain("/approve");
    expect(card.markdown).not.toContain("/reject");

    const rows = card.keyboard?.content.rows ?? [];
    expect(rows[0]?.buttons.map((button) => button.label)).toEqual([
      "同意",
      "拒绝",
    ]);
    expect(rows[1]?.buttons.map((button) => button.label)).toEqual([
      "回答错误",
      "班级姓名",
    ]);

    const approve = rows[0]!.buttons[0]!;
    // 指令里的群参数用展示名（这里是已绑定群号），申请单号用传入的短码/ID
    expect(approve.action.data).toBe("/approve r1");
    // 指令按钮：点击即发送指令，并限制只有接收者能点
    expect(approve.action.type).toBe(2);
    expect(approve.action.enter).toBe(true);
    expect(approve.action.permission).toEqual({
      type: 0,
      specifyUserIds: ["admin"],
    });
    expect(approve.action.modal?.content).toContain("确认");
  });

  it("uses the red style for every reject button", () => {
    const card = buildJoinRequestCard(input);
    const rows = card.keyboard?.content.rows ?? [];
    const rejectButtons = [rows[0]!.buttons[1]!, ...rows[1]!.buttons];

    for (const button of rejectButtons) {
      // 官方样式 3 = 白色背景 + 红色字体（唯一的红色按钮样式）
      expect(button.style).toBe(3);
      expect(button.visitedLabel).toBe("已拒绝");
      expect(button.action.type).toBe(2);
      expect(button.action.enter).toBe(true);
    }
    expect(rows[0]!.buttons[0]!.style).toBe(1);
  });

  it("sends the preset reject reasons as the rejection reason", () => {
    const card = buildJoinRequestCard(input);
    const presetButtons = card.keyboard?.content.rows[1]?.buttons ?? [];

    expect(presetButtons[0]?.action.data).toBe("/reject r1 请正确回答问题。");
    expect(presetButtons[1]?.action.data).toBe(
      "/reject r1 请回答正确的班级姓名（如：环工2214小明）。",
    );
    expect(JOIN_REJECT_PRESETS.map((preset) => preset.label)).toEqual([
      "回答错误",
      "班级姓名",
    ]);
  });

  it("shows a bound applicant QQ number instead of the openid", () => {
    const card = buildJoinRequestCard({ ...input, applicantQq: "123456" });

    expect(card.markdown).toContain("**申请人**：123456");
    expect(card.markdown).not.toContain("u1");
    // 按钮数据仍然使用 openid（指令必须用官方 id）
    const buttons = card.keyboard?.content.rows[0]?.buttons ?? [];
    expect(buttons[0]?.action.data).toBe("/approve r1");
  });

  it("shows the applicant nickname and the admin Q&A question", () => {
    const card = buildJoinRequestCard({
      ...input,
      applicantName: "小明",
      questions: ["请回答班级+姓名", "你的专业"],
    });
    expect(card.markdown).toContain("**申请人**：u1（小明）");
    expect(card.markdown).toContain("**入群问题**：请回答班级+姓名 / 你的专业");

    const text = renderJoinRequestCardText({
      ...input,
      applicantName: "小明",
      questions: ["请回答班级+姓名"],
    });
    expect(text).toContain("申请人：u1（小明）");
    expect(text).toContain("入群问题：请回答班级+姓名");
  });

  it("renders an informational card without buttons for auto-decided requests", () => {
    const approved = buildJoinRequestCard({
      ...input,
      decision: "auto_approved",
    });
    expect(approved.keyboard).toBeUndefined();
    expect(approved.markdown).toContain("**处理结果**：已自动通过（按入群规则）");
    expect(approved.markdown).toContain("该申请已由机器人自动处理，无需操作。");
    expect(approved.markdown).not.toContain("/approve");

    const rejected = buildJoinRequestCard({
      ...input,
      decision: "auto_rejected",
    });
    expect(rejected.keyboard).toBeUndefined();
    expect(rejected.markdown).toContain("**处理结果**：已自动拒绝（按入群规则）");

    const text = renderJoinRequestCardText({
      ...input,
      decision: "auto_approved",
    });
    expect(text).toContain("处理结果：已自动通过（按入群规则）");
    expect(text).not.toContain("/approve");
  });

  it("includes the rule-engine opinion as a quote", () => {
    const card = buildJoinRequestCard({
      ...input,
      opinion: "审核意见（按当前入群规则自动生成）：\n  识别到：姓名 张三\n  建议：通过",
    });
    expect(card.markdown).toContain("> 审核意见（按当前入群规则自动生成）：");
    expect(card.markdown).toContain("> 建议：通过");
  });

  it("falls back to text commands with the presets when buttons are disabled", () => {
    const card = buildJoinRequestCard({ ...input, withButtons: false });
    expect(card.keyboard).toBeUndefined();
    expect(card.markdown).toContain("**申请ID**：r1");
    expect(card.markdown).toContain("请审核（按钮不可用，可直接发送指令）：");
    // 文本里的指令用已绑定的群号（同样能被 /approve、/reject 解析）
    expect(card.markdown).toContain("同意：/approve r1");
    expect(card.markdown).toContain("拒绝：/reject r1 [原因]");
    expect(card.markdown).toContain(
      "回答错误：/reject r1 请正确回答问题。",
    );
    expect(card.markdown).toContain(
      "班级姓名：/reject r1 请回答正确的班级姓名（如：环工2214小明）。",
    );
    expect(card.markdown).not.toContain("/reject 654321");
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
    expect(text).toContain("申请ID：r1");
    expect(text).toContain("同意：/approve r1");
    // 统一模板的纯文本降级直接列出每个按钮对应的完整指令（不再有 [原因] 占位符）
    expect(text).toContain("拒绝：/reject r1 审核未通过");
    expect(text).toContain("回答错误：/reject r1 请正确回答问题。");
    expect(text).toContain(
      "班级姓名：/reject r1 请回答正确的班级姓名（如：环工2214小明）。",
    );
    expect(text).toContain("建议：人工核实");
  });

  it("keeps delivery status values stable", () => {
    expect(NotificationDeliveryStatus.Sent).toBe("sent");
    expect(NotificationDeliveryStatus.Failed).toBe("failed");
  });
});
