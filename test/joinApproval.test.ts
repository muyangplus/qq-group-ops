import { describe, expect, it, beforeEach } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { JoinRequestStatus } from "../src/core/enums.js";
import { AuditLogStore } from "../src/services/audit.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";

describe("JoinApprovalService", () => {
  let api: FakeQQOfficialAPI;
  let auditLog: AuditLogStore;
  let joinAudit: JoinAuditService;
  let configStore: GroupConfigStore;
  let service: JoinApprovalService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    auditLog = new AuditLogStore();
    joinAudit = new JoinAuditService(auditLog);
    configStore = new GroupConfigStore({ groupId: "__default__" });
    service = new JoinApprovalService(api, joinAudit, configStore);
  });

  it("calls the official API before approving locally", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const result = await service.approve("g1", "r1", "admin");

    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
    expect(result.status).toBe(JoinRequestStatus.Approved);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
    expect(auditLog.all().at(-1)?.action).toBe("approve_join_request");
  });

  it("passes the rejection reason to the official API and the audit trail", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const result = await service.reject("g1", "r1", "admin", "资料不完整");

    expect(api.joinRequestReviews).toEqual([
      {
        groupId: "g1",
        memberOpenid: "u1",
        op: "decline",
        joinRequestId: "r1",
        reason: "资料不完整",
      },
    ]);
    expect(result.status).toBe(JoinRequestStatus.Rejected);
    expect(auditLog.all().at(-1)?.reason).toBe("资料不完整");
  });

  it("compacts a multi-line custom reject reason into one line and caps its length", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");

    await service.reject("g1", "r1", "admin", "资料不完整\n请补齐后重新申请");

    // 审核员手写的自由文本同样要压成单行（官方 reject_reason 是单行字段）
    expect(api.joinRequestReviews[0]?.reason).toBe("资料不完整；请补齐后重新申请");
    expect(auditLog.all().at(-1)?.reason).toBe("资料不完整；请补齐后重新申请");

    joinAudit.submit("g1", "u2", "想加入", "r2");
    await service.reject("g1", "r2", "admin", "很".repeat(200));
    const long = api.joinRequestReviews[1]?.reason ?? "";
    expect(long).toHaveLength(121); // 120 字 + 省略号
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves local state untouched when the official call fails", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    api.failJoinRequestApprovals = true;

    await expect(service.approve("g1", "r1", "admin")).rejects.toThrow(
      /fake approval failure/u,
    );

    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
    expect(auditLog.all()).toEqual([]);
  });

  it("rejects requests that belong to another group", async () => {
    joinAudit.submit("g2", "u1", "想加入", "r1");

    await expect(service.approve("g1", "r1", "admin")).rejects.toThrow(
      /does not belong/u,
    );
    expect(api.joinRequestReviews).toEqual([]);
  });

  it("does not auto approve unless the group config enables it", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");

    const outcome = await service.applyJoinRules("g1", "r1");

    expect(outcome.action).toBe("manual");
    expect(api.joinRequestReviews).toEqual([]);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
  });

  it("auto approves when the group config enables it", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    configStore.setOverride({ groupId: "g1", autoApproveJoin: true });

    const outcome = await service.applyJoinRules("g1", "r1");

    expect(outcome.action).toBe("approve");
    expect(api.joinRequestReviews).toEqual([
      { groupId: "g1", memberOpenid: "u1", op: "approve", joinRequestId: "r1" },
    ]);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Approved);
    expect(auditLog.all().at(-1)?.actorId).toBe("bot:auto");
  });

  it("keeps the request pending when auto approve fails", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    configStore.setOverride({ groupId: "g1", autoApproveJoin: true });
    api.failJoinRequestApprovals = true;

    await expect(service.applyJoinRules("g1", "r1")).resolves.toMatchObject({
      action: "manual",
    });
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
  });

  /**
   * 真机现象（2026-10-04）：点「通过」收到 `QQ official API error 400: 申请已经被处理`
   * —— 那条申请在群管理后台 / 别的机器人那边已经处理过了，官方那边已经没有它；
   * 但本地一直挂在待审批里（`markHandledExternally` 写好了却没接线），于是每条都点一下报一次错。
   * 现在：官方这么说 → 本地**立即**移出待审批（`expired` + `expire_join_request` 审计）+ 人话回执。
   */
  it("官方说「申请已经被处理」→ 自动移出待审批、写 expire 审计、回人话", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    api.approveJoinRequest = async () => {
      throw new Error("QQ official API error 400: 申请已经被处理");
    };

    await expect(service.approve("g1", "r1", "admin")).rejects.toThrow(
      /已经处理过了/u,
    );

    expect(joinAudit.pending("g1")).toEqual([]);
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Expired);
    const expiry = auditLog.all().at(-1);
    expect(expiry?.action).toBe("expire_join_request");
    expect(expiry?.reason).toContain("已被处理");
  });

  it("拒绝时同理；其它官方错误仍然保持待审批（可以重试）", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    joinAudit.submit("g1", "u2", "想加入", "r2");
    api.approveJoinRequest = async (_groupId, memberOpenid) => {
      if (memberOpenid === "u1") {
        throw new Error("QQ official API error 400: 申请已经被处理");
      }
      throw new Error("QQ official API error 500: 服务器开小差");
    };

    await expect(service.reject("g1", "r1", "admin")).rejects.toThrow(
      /已经处理过了/u,
    );
    await expect(service.reject("g1", "r2", "admin")).rejects.toThrow(/开小差/u);

    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Expired);
    // 临时故障不能顺手把申请清掉 —— 它还得能被重试
    expect(joinAudit.get("r2").status).toBe(JoinRequestStatus.Pending);
  });

  it("自动决策遇到「已经被处理」：不推给审核员，本地直接清掉", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    configStore.setOverride({ groupId: "g1", autoApproveJoin: true });
    api.approveJoinRequest = async () => {
      throw new Error("QQ official API error 400: 申请已经被处理");
    };

    const outcome = await service.applyJoinRules("g1", "r1");

    expect(outcome.action).toBe("manual");
    expect(outcome.notify).toBe(false);
    expect(joinAudit.pending("g1")).toEqual([]);
  });

  it("识别「已经被处理」不会误伤限流 / 超时这类可重试错误", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    api.approveJoinRequest = async () => {
      throw new Error("QQ official API error 100017: 接口频率限制");
    };

    await expect(service.approve("g1", "r1", "admin")).rejects.toThrow(
      /频率限制/u,
    );
    expect(joinAudit.get("r1").status).toBe(JoinRequestStatus.Pending);
    expect(auditLog.all()).toEqual([]);
  });

  it("only notifies auto decisions when notifyAutoApproved is on", async () => {
    joinAudit.submit("g1", "u1", "想加入", "r1");
    configStore.setOverride({ groupId: "g1", autoApproveJoin: true });

    // 默认：自动通过不通知审核员
    const silent = await service.applyJoinRules("g1", "r1");
    expect(silent).toMatchObject({ action: "approve", notify: false });

    // 开启后：自动通过也通知
    joinAudit.submit("g1", "u2", "想加入", "r2");
    configStore.setOverride({ groupId: "g1", notifyAutoApproved: true });
    const notified = await service.applyJoinRules("g1", "r2");
    expect(notified).toMatchObject({ action: "approve", notify: true });

    // 需要人工处理时永远通知
    joinAudit.submit("g1", "u3", "想加入", "r3");
    configStore.setOverride({
      groupId: "g1",
      autoApproveJoin: false,
      joinDecision: "manual",
    });
    const manual = await service.applyJoinRules("g1", "r3");
    expect(manual).toMatchObject({ action: "manual", notify: true });
  });
});
