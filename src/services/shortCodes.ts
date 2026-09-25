import { randomInt } from "node:crypto";

import { getLogger } from "../core/logger.js";
import { utcNow } from "../core/models.js";
import type { ShortCodeEntry, ShortCodeRepository } from "../db/shortCodeRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

const log = getLogger("short-codes");

/** 短码种类：分别对应内部 userId / group_openid / join_request_id。 */
export const SHORT_CODE_KINDS = ["user", "group", "join_request"] as const;
export type ShortCodeKind = (typeof SHORT_CODE_KINDS)[number];

export const SHORT_CODE_LENGTH = 6;
export const SHORT_CODE_PREFIX = "#";
/** 短码字符表：**只含数字与大写字母**（不出现小写字母，便于口头/手抄）。 */
export const ALPHABET_36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ATTEMPTS = 20;

/** 生成一个随机短码（不含前缀）。 */
export function randomCode(
  length: number,
  randomInt: (max: number) => number = (max) => randomIntCrypto(max),
): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += ALPHABET_36[randomInt(ALPHABET_36.length)];
  }
  return code;
}

function randomIntCrypto(max: number): number {
  return randomInt(max);
}

export interface ShortCodeOptions {
  length?: number;
  /** 注入随机源便于测试（默认 `crypto.randomInt`）。 */
  randomInt?: (max: number) => number;
  now?: () => Date;
}

/**
 * 随机短码服务。
 *
 * 需求背景：官方 id（`join_request_id`、`user_openid`、`group_openid`）又长又不可读，
 * 直接展示既难看又有被枚举/误用风险。这里为每个内部 id 生成一个 6 位随机
 * Base62 短码（形如 `#M7K2Q9`）：
 *
 * - 生成时随机、不用自增，猜不到下一个，避免被枚举后越权审核；
 * - `code` 是唯一主键、`(kind, target_id)` 唯一，内存与数据库都会查重，碰撞就重生成；
 * - 大小写不敏感查找（输入 `#m7k2q9` 也能命中），但展示保留原始大小写；
 * - 幂等：同一个 id 永远返回同一个短码，`load()` 会从数据库恢复。
 */
export class ShortCodeService {
  private readonly byCode = new Map<string, ShortCodeEntry>();
  private readonly codeByTarget = new Map<string, string>();
  private readonly length: number;
  private readonly random: (max: number) => number;
  private readonly now: () => Date;
  private readonly repository: ShortCodeRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    repository?: ShortCodeRepository,
    queue?: WriteQueue,
    options: ShortCodeOptions = {},
  ) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
    this.length = options.length ?? SHORT_CODE_LENGTH;
    this.random = options.randomInt ?? ((max) => randomInt(max));
    this.now = options.now ?? (() => utcNow());
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const entries = await this.repository.findAll();
    this.byCode.clear();
    this.codeByTarget.clear();
    for (const entry of entries) {
      // 迁移/并发导致的下线重复：保留先到的那条
      if (this.byCode.has(entry.code.toLowerCase())) {
        continue;
      }
      this.register({ ...entry });
    }
    this.regenerateLegacyCodes();
  }

  /**
   * 历史短码可能含小写字母；启动时统一换成「数字 + 大写字母」并写回数据库。
   * 已发出的旧短码会失效，需要重新从卡片/列表获取（用户确认的选择）。
   */
  private regenerateLegacyCodes(): void {
    const stale = [...this.byCode.values()].filter(
      (entry) => entry.code !== entry.code.toUpperCase(),
    );
    for (const entry of stale) {
      const next: ShortCodeEntry = { ...entry, code: this.generate() };
      this.byCode.delete(entry.code.toLowerCase());
      this.register(next);
      const repository = this.repository;
      if (repository) {
        this.queue?.enqueue("short-code.replace", () =>
          repository.replaceCode(entry.code, next),
        );
      }
    }
    if (stale.length > 0) {
      log.info("short codes regenerated to uppercase", { count: stale.length });
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public get size(): number {
    return this.byCode.size;
  }

  /** 取（必要时生成）某个内部 id 的短码（不含 `#`）。 */
  public codeFor(kind: ShortCodeKind, targetId: string): string {
    const targetKey = targetKeyOf(kind, targetId);
    const existing = this.codeByTarget.get(targetKey);
    if (existing !== undefined) {
      return existing;
    }
    const entry: ShortCodeEntry = {
      code: this.generate(),
      kind,
      targetId,
      createdAt: this.now(),
    };
    this.register(entry);
    if (this.repository) {
      this.queue?.enqueue("short-code.save", () =>
        this.repository!.save(entry),
      );
    }
    log.debug("short code created", { kind, code: entry.code });
    return entry.code;
  }

  /** 展示用：`#M7K2Q9`。 */
  public label(kind: ShortCodeKind, targetId: string): string {
    return `${SHORT_CODE_PREFIX}${this.codeFor(kind, targetId)}`;
  }

  /** 解析用户输入的短码；不是短码或查不到时返回 undefined。 */
  public resolve(
    input: string,
  ): { code: string; kind: ShortCodeKind; targetId: string } | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith(SHORT_CODE_PREFIX)) {
      return undefined;
    }
    const code = trimmed.slice(SHORT_CODE_PREFIX.length).trim();
    if (code.length === 0) {
      return undefined;
    }
    const entry = this.byCode.get(code.toLowerCase());
    if (!entry || !isShortCodeKind(entry.kind)) {
      return undefined;
    }
    return { code: entry.code, kind: entry.kind, targetId: entry.targetId };
  }

  private generate(): string {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const candidate = randomCode(this.length, this.random);
      if (!this.byCode.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
    throw new Error("短码生成失败：连续碰撞，请检查随机源");
  }

  private register(entry: ShortCodeEntry): void {
    this.byCode.set(entry.code.toLowerCase(), entry);
    this.codeByTarget.set(targetKeyOfKindString(entry.kind, entry.targetId), entry.code);
  }
}

function targetKeyOf(kind: ShortCodeKind, targetId: string): string {
  return targetKeyOfKindString(kind, targetId);
}

function targetKeyOfKindString(kind: string, targetId: string): string {
  return `${kind}\u0000${targetId}`;
}

function isShortCodeKind(value: string): value is ShortCodeKind {
  return (SHORT_CODE_KINDS as readonly string[]).includes(value);
}
