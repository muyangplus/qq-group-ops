import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { distFingerprint } from "../src/core/buildInfo.js";

/**
 * 构建指纹（`distFingerprint`）：部署监测用「产物内容」区分「版本号变了」与「代码真的换了」。
 *
 * 口径：只认内容（**不看 mtime** —— CD 重传同样内容会改 mtime，那是假信号）；
 * `dist/` 不存在或读不动 → `undefined`（调用方退回版本号判据）。
 */
describe("distFingerprint", () => {
  const dirs: string[] = [];

  function makeDist(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "qq-group-ops-dist-"));
    dirs.push(root);
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const target = join(dist, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    return dist;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一份内容 → 同一个指纹（重写文件、改 mtime 也不变）", () => {
    const dist = makeDist({
      "main.js": "console.log('a')\n",
      "core/x.js": "export const x = 1;\n",
    });
    const first = distFingerprint(dist);
    expect(first).toBeTypeOf("string");

    // 重新写入同样的内容（mtime 一定变了）
    writeFileSync(join(dist, "main.js"), "console.log('a')\n", "utf8");
    expect(distFingerprint(dist)).toBe(first);
  });

  it("内容变了 → 指纹就变（同长度也一样）", () => {
    const dist = makeDist({ "main.js": "console.log('a')\n" });
    const before = distFingerprint(dist);
    writeFileSync(join(dist, "main.js"), "console.log('b')\n", "utf8");
    expect(distFingerprint(dist)).not.toBe(before);
  });

  it("多一个文件 / 删一个文件都会变", () => {
    const dist = makeDist({ "main.js": "x" });
    const base = distFingerprint(dist);
    writeFileSync(join(dist, "extra.js"), "y", "utf8");
    const added = distFingerprint(dist);
    expect(added).not.toBe(base);
    rmSync(join(dist, "extra.js"));
    expect(distFingerprint(dist)).toBe(base);
  });

  it("目录不存在 / 空目录 → undefined（调用方退回版本号判据）", () => {
    expect(distFingerprint(join(tmpdir(), "qq-group-ops-no-such-dist"))).toBeUndefined();
    expect(distFingerprint(makeDist({}))).toBeUndefined();
  });
});
