import { describe, expect, it, beforeEach } from "vitest";

import { AuditStatus, JoinRequestStatus } from "../src/core/enums.js";
import { AuditLogStore } from "../src/services/audit.js";
import { JoinAuditService } from "../src/services/joinAudit.js";

describe("JoinAuditService", () => {
  let auditLog: AuditLogStore;
  let service: JoinAuditService;

  beforeEach(() => {
    auditLog = new AuditLogStore();
    service = new JoinAuditService(auditLog);
  });

  it("creates a pending request", () => {
    const request = service.submit("g1", "u1", "想加入", "r1");
    expect(request.status).toBe(JoinRequestStatus.Pending);
    expect(service.pending("g1")).toEqual([request]);
    expect(service.pending("g2")).toEqual([]);
  });

  it("approves and writes audit log", () => {
    service.submit("g1", "u1", "想加入", "r1");
    const updated = service.approve("r1", "admin");
    expect(updated.status).toBe(JoinRequestStatus.Approved);
    expect(updated.reviewerId).toBe("admin");
    expect(updated.reviewedAt).toBeInstanceOf(Date);
    const records = auditLog.all();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe(AuditStatus.Approved);
    expect(records[0]?.targetUserId).toBe("u1");
  });

  it("rejects and records reason", () => {
    service.submit("g1", "u1", "想加入", "r1");
    const updated = service.reject("r1", "admin", "资料不完整");
    expect(updated.status).toBe(JoinRequestStatus.Rejected);
    expect(auditLog.all()[0]?.reason).toBe("资料不完整");
  });

  it("rejects double review", () => {
    service.submit("g1", "u1", "想加入", "r1");
    service.approve("r1", "admin");
    expect(() => service.approve("r1", "admin")).toThrow(/already reviewed/u);
  });

  it("throws for unknown request", () => {
    expect(() => service.approve("missing", "admin")).toThrow(/not found/u);
  });

  it("expires pending requests past the TTL and keeps them traceable", () => {
    service.submit("g1", "u1", "想加入", "r1");
    const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1_000;

    expect(service.expireStalePending(eightDaysLater)).toBe(1);

    // 不再进队列，但记录与审计仍可追溯
    expect(service.pending("g1")).toEqual([]);
    const request = service.get("r1");
    expect(request.status).toBe(JoinRequestStatus.Expired);
    expect(request.reviewedAt).toBeInstanceOf(Date);
    const records = auditLog.all();
    expect(records[0]?.action).toBe("expire_join_request");
    expect(records[0]?.status).toBe(AuditStatus.Expired);
  });

  it("does not expire when the TTL is disabled", () => {
    service.setPendingTtlMs(0);
    service.submit("g1", "u1", "想加入", "r1");

    expect(
      service.expireStalePending(Date.now() + 365 * 24 * 60 * 60 * 1_000),
    ).toBe(0);
    expect(service.pending("g1")).toHaveLength(1);
  });

  it("reconciles with the official list, skipping fresh requests", () => {
    service.submit("g1", "u1", "想加入", "r1");

    // 刚提交的申请：官方列表暂时没有也不能判过期（分页/滞后）
    expect(
      service.expireMissingFromRemote("g1", new Set(), { now: Date.now() + 60_000 }),
    ).toBe(0);
    expect(service.pending("g1")).toHaveLength(1);

    // 官方列表里仍然有 → 不过期
    expect(
      service.expireMissingFromRemote("g1", new Set(["r1"]), {
        now: Date.now() + 2 * 60 * 60 * 1_000,
      }),
    ).toBe(0);

    // 官方列表里没有、且已存在超过 1 小时 → 过期
    expect(
      service.expireMissingFromRemote("g1", new Set(), {
        now: Date.now() + 2 * 60 * 60 * 1_000,
      }),
    ).toBe(1);
    expect(service.pending("g1")).toEqual([]);
    expect(service.get("r1").status).toBe(JoinRequestStatus.Expired);
  });
});
