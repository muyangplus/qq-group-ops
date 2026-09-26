import {
  describe,
  expect,
  it,
} from "vitest";
import {
  auditLog,
  joinAudit,
  service,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · audit（3 个用例）。
 */

describe("AdminCommandService · audit", () => {
  it("shows recent audit records", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    await service.handle("g1", "admin", "/approve r1");

    const result = await service.handle("g1", "mod", "/audit");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("approve_join_request");
    // 操作人已绑定 → 显示 QQ号；申请人未绑定 → 回退 openid
    expect(result.text).toContain("by 10003");
    expect(result.text).toContain("→ u1");
  });

  it("limits and filters audit records per group", async () => {
    auditLog.append({
      recordId: "old",
      groupId: "g1",
      actorId: "admin",
      action: "manual_old",
      status: "executed",
      reason: "",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    auditLog.append({
      recordId: "new",
      groupId: "g1",
      actorId: "admin",
      action: "manual_new",
      status: "executed",
      reason: "",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    auditLog.append({
      recordId: "other",
      groupId: "g2",
      actorId: "admin",
      action: "other_group",
      status: "executed",
      reason: "",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    const result = await service.handle("g1", "mod", "/audit 1");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("manual_new");
    expect(result.text).not.toContain("manual_old");
    expect(result.text).not.toContain("other_group");
  });

  it("renders /audit as a button-paged card", async () => {
    for (let index = 1; index <= 25; index += 1) {
      auditLog.append({
        recordId: `a${index}`,
        groupId: "g1",
        actorId: "member",
        targetUserId: undefined,
        action: "moderation:warn",
        status: "executed",
        reason: "",
        createdAt: new Date(2026, 0, 1, 0, index),
      });
    }

    // 默认每页 5 条（§卡片规范 v2）→ 25 条共 5 页
    const first = await service.handle("g1", "mod", "/audit");
    expect(first.ok).toBe(true);
    expect(first.rich?.markdown).toContain("第 1 / 5 页");
    expect(first.rich?.markdown).toContain("共 25 条");
    const buttons = (first.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(buttons.find((button) => button.id === "next")?.action).toMatchObject({
      type: 1,
      data: "cb:audit:page:g1:5:2",
    });
    // §卡片规范 v2：翻页由按钮承担，卡片里不再出现等价指令
    expect(first.text).not.toContain("下一页：/audit");

    const second = await service.handle("g1", "mod", "/audit +2");
    expect(second.rich?.markdown).toContain("第 2 / 5 页");
  });
});
