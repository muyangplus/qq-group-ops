import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUILD_INFO_FILE,
  distFingerprint,
  onDiskVersion,
  readBuildInfo,
  verifyBuildInfo,
  writeBuildInfo,
} from "../src/core/buildInfo.js";

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

/**
 * 构建自证（ADR-0065）：`dist/build-info.json` 记「版本 + commit + 构建时间 + dist 指纹」，
 * 安装器与 `/status proc` 用它回答「这份产物到底是哪次构建」。
 *
 * 口径：指纹**不含 `build-info.json` 自己**（否则写进去就自相矛盾）；读不到 / 坏文件
 * 一律回 `undefined`，自证失败只回人话原因、绝不抛异常。
 */
describe("build-info.json", () => {
  const dirs: string[] = [];

  function makeDist(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "qq-group-ops-build-info-"));
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

  it("指纹不含 build-info.json：写完自证文件后指纹不变（否则永远自证不过）", () => {
    const dist = makeDist({ "main.js": "console.log('a')\n" });
    const before = distFingerprint(dist);

    const info = writeBuildInfo({
      version: "0.28.0",
      commit: "abcdef1234567890",
      builtAt: "2026-10-04T00:00:00.000Z",
      dir: dist,
    });

    expect(info.distFingerprint).toBe(before);
    expect(distFingerprint(dist)).toBe(before);
    expect(BUILD_INFO_FILE).toBe("build-info.json");
  });

  it("写 → 读回同样的四个字段", () => {
    const dist = makeDist({ "main.js": "x" });
    writeBuildInfo({
      version: "0.28.0",
      commit: "c0ffee",
      builtAt: "2026-10-04T01:02:03.000Z",
      dir: dist,
    });

    expect(readBuildInfo(dist)).toEqual({
      version: "0.28.0",
      commit: "c0ffee",
      builtAt: "2026-10-04T01:02:03.000Z",
      distFingerprint: distFingerprint(dist),
    });
  });

  it("自证通过：指纹与自证文件一致", () => {
    const dist = makeDist({ "main.js": "x", "core/a.js": "y" });
    writeBuildInfo({ version: "0.28.0", commit: "c", dir: dist });

    expect(verifyBuildInfo(dist).ok).toBe(true);
  });

  it("自证失败：改了产物内容 / 缺自证文件 / 自证文件里没有指纹", () => {
    const dist = makeDist({ "main.js": "x" });
    writeBuildInfo({ version: "0.28.0", commit: "c", dir: dist });

    // 半传 / 混装：内容变了
    writeFileSync(join(dist, "main.js"), "tampered", "utf8");
    const tampered = verifyBuildInfo(dist);
    expect(tampered.ok).toBe(false);
    expect(tampered.detail).toContain("指纹对不上");

    // 缺自证文件（源码运行 / 老产物包）
    const bare = makeDist({ "main.js": "x" });
    expect(verifyBuildInfo(bare).ok).toBe(false);
    expect(verifyBuildInfo(bare).detail).toContain("缺失");

    // 自证文件里没有指纹（老格式）
    const legacy = makeDist({ "main.js": "x" });
    writeFileSync(
      join(legacy, BUILD_INFO_FILE),
      JSON.stringify({ version: "0.28.0", commit: "c", builtAt: "x" }),
      "utf8",
    );
    expect(verifyBuildInfo(legacy).detail).toContain("没有 distFingerprint");
  });

  it("坏文件 / 不是对象 / 没有版本号 → undefined（不抛异常）", () => {
    const dist = makeDist({ "main.js": "x" });
    writeFileSync(join(dist, BUILD_INFO_FILE), "{不是 JSON", "utf8");
    expect(readBuildInfo(dist)).toBeUndefined();

    writeFileSync(join(dist, BUILD_INFO_FILE), JSON.stringify([1, 2, 3]), "utf8");
    expect(readBuildInfo(dist)).toBeUndefined();

    writeFileSync(join(dist, BUILD_INFO_FILE), JSON.stringify({ commit: "c" }), "utf8");
    expect(readBuildInfo(dist)).toBeUndefined();
  });
});

/**
 * 版本号来源（0.29.1 修正）：包化部署（ADR-0065）**不传根 `package.json`**，
 * 只有 `dist/build-info.json` 会跟着 `dist/` 一起换 —— 所以磁盘版本必须优先读它，
 * 否则「包模式整目录替换之后」版本号会一直是老的，甚至全新机器上显示 `unknown`
 * （`/status proc` 与重启回执都会错）。
 */
describe("onDiskVersion", () => {
  const dirs: string[] = [];

  function temp(): string {
    const root = mkdtempSync(join(tmpdir(), "qq-group-ops-on-disk-"));
    dirs.push(root);
    return root;
  }

  function writePackageJson(root: string, version: string): string {
    const file = join(root, "package.json");
    writeFileSync(file, JSON.stringify({ name: "x", version }, null, 2), "utf8");
    return file;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("有产物自证时以 build-info.json 为准（包化部署只换 dist）", () => {
    const root = temp();
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "main.js"), "x", "utf8");
    writeBuildInfo({
      version: "0.30.0",
      commit: "c",
      builtAt: "2026-10-04T00:00:00.000Z",
      dir: dist,
    });
    // 根 package.json 还是老的（包模式不更新它）——必须被忽略
    const pkg = writePackageJson(root, "0.27.3");

    expect(onDiskVersion(dist, pkg)).toBe("0.30.0");
  });

  it("没有产物自证（源码运行 / 老产物包）→ 回落根 package.json", () => {
    const root = temp();
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "main.js"), "x", "utf8");
    const pkg = writePackageJson(root, "0.27.3");

    expect(onDiskVersion(dist, pkg)).toBe("0.27.3");
  });

  it("两边都没有 → unknown（诊断信息不能让指令失败）", () => {
    const root = temp();
    expect(onDiskVersion(join(root, "dist"), join(root, "missing.json"))).toBe(
      "unknown",
    );
  });
});
