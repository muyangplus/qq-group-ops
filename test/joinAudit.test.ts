import { describe, expect, it, beforeEach } from "vitest";

import { AuditStatus, JoinRequestStatus } from "../src/core/enums.js";
import { InMemoryAuditLog } from "../src/services/audit.js";
import { JoinAuditService } from "../src/services/joinAudit.js";

describe("JoinAuditService", () => {
  let auditLog: InMemoryAuditLog;
  let service: JoinAuditService;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
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
});
