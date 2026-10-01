import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 管理 API 的会话（E1-a，认证方案 B2）。
 *
 * 会话存在**内存**里（重启即全员登出，这对管理面是好事），cookie 里只放
 * `会话id.HMAC(secret, 会话id)`：
 * - 会话 id 是 32 字节随机串，猜不到；
 * - HMAC 让客户端改不动（改了签名就不对）；
 * - 滑动过期：每次带 cookie 访问都续期，超过 `ttlMs` 没访问就失效；
 * - cookie 属性由 server 层设置：`HttpOnly` + `SameSite=Strict`（+ 可选 `Secure`）。
 *
 * 身份就是 `userId`（openid）：一次性令牌兑换时从令牌行里带过来，权限直接复用现有两轴模型。
 */
export interface AdminSession {
  id: string;
  /** 登录者 openid（= 机器人 userId）。 */
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionStoreOptions {
  secret: string;
  ttlMs: number;
  /** 同时在线的会话上限（超出时淘汰最久未使用的）。 */
  maxSessions?: number | undefined;
  now?: (() => number) | undefined;
}

export class SessionStore {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  public constructor(options: SessionStoreOptions) {
    this.secret = options.secret;
    this.ttlMs = options.ttlMs;
    this.maxSessions = options.maxSessions ?? 100;
    this.now = options.now ?? (() => Date.now());
  }

  public get size(): number {
    this.prune();
    return this.sessions.size;
  }

  /** 登录成功：建会话并返回写进 cookie 的值。 */
  public create(userId: string): { cookieValue: string; session: AdminSession } {
    const id = randomBytes(32).toString("base64url");
    const now = this.now();
    const session: AdminSession = {
      id,
      userId,
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(id, session);
    this.prune();
    this.evictOverflow();
    return { cookieValue: this.sign(id), session };
  }

  /** 校验 cookie 并滑动续期；无效 / 过期返回 undefined。 */
  public touch(cookieValue: string | undefined): AdminSession | undefined {
    const id = this.verify(cookieValue);
    if (!id) {
      return undefined;
    }
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    const now = this.now();
    if (now - session.lastSeenAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    session.lastSeenAt = now;
    return session;
  }

  /** 登出：只删这一个会话。 */
  public destroy(cookieValue: string | undefined): boolean {
    const id = this.verify(cookieValue);
    if (!id) {
      return false;
    }
    return this.sessions.delete(id);
  }

  /** 清掉所有登录态（改口令 / 应急踢人用）。 */
  public clear(): number {
    const removed = this.sessions.size;
    this.sessions.clear();
    return removed;
  }

  public prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }

  private sign(id: string): string {
    return `${id}.${this.hmac(id)}`;
  }

  private verify(cookieValue: string | undefined): string | undefined {
    if (!cookieValue) {
      return undefined;
    }
    const index = cookieValue.lastIndexOf(".");
    if (index <= 0) {
      return undefined;
    }
    const id = cookieValue.slice(0, index);
    const signature = cookieValue.slice(index + 1);
    const expected = this.hmac(id);
    if (signature.length !== expected.length) {
      return undefined;
    }
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ? id
      : undefined;
  }

  private hmac(id: string): string {
    return createHmac("sha256", this.secret).update(id).digest("base64url");
  }

  private evictOverflow(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldest: AdminSession | undefined;
      for (const session of this.sessions.values()) {
        if (!oldest || session.lastSeenAt < oldest.lastSeenAt) {
          oldest = session;
        }
      }
      if (!oldest) {
        return;
      }
      this.sessions.delete(oldest.id);
    }
  }
}
