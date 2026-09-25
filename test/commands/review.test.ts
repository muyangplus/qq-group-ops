import { JoinRequestStatus } from "../../src/core/enums.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import { JoinRuleEvaluator } from "../../src/services/joinRules.js";
import { MemberRoster } from "../../src/services/memberRoster.js";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  auditLog,
  joinAudit,
  configStore,
  permissions,
  api,
  joinApproval,
  joinSync,
  notifications,
  service,
  withShortCodes,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · review（13 个用例）。
 */

describe("AdminCommandService · review", () => {
  it("requires permission for pending", async () => {
    const result = await service.handle("g1", "member", "/pending");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
  });

  it("lists pending requests for the group", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    joinAudit.submit("g2", "u2", "其他群", "r2");
    const result = await service.handle("g1", "mod", "/pending");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
    expect(result.text).not.toContain("r2");
  });

  it("approves requests", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await service.handle("g1", "admin", "/approve r1");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
  });

  it("rejects requests with reason", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    const result = await service.handle("g1", "admin", "/reject r1 资料不完整");
    expect(result.ok).toBe(true);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Rejected);
    expect(auditLog.all().at(-1)?.reason).toBe("资料不完整");
    expect(api.joinRequestReviews).toEqual([
      {
        groupId: "g1",
        memberOpenid: "u1",
        op: "decline",
        joinRequestId: "r1",
        reason: "资料不完整",
      },
    ]);
  });

  it("keeps the request pending when the official approval fails", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    api.failJoinRequestApprovals = true;

    const result = await service.handle("g1", "admin", "/approve r1");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("审批失败");
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
  });

  it("shows review opinions in /pending when enabled", async () => {
    const evaluator = new JoinRuleEvaluator(
      MemberRoster.fromIndex({
        classes: ["材化2211"],
        majors: ["材料化学"],
        classInfo: {
          材化2211: {
            major: "材料化学",
            college: "化学与生命科学学院",
            year: "2022",
          },
        },
      }),
    );
    const localService = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      joinRules: evaluator,
    });
    configStore.setOverride({
      groupId: "g1",
      joinDecision: "approve_on_match",
      joinRequireClass: true,
      joinRequireName: true,
      joinReviewOpinion: true,
    });
    joinAudit.submit("g1", "u1", "材化2211 张三", "r1");

    const result = await localService.handle("g1", "mod", "/pending");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("审核意见");
    expect(result.text).toContain("材化2211");
    expect(result.text).toContain("姓名 张三");
    expect(result.text).toContain("建议：通过");
  });

  it("hides review opinions when the group disables them", async () => {
    const evaluator = new JoinRuleEvaluator(
      MemberRoster.fromIndex({ classes: ["材化2211"] }),
    );
    const localService = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      joinRules: evaluator,
    });
    configStore.setOverride({ groupId: "g1", joinReviewOpinion: false });
    joinAudit.submit("g1", "u1", "材化2211 张三", "r1");

    const result = await localService.handle("g1", "mod", "/pending");

    expect(result.text).not.toContain("审核意见");
  });

  it("rejects unbound group numbers in private", async () => {
    const result = await service.handle(undefined, "root", "/pending 999999");
    expect(result.ok).toBe(false);
  });

  it("rejects invalid /rules set values", async () => {
    const toggle = await service.handle("g1", "admin", "/rules set autoApprove maybe");
    expect(toggle.ok).toBe(false);
    expect(toggle.text).toContain("需要 on 或 off");

    const field = await service.handle("g1", "admin", "/rules set unknown 1");
    expect(field.ok).toBe(false);
    expect(field.text).toContain("未知字段");

    const missing = await service.handle("g1", "admin", "/rules set keywords");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("/rules set");
  });

  it("syncs pending join requests from the official API", async () => {
    api.addJoinRequest("g1", "u1", "想加入", "r1");

    const result = await service.handle("g1", "mod", "/sync");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("r1");
    expect(joinAudit.pending("g1")).toHaveLength(1);
  });

  it("refuses push subscriptions from users who cannot approve", async () => {
    const moderator = await service.handle("g1", "mod", "/notify on");
    expect(moderator.ok).toBe(false);
    expect(moderator.text).toContain("权限不足");

    const stranger = await service.handle(undefined, "member", "/notify all on");
    expect(stranger.ok).toBe(false);
    expect(stranger.text).toContain("权限不足");
    expect(notifications.listScopes("mod")).toEqual([]);
  });

  it("uses short codes for join requests and approves by short code", async () => {
    const scoped = withShortCodes();
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const pending = await scoped.handle("g1", "admin", "/pending");
    const code = /#[0-9A-Za-z]{6}/u.exec(pending.text)?.[0];
    expect(code).toBeDefined();
    // 不再暴露长申请 id / 内部 user id
    expect(pending.text).not.toContain("r1");
    expect(pending.text).not.toContain("u1");

    const approve = await scoped.handle("g1", "admin", `/approve ${code}`);
    expect(approve.ok).toBe(true);
    expect(approve.text).toContain(code ?? "");
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
  });

  it("renders /pending as a paged card with approve/reject buttons", async () => {
    for (let index = 1; index <= 5; index += 1) {
      joinAudit.submit("g1", `u${index}`, `理由${index}`, `r${index}`);
    }

    const first = await service.handle("g1", "mod", "/pending");
    expect(first.ok).toBe(true);
    expect(first.rich?.markdown).toContain("第 1 / 2 页");
    const firstButtons = (first.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    // 每页 3 条，每条一个「通过」+「拒绝」指令按钮
    expect(
      firstButtons.filter((button) => button.id.startsWith("approve-")),
    ).toHaveLength(3);
    // 「通过」是固定动作 → 回调自动完成；「拒绝」支持可选原因 → 指令按钮
    expect(firstButtons.find((button) => button.id === "approve-r1")?.action).toMatchObject({
      type: 1,
      data: "cb:pending:approve:g1:r1:1",
    });
    expect(firstButtons.find((button) => button.id === "reject-r1")?.action).toMatchObject({
      type: 2,
      data: "/reject r1",
    });
    // 翻页是回调
    expect(firstButtons.find((button) => button.id === "next")?.action).toMatchObject({
      type: 1,
      data: "cb:pending:page:g1:2",
    });
    // 纯文本降级必须能翻页
    expect(first.text).toContain("下一页：/pending +2");

    const second = await service.handle("g1", "mod", "/pending +2");
    expect(second.rich?.markdown).toContain("第 2 / 2 页");
    const secondButtons = (second.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(secondButtons.find((button) => button.id === "prev")?.action).toMatchObject({
      type: 1,
      data: "cb:pending:page:g1:1",
    });
    expect(secondButtons.some((button) => button.id === "next")).toBe(false);
  });
});
