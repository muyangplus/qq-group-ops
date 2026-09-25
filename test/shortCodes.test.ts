import { describe, expect, it } from "vitest";

import type {
  ShortCodeEntry,
  ShortCodeRepository,
} from "../src/db/shortCodeRepository.js";
import { ShortCodeService } from "../src/services/shortCodes.js";

class FakeShortCodeRepository implements ShortCodeRepository {
  public readonly rows: ShortCodeEntry[] = [];

  public async findAll(): Promise<ShortCodeEntry[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  public async save(entry: ShortCodeEntry): Promise<void> {
    if (
      this.rows.some(
        (row) =>
          row.code === entry.code ||
          (row.kind === entry.kind && row.targetId === entry.targetId),
      )
    ) {
      return;
    }
    this.rows.push({ ...entry });
  }

  public async replaceCode(
    oldCode: string,
    entry: ShortCodeEntry,
  ): Promise<void> {
    const index = this.rows.findIndex((row) => row.code === oldCode);
    if (index >= 0) {
      this.rows[index] = { ...entry };
    }
  }
}

/** 短码字符表：数字 + 大写字母（与 src/services/shortCodes.ts 保持一致）。 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 用固定短码序列驱动随机源，便于测试碰撞与重生成。 */
function randomFromCodes(codes: readonly string[]): (max: number) => number {
  const stream: number[] = [];
  for (const code of codes) {
    for (const char of code) {
      stream.push(ALPHABET.indexOf(char));
    }
  }
  let index = 0;
  return () => {
    const value = stream[index] ?? 0;
    index += 1;
    return value;
  };
}

describe("ShortCodeService", () => {
  it("generates a stable 6-char code per target", () => {
    const service = new ShortCodeService();
    const first = service.codeFor("join_request", "long-request-id");
    const again = service.codeFor("join_request", "long-request-id");
    const other = service.codeFor("join_request", "another-request-id");

    // 只含数字与大写字母，绝不出现小写
    expect(first).toMatch(/^[0-9A-Z]{6}$/u);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(service.label("join_request", "long-request-id")).toBe(`#${first}`);
    expect(service.size).toBe(2);
  });

  it("separates codes by kind", () => {
    const service = new ShortCodeService();
    const user = service.codeFor("user", "same-id");
    const group = service.codeFor("group", "same-id");
    expect(user).not.toBe(group);
  });

  it("regenerates when a generated code collides", () => {
    const service = new ShortCodeService(undefined, undefined, {
      length: 6,
      randomInt: randomFromCodes(["AAA111", "AAA111", "BBB222"]),
    });

    expect(service.codeFor("user", "first")).toBe("AAA111");
    // 第二次生成先撞上 AAA111，再重生成出 BBB222
    expect(service.codeFor("user", "second")).toBe("BBB222");
  });

  it("resolves codes case-insensitively and ignores non-codes", () => {
    const service = new ShortCodeService(undefined, undefined, {
      randomInt: randomFromCodes(["M7K2Q9"]),
    });
    const code = service.codeFor("join_request", "r1");

    expect(code).toBe("M7K2Q9");
    expect(service.resolve("#M7K2Q9")).toEqual({
      code,
      kind: "join_request",
      targetId: "r1",
    });
    // 手输时大小写都能解析（虽然生成的短码永远是大写）
    expect(service.resolve("#m7k2q9")?.targetId).toBe("r1");
    expect(service.resolve("M7K2Q9")).toBeUndefined();
    expect(service.resolve("#ZZZZZZ")).toBeUndefined();
  });

  it("persists codes and restores them after a restart", async () => {
    const repository = new FakeShortCodeRepository();
    const first = new ShortCodeService(repository, undefined, {
      randomInt: randomFromCodes(["A1B2C3"]),
    });
    const code = first.codeFor("group", "group-openid");
    await first.flush();

    expect(repository.rows).toEqual([
      {
        code: "A1B2C3",
        kind: "group",
        targetId: "group-openid",
        createdAt: expect.any(Date),
      },
    ]);

    const restarted = new ShortCodeService(repository);
    await restarted.load();
    // 重启后同一个 id 复用原短码，并支持解析
    expect(restarted.codeFor("group", "group-openid")).toBe(code);
    expect(restarted.resolve("#a1b2c3")?.targetId).toBe("group-openid");
  });

  it("regenerates legacy lowercase codes to uppercase on load", async () => {
    const repository = new FakeShortCodeRepository();
    repository.rows.push({
      code: "Ab12Cd",
      kind: "group",
      targetId: "group-openid",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const service = new ShortCodeService(repository, undefined, {
      randomInt: randomFromCodes(["Z9Y8X7"]),
    });

    await service.load();
    await service.flush();

    // 同一个 target 换成纯大写短码，并写回数据库
    expect(service.resolve("#Z9Y8X7")).toEqual({
      code: "Z9Y8X7",
      kind: "group",
      targetId: "group-openid",
    });
    expect(repository.rows).toEqual([
      {
        code: "Z9Y8X7",
        kind: "group",
        targetId: "group-openid",
        createdAt: expect.any(Date),
      },
    ]);
    // 旧短码立即失效
    expect(service.resolve("#Ab12Cd")).toBeUndefined();
  });

  it("keeps generating codes without exhausting the space", () => {
    const service = new ShortCodeService();
    const codes = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      codes.add(service.codeFor("user", `user-${index}`));
    }
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-Z]{6}$/u);
    }
  });
});
