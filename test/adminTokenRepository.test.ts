import { describe, expect, it } from "vitest";

import {
  hashAdminToken,
  SqlAdminTokenRepository,
  tokensEqual,
} from "../src/db/adminTokenRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

/**
 * 管理 API 的一次性登录令牌（E1 · 认证方案 B2）。
 *
 * 三条不变量：**库里只存 sha256**、**一次性**（第二次兑换失败）、**过期即失效**。
 */

function rowOf(input: {
  userId: string;
  expiresAt: Date;
  usedAt?: Date | undefined;
}): Record<string, unknown> {
  return {
    user_id: input.userId,
    used_at: input.usedAt?.toISOString() ?? null,
    expires_at: input.expiresAt.toISOString(),
  };
}

describe("SqlAdminTokenRepository", () => {
  it("签发：库里只写 sha256，明文只返回给调用方", async () => {
    const db = new FakeQueryable();
    const repository = new SqlAdminTokenRepository(db);
    const now = new Date("2026-10-01T00:00:00.000Z");

    const { token, expiresAt } = await repository.issue({
      userId: "op1",
      ttlMs: 10 * 60 * 1000,
      now,
    });

    expect(token.length).toBeGreaterThan(20);
    expect(expiresAt.toISOString()).toBe("2026-10-01T00:10:00.000Z");
    // 第一次是 INSERT，第二次是顺手清理过期行
    const insert = db.calls[0];
    expect(insert?.text).toContain("INSERT INTO admin_api_tokens");
    expect(insert?.values?.[0]).toBe(hashAdminToken(token));
    expect(insert?.values?.[0]).not.toContain(token);
    expect(insert?.values?.[1]).toBe("op1");
    expect(db.calls[1]?.text).toContain("DELETE FROM admin_api_tokens");
  });

  it("兑换：未用过且未过期 → 返回 userId 并标记 used_at", async () => {
    const token = "tok-abc";
    const db = new FakeQueryable([
      [rowOf({ userId: "op1", expiresAt: new Date("2026-10-01T00:10:00.000Z") })],
    ]);
    const repository = new SqlAdminTokenRepository(db);
    const now = new Date("2026-10-01T00:05:00.000Z");

    const userId = await repository.redeem(token, now);

    expect(userId).toBe("op1");
    expect(db.calls[0]?.text).toContain("SELECT user_id, used_at, expires_at");
    expect(db.calls[0]?.values).toEqual([hashAdminToken(token)]);
    const update = db.calls[1];
    expect(update?.text).toContain("UPDATE admin_api_tokens SET used_at");
    expect(update?.text).toContain("used_at IS NULL");
    expect(update?.values).toEqual([hashAdminToken(token), now.toISOString()]);
  });

  it("兑换：已用过 / 已过期 / 不存在都返回 undefined（且不改库）", async () => {
    const soon = new Date("2026-10-01T00:10:00.000Z");
    const now = new Date("2026-10-01T00:05:00.000Z");

    const used = new FakeQueryable([
      [rowOf({ userId: "op1", expiresAt: soon, usedAt: now })],
    ]);
    expect(await new SqlAdminTokenRepository(used).redeem("t", now)).toBeUndefined();
    expect(used.calls).toHaveLength(1);

    const expired = new FakeQueryable([
      [rowOf({ userId: "op1", expiresAt: new Date("2026-10-01T00:04:00.000Z") })],
    ]);
    expect(await new SqlAdminTokenRepository(expired).redeem("t", now)).toBeUndefined();
    expect(expired.calls).toHaveLength(1);

    const missing = new FakeQueryable([[]]);
    expect(await new SqlAdminTokenRepository(missing).redeem("t", now)).toBeUndefined();

    const blank = new FakeQueryable();
    expect(await new SqlAdminTokenRepository(blank).redeem("   ", now)).toBeUndefined();
    expect(blank.calls).toHaveLength(0);
  });

  it("countActive 只数未用且未过期的令牌", async () => {
    const db = new FakeQueryable([[{ n: "2" }]]);
    const repository = new SqlAdminTokenRepository(db);
    const now = new Date("2026-10-01T00:05:00.000Z");

    expect(await repository.countActive(now)).toBe(2);
    const call = db.calls[0];
    expect(call?.text).toContain("COUNT(*)");
    expect(call?.text).toContain("used_at IS NULL");
    expect(call?.values).toEqual([now.toISOString()]);
  });

  it("listActive：未用且未过期的行，按签发时间升序，且**不选哈希**", async () => {
    const db = new FakeQueryable([
      [
        {
          user_id: "op1",
          created_at: "2026-10-01T00:00:00.000Z",
          expires_at: "2026-10-01T00:10:00.000Z",
        },
        {
          user_id: "op2",
          created_at: "2026-10-01T00:02:00.000Z",
          expires_at: "2026-10-01T00:12:00.000Z",
        },
      ],
    ]);
    const repository = new SqlAdminTokenRepository(db);
    const now = new Date("2026-10-01T00:05:00.000Z");

    const rows = await repository.listActive(now);

    expect(rows).toEqual([
      {
        userId: "op1",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-01T00:10:00.000Z"),
      },
      {
        userId: "op2",
        createdAt: new Date("2026-10-01T00:02:00.000Z"),
        expiresAt: new Date("2026-10-01T00:12:00.000Z"),
      },
    ]);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    const call = db.calls[0];
    expect(call?.text).toContain("used_at IS NULL");
    expect(call?.text).toContain("expires_at > $1");
    expect(call?.text).toContain("ORDER BY created_at ASC");
    // 只读列表**不选 token_hash**：哈希是凭证材料，不出进程
    expect(call?.text).not.toContain("token_hash");
    expect(call?.values).toEqual([now.toISOString()]);
  });

  it("revokeActiveForUser：作废该成员全部未用令牌并返回条数（没有就是 0）", async () => {
    const db = new FakeQueryable([[{ user_id: "op1" }, { user_id: "op1" }]]);
    const repository = new SqlAdminTokenRepository(db);

    expect(await repository.revokeActiveForUser("op1")).toBe(2);
    const call = db.calls[0];
    expect(call?.text).toContain("DELETE FROM admin_api_tokens");
    expect(call?.text).toContain("used_at IS NULL");
    // `Queryable` 只回 rows：用 RETURNING 数「到底作废了几张」
    expect(call?.text).toContain("RETURNING");
    expect(call?.values).toEqual(["op1"]);

    const empty = new FakeQueryable([[]]);
    expect(await new SqlAdminTokenRepository(empty).revokeActiveForUser("op2")).toBe(0);
  });

  it("hashAdminToken 是稳定的 sha256；tokensEqual 常量时间比较", () => {
    expect(hashAdminToken("abc")).toBe(hashAdminToken("abc"));
    expect(hashAdminToken("abc")).toHaveLength(64);
    expect(hashAdminToken("abc")).not.toBe(hashAdminToken("abd"));
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abcd")).toBe(false);
  });
});
