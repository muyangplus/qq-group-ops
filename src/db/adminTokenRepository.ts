import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Queryable } from "./queryable.js";

/**
 * 管理 API 的一次性登录令牌（E1 · 认证方案 B2）。
 *
 * 为什么落库而不是放内存：签发方是**机器人进程**（`/admin login`）或 **CLI**（`pnpm admin:token`），
 * 兑换方是**独立的管理 API 进程**——三个进程内存互不可见；落库顺带带来"API 重启后链接仍有效"。
 *
 * 安全约定：
 * - 库里**只存 `sha256(明文令牌)`**，明文只在签发那一刻返回给调用方一次；
 * - 令牌是 32 字节随机串（base64url），一次性（兑换成功立刻写 `used_at`）、有 TTL；
 * - 过期行由 `issue` / `redeem` 顺手清理，不额外起定时任务。
 */
export interface AdminTokenRepository {
  /** 签发：返回明文令牌与到期时间（明文不落库）。 */
  issue(input: {
    userId: string;
    ttlMs: number;
    now?: Date | undefined;
  }): Promise<{ token: string; expiresAt: Date }>;
  /** 兑换：成功返回 userId，并立刻标记为已用；无效 / 过期 / 已用返回 undefined。 */
  redeem(token: string, now?: Date | undefined): Promise<string | undefined>;
  /** 清理过期行；返回删除前探测到的条数（0 表示没有）。 */
  pruneExpired(now?: Date | undefined): Promise<void>;
  /** 当前**未用且未过期**的令牌数（`/api/status` 用，便于确认"刚才那张卡是不是还有效"）。 */
  countActive(now?: Date | undefined): Promise<number>;
}

interface TokenRow {
  user_id: string;
  used_at: string | Date | null;
  expires_at: string | Date;
}

const INSERT_SQL = `
INSERT INTO admin_api_tokens (token_hash, user_id, created_at, expires_at, used_at)
VALUES ($1, $2, $3, $4, NULL)
`.trim();

const SELECT_SQL =
  "SELECT user_id, used_at, expires_at FROM admin_api_tokens WHERE token_hash = $1";

const MARK_USED_SQL = `
UPDATE admin_api_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL
`.trim();

const PRUNE_SQL = "DELETE FROM admin_api_tokens WHERE expires_at <= $1";

const COUNT_ACTIVE_SQL = `
SELECT COUNT(*) AS n FROM admin_api_tokens WHERE used_at IS NULL AND expires_at > $1
`.trim();

export function hashAdminToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SqlAdminTokenRepository implements AdminTokenRepository {
  public constructor(private readonly db: Queryable) {}

  public async issue(input: {
    userId: string;
    ttlMs: number;
    now?: Date | undefined;
  }): Promise<{ token: string; expiresAt: Date }> {
    const now = input.now ?? new Date();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    await this.db.query(INSERT_SQL, [
      hashAdminToken(token),
      input.userId,
      now.toISOString(),
      expiresAt.toISOString(),
    ]);
    // 顺手清过期行：令牌本来就短命，不需要为它单独挂定时任务
    await this.pruneExpired(now);
    return { token, expiresAt };
  }

  public async redeem(
    token: string,
    now: Date = new Date(),
  ): Promise<string | undefined> {
    if (token.trim().length === 0) {
      return undefined;
    }
    const hash = hashAdminToken(token.trim());
    const found = await this.db.query<TokenRow>(SELECT_SQL, [hash]);
    const row = found.rows[0];
    if (!row || row.used_at !== null) {
      return undefined;
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      return undefined;
    }
    // 只有管理 API 进程会兑换，且这里是"先查再标记"，同进程内不会有并发窗口；
    // `AND used_at IS NULL` 是兜底：万一被重放，第二次也是空写。
    await this.db.query(MARK_USED_SQL, [hash, now.toISOString()]);
    await this.pruneExpired(now);
    return row.user_id;
  }

  public async pruneExpired(now: Date = new Date()): Promise<void> {
    await this.db.query(PRUNE_SQL, [now.toISOString()]);
  }

  public async countActive(now: Date = new Date()): Promise<number> {
    const result = await this.db.query<{ n: number | string }>(
      COUNT_ACTIVE_SQL,
      [now.toISOString()],
    );
    return Number(result.rows[0]?.n ?? 0);
  }
}

/** 常量时间比较（给未来的机器 token 用；登录令牌走哈希查表，不需要它）。 */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
