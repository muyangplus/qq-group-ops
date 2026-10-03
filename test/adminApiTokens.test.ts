import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { AuditStatus } from "../src/core/enums.js";
import type {
  ActiveAdminToken,
  AdminTokenRepository,
} from "../src/db/adminTokenRepository.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import type { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";

/**
 * 管理后台的**登录令牌**面（收尾批次 D）：
 * - 只读列表（`/api/tokens`，240）：按成员聚合「谁手上还有未用的登录链接」，
 *   **不回传任何哈希 / 明文**（库里那份 `sha256` 是凭证材料，不出进程）；
 * - 立即吊销（`POST /api/tokens/revoke`，240）：`/admin login` 的链接发错人时不用等 TTL；
 *   只作废**未兑换**的令牌，已建立的会话（签名 cookie）不受影响；
 * - 本来就没有未用令牌时如实回 `revoked: 0` + 审计记 rejected，不假装成功。
 */
interface Harness {
  backend: AdminApiBackend;
  auditLog: AuditLogStore;
  tokens: MemoryTokens;
  /** 夹具用的相对时间（`listActive` 默认用真实 now，所以不能写死绝对时间）。 */
  times: {
    u1Old: { createdAt: string; expiresAt: string };
    u1New: { createdAt: string; expiresAt: string };
    u2: { createdAt: string; expiresAt: string };
  };
}

/** 内存版令牌仓储（行为与 SQL 版一致：只存哈希、一次性、可列表、可吊销）。 */
class MemoryTokens implements AdminTokenRepository {
  private readonly rows = new Map<
    string,
    { userId: string; createdAt: Date; expiresAt: Date; used: boolean }
  >();

  public add(userId: string, createdAt: string, expiresAt: string): void {
    this.rows.set(`${userId}|${createdAt}`, {
      userId,
      createdAt: new Date(createdAt),
      expiresAt: new Date(expiresAt),
      used: false,
    });
  }

  public async issue(): Promise<{ token: string; expiresAt: Date }> {
    throw new Error("测试用不到签发");
  }

  public async redeem(): Promise<string | undefined> {
    return undefined;
  }

  public async pruneExpired(): Promise<void> {
    // 测试里不需要清理
  }

  public async countActive(): Promise<number> {
    return (await this.listActive()).length;
  }

  public async listActive(now: Date = new Date()): Promise<ActiveAdminToken[]> {
    return [...this.rows.values()]
      .filter((row) => !row.used && row.expiresAt.getTime() > now.getTime())
      .map((row) => ({
        userId: row.userId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
  }

  public async revokeActiveForUser(userId: string): Promise<number> {
    let revoked = 0;
    for (const [key, row] of this.rows) {
      if (row.userId === userId && !row.used) {
        this.rows.delete(key);
        revoked += 1;
      }
    }
    return revoked;
  }
}

function harness(options: { withTokens?: boolean } = {}): Harness {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const permissions = new PermissionService({ superAdminIds: new Set(["boss"]) });
  const tokens = new MemoryTokens();
  // 时间要**相对现在**算（`listActive` 默认用真实 now）：u1 两张、u2 一张，最晚到期 u1 > u2
  const base = Date.now();
  const iso = (minutes: number): string =>
    new Date(base + minutes * 60_000).toISOString();
  const times = {
    u1Old: { createdAt: iso(-5), expiresAt: iso(5) },
    u1New: { createdAt: iso(1), expiresAt: iso(15) },
    u2: { createdAt: iso(-2), expiresAt: iso(8) },
  };
  tokens.add("u1", times.u1Old.createdAt, times.u1Old.expiresAt);
  tokens.add("u1", times.u1New.createdAt, times.u1New.expiresAt);
  tokens.add("u2", times.u2.createdAt, times.u2.expiresAt);
  const backend = createAdminApiBackend({
    permissions,
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({
      profiles: { get: () => undefined },
    }),
    ...(options.withTokens === false ? {} : { adminTokens: tokens }),
    // 目标解析：QQ号 10001 ↔ u1（与生产同一套 `resolvePermissionUser`）
    identityMap: {
      resolveUserId: (raw: string) => (raw === "10001" ? "u1" : raw),
    } as unknown as IdentityMapService,
    mode: "fake",
  });
  return { backend, auditLog, tokens, times };
}

function audits(auditLog: AuditLogStore, action: string) {
  return auditLog.all().filter((item) => item.action === action);
}

describe("管理 API 登录令牌：只读列表（按成员聚合，不回传哈希）", () => {
  it("按成员聚合张数与时间范围，按最晚到期升序", async () => {
    const h = harness();

    const view = await h.backend.tokens();

    expect(view.total).toBe(3);
    expect(view.items).toHaveLength(2);
    expect(view.items.map((item) => item.userId)).toEqual(["u2", "u1"]);
    expect(view.items[1]).toMatchObject({
      userId: "u1",
      count: 2,
      // 最早签发 / 最晚到期
      createdAt: h.times.u1Old.createdAt,
      expiresAt: h.times.u1New.expiresAt,
    });
    expect(view.items[0]).toMatchObject({
      userId: "u2",
      count: 1,
      createdAt: h.times.u2.createdAt,
      expiresAt: h.times.u2.expiresAt,
    });
    // 展示信息走展示口径（没有绑定号时至少给官方 id），列表里**没有**任何哈希字段
    expect(view.items[0]?.user.officialId).toBe("u2");
    expect(JSON.stringify(view)).not.toContain("token_hash");
  });

  it("仓储未装配（内存模式）时列表回 503 语义", async () => {
    const bare = harness({ withTokens: false });

    const error = await bare.backend
      .tokens()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AdminApiRequestError);
    expect((error as AdminApiRequestError).statusCode).toBe(503);
  });
});

describe("管理 API 登录令牌：立即吊销（240）", () => {
  it("平台超管吊销某成员全部未用令牌：解析 QQ号、写 executed 审计", async () => {
    const h = harness();

    const result = await h.backend.revokeTokens({
      userId: "10001",
      actorId: "boss",
    });

    expect(result).toMatchObject({ userId: "u1", revoked: 2 });
    expect(result.message).toContain("2 张");
    expect(result.message).toContain("会话不受影响");
    // 只作废目标那两张：u2 的还在
    expect((await h.backend.tokens()).items.map((item) => item.userId)).toEqual([
      "u2",
    ]);
    const audit = audits(h.auditLog, "admin_api:token_revoke");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe(AuditStatus.Executed);
    expect(audit[0]?.reason).toContain("u1");
  });

  it("本来就没有未用令牌：如实回 revoked=0，审计记 rejected", async () => {
    const h = harness();

    const result = await h.backend.revokeTokens({
      userId: "ghost",
      actorId: "boss",
    });

    expect(result).toMatchObject({ userId: "ghost", revoked: 0 });
    expect(result.message).toContain("没有未用的登录令牌");
    const audit = audits(h.auditLog, "admin_api:token_revoke");
    expect(audit[0]?.status).toBe(AuditStatus.Rejected);
  });

  it("非平台超管 403 + 拒绝审计；仓储未装配 503", async () => {
    const h = harness();

    const denied = await h.backend
      .revokeTokens({ userId: "u1", actorId: "mod" })
      .catch((thrown: unknown) => thrown);
    expect((denied as AdminApiRequestError).statusCode).toBe(403);
    expect(audits(h.auditLog, "admin_api:denied")).toHaveLength(1);
    // 被拒时**不能**真去吊销
    expect((await h.backend.tokens()).total).toBe(3);

    const bare = harness({ withTokens: false });
    const unavailable = await bare.backend
      .revokeTokens({ userId: "u1", actorId: "boss" })
      .catch((thrown: unknown) => thrown);
    expect((unavailable as AdminApiRequestError).statusCode).toBe(503);
  });
});
