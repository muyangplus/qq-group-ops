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
});
