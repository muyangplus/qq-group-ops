import { describe, expect, it } from "vitest";

import type { Scheduler } from "../src/adapters/reconnectingWebSocketGateway.js";
import { AuditStatus, JoinRequestStatus } from "../src/core/enums.js";
import { utcNow } from "../src/core/models.js";
import type { AuditRecord } from "../src/core/models.js";
import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import type { AuditRepository } from "../src/db/auditRepository.js";
import { AuditLogStore } from "../src/services/audit.js";
import { BlacklistService } from "../src/services/blacklist.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PunishmentService } from "../src/services/punishments.js";
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
      punishmentsRemoved: 0,
      messageExcerptsCleared: 0,
      appealsRemoved: 0,
    });
    expect(auditLog.all()).toHaveLength(1);
  });

  it("clears punishment message excerpts after RAW_MESSAGE_RETENTION_DAYS", async () => {
    const now = Date.UTC(2026, 0, 20);
    const api = new FakeQQOfficialAPI();
    const punishments = new PunishmentService(api, new BlacklistService(api, {
      auditLog: new AuditLogStore(),
      listBoundGroups: () => ["g1"],
    }), { now: () => new Date(now) });
    const oldRecord = await punishments.create({
      groupId: "g1",
      userId: "u1",
      messageExcerpt: "十几天前的原文",
      actions: {
        recalled: false,
        muted: false,
        muteDurationSeconds: 0,
        kicked: false,
        blacklist: "",
      },
    });
    const freshRecord = await punishments.create({
      groupId: "g1",
      userId: "u2",
      messageExcerpt: "今天的原文",
      actions: {
        recalled: false,
        muted: false,
        muteDurationSeconds: 0,
        kicked: false,
        blacklist: "",
      },
    });
    // 把第一条拨回 10 天前（保留期设 7 天）
    (punishments.get(oldRecord.recordId) as { createdAt: Date }).createdAt =
      new Date(now - 10 * 24 * 60 * 60 * 1_000);

    const service = new RetentionService(
      new AuditLogStore(),
      new JoinAuditService(),
      {
        auditLogRetentionDays: 0,
        joinRequestRetentionDays: 0,
        // 原文保留期按群算：这里给每个群 7 天
        rawMessageDaysFor: () => 7,
        clock: () => now,
      },
      undefined,
      undefined,
      punishments,
    );

    const result = await service.runOnce();

    expect(result.messageExcerptsCleared).toBe(1);
    expect(punishments.get(oldRecord.recordId)?.messageExcerpt).toBe("");
    expect(punishments.get(freshRecord.recordId)?.messageExcerpt).toBe("今天的原文");
    // 记录本身还在（处罚与申诉仍可回看）
    expect(punishments.get(oldRecord.recordId)?.recordId).toBe(oldRecord.recordId);
  });

  it("原文按**群**分别清理：设了天数的群清、-1 的群不清", async () => {
    const now = Date.UTC(2026, 0, 20);
    const api = new FakeQQOfficialAPI();
    const punishments = new PunishmentService(api, new BlacklistService(api, {
      auditLog: new AuditLogStore(),
      listBoundGroups: () => ["g1", "g2"],
    }), { now: () => new Date(now) });
    const old = new Date(now - 10 * DAY_MS);
    const make = async (groupId: string) =>
      punishments.create({
        groupId,
        userId: "u1",
        messageExcerpt: "十几天前的原文",
        actions: {
          recalled: false,
          muted: false,
          muteDurationSeconds: 0,
          kicked: false,
          blacklist: "",
        },
      });
    const shortLived = await make("g1");
    const permanent = await make("g2");
    // 把两条都拨回 10 天前（g1 保留期 7 天 → 该清；g2 永久 → 不清）
    for (const record of [shortLived, permanent]) {
      (punishments.get(record.recordId) as { createdAt: Date }).createdAt = old;
    }
    expect(punishments.listGroupsWithExcerpts()).toEqual(["g1", "g2"]);

    const service = new RetentionService(
      new AuditLogStore(),
      new JoinAuditService(),
      {
        auditLogRetentionDays: 0,
        joinRequestRetentionDays: 0,
        rawMessageDaysFor: (groupId) => (groupId === "g1" ? 7 : -1),
        clock: () => now,
      },
      undefined,
      undefined,
      punishments,
    );

    const result = await service.runOnce();

    expect(result.messageExcerptsCleared).toBe(1);
    expect(punishments.get(shortLived.recordId)?.messageExcerpt).toBe("");
    expect(punishments.get(permanent.recordId)?.messageExcerpt).toBe(
      "十几天前的原文",
    );
  });

  it("不再负责 TTL 过期（改由统一扫描的 join-pending-ttl 任务每轮检查）", async () => {
    const auditLog = new AuditLogStore();
    const joinAudit = new JoinAuditService(auditLog);
    joinAudit.submit("g1", "u1", "待审批", "pending");

    // 把“现在”往后拨 8 天，默认 TTL 7 天
    const service = new RetentionService(auditLog, joinAudit, {
      auditLogRetentionDays: 180,
      joinRequestRetentionDays: 180,
      clock: () => utcNow().getTime() + 8 * DAY_MS,
    });

    const result = await service.runOnce();

    // 保留清理不碰 TTL：申请还在，状态仍是待审批
    expect(result).not.toHaveProperty("joinRequestsExpired");
    expect(joinAudit.pending("g1")).toHaveLength(1);
    expect(joinAudit.get("pending").status).toBe(JoinRequestStatus.Pending);

    // 真正让它过期的是那个每轮扫描的 TTL 任务
    expect(joinAudit.expireStalePending(utcNow().getTime() + 8 * DAY_MS)).toBe(1);
    expect(joinAudit.pending("g1")).toEqual([]);
    expect(joinAudit.get("pending").status).toBe(JoinRequestStatus.Expired);
  });
});
