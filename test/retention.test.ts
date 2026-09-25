import { describe, expect, it } from "vitest";

import type { Scheduler } from "../src/adapters/reconnectingWebSocketGateway.js";
import { AuditStatus, JoinRequestStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import type { AuditRecord } from "../src/core/models.js";
import type { AuditRepository } from "../src/db/auditRepository.js";
import { AuditLogStore } from "../src/services/audit.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { RetentionService } from "../src/services/retention.js";

class FakeAuditRepository implements AuditRepository {
  public readonly deletedCutoffs: Date[] = [];
  public readonly records: AuditRecord[] = [];

  public async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  public async findByGroup(groupId: string): Promise<AuditRecord[]> {
    return this.records.filter((record) => record.groupId === groupId);
  }

  public async findAll(): Promise<AuditRecord[]> {
    return [...this.records];
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    this.deletedCutoffs.push(cutoff);
  }
}

class FakeScheduler implements Scheduler {
  public readonly callbacks: Array<{ callback: () => void; delayMs: number }> = [];

  public setTimeout(callback: () => void, delayMs: number): unknown {
    this.callbacks.push({ callback, delayMs });
    return this.callbacks.length;
  }

  public clearTimeout(handle: unknown): void {
    const index = Number(handle) - 1;
    if (index >= 0 && index < this.callbacks.length) {
      this.callbacks.splice(index, 1);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function record(recordId: string, ageDays: number, now: number): AuditRecord {
  return {
    recordId,
    groupId: "g1",
    actorId: "admin",
    action: "manual",
    status: AuditStatus.Executed,
    reason: "",
    createdAt: new Date(now - ageDays * DAY_MS),
  };
}

describe("RetentionService", () => {
  it("prunes expired audit records from memory and the database", async () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const repository = new FakeAuditRepository();
    const auditLog = new AuditLogStore(repository);
    auditLog.append(record("old", 200, now));
    auditLog.append(record("fresh", 10, now));
    const joinAudit = new JoinAuditService();
    const service = new RetentionService(auditLog, joinAudit, {
      auditLogRetentionDays: 180,
      joinRequestRetentionDays: 180,
      clock: () => now,
    });

    const result = await service.runOnce();
    await auditLog.flush();

    expect(result.auditRecordsRemoved).toBe(1);
    expect(auditLog.all().map((item) => item.recordId)).toEqual(["fresh"]);
    expect(repository.deletedCutoffs).toHaveLength(1);
    expect(repository.deletedCutoffs[0]?.toISOString()).toBe(
      new Date(now - 180 * DAY_MS).toISOString(),
    );
  });

  it("keeps pending join requests and removes reviewed ones", async () => {
    const auditLog = new AuditLogStore();
    const joinAudit = new JoinAuditService(auditLog);
    joinAudit.submit("g1", "u1", "pending", "pending");
    joinAudit.submit("g1", "u2", "reviewed", "reviewed");
    joinAudit.approve("reviewed", "admin");

    // 把“现在”往后拨 400 天，让已审批申请超过保留期
    const service = new RetentionService(auditLog, joinAudit, {
      auditLogRetentionDays: 180,
      joinRequestRetentionDays: 180,
      clock: () => utcNow().getTime() + 400 * DAY_MS,
    });

    const result = await service.runOnce();

    expect(result.joinRequestsRemoved).toBe(1);
    expect(joinAudit.pending("g1")).toHaveLength(1);
    expect(() => joinAudit.get("reviewed")).toThrow(/not found/u);
  });

  it("does not prune anything when retention is disabled", async () => {
    const now = utcNow().getTime();
    const auditLog = new AuditLogStore();
    auditLog.append(record("very-old", 10_000, now));
    const joinAudit = new JoinAuditService();
    const service = new RetentionService(auditLog, joinAudit, {
      auditLogRetentionDays: 0,
      joinRequestRetentionDays: 0,
      clock: () => now,
    });

    const result = await service.runOnce();

    expect(result).toEqual({
      auditRecordsRemoved: 0,
      joinRequestsRemoved: 0,
      notificationsRemoved: 0,
      activityNotificationsRemoved: 0,
      joinRequestsExpired: 0,
    });
    expect(auditLog.all()).toHaveLength(1);
  });

  it("expires pending join requests past the TTL", async () => {
    const auditLog = new AuditLogStore();
    const joinAudit = new JoinAuditService(auditLog);
    joinAudit.submit("g1", "u1", "待审批", "pending");

    // 把“现在”往后拨 8 天，默认 TTL 7 天
    const service = new RetentionService(auditLog, joinAudit, {
      auditLogRetentionDays: 180,
      joinRequestRetentionDays: 180,
      joinRequestTtlDays: 7,
      clock: () => utcNow().getTime() + 8 * DAY_MS,
    });

    const result = await service.runOnce();

    expect(result.joinRequestsExpired).toBe(1);
    expect(joinAudit.pending("g1")).toEqual([]);
    expect(joinAudit.get("pending").status).toBe(JoinRequestStatus.Expired);
  });

  it("schedules periodic runs and stops cleanly", async () => {
    const scheduler = new FakeScheduler();
    const auditLog = new AuditLogStore();
    const service = new RetentionService(auditLog, new JoinAuditService(), {
      auditLogRetentionDays: 180,
      joinRequestRetentionDays: 180,
      intervalMs: 1_000,
      scheduler,
    });

    service.start();
    expect(scheduler.callbacks[0]?.delayMs).toBe(1_000);

    service.stop();
    expect(scheduler.callbacks).toHaveLength(0);
  });
});
