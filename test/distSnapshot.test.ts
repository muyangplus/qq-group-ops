import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ROLLBACK_NOTICE_FILE,
  removeSyncStateFiles,
  restoreDistFromBackup,
  snapshotDist,
  takeRollbackNotice,
  writeRollbackNotice,
} from "../src/services/distSnapshot.js";

/**
 * 层 4B：把「上一次启动成功」的构建快照下来，供新版自检不过时回滚。
 */
describe("distSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qqops-snap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("快照 dist 与元文件，并写 manifest", () => {
    mkdirSync(join(dir, "dist", "services"), { recursive: true });
    writeFileSync(join(dir, "dist", "main.js"), "main", "utf8");
    writeFileSync(join(dir, "dist", "services", "a.js"), "a", "utf8");
    writeFileSync(join(dir, "package.json"), "{}", "utf8");

    const result = snapshotDist(
      join(dir, "dist"),
      join(dir, "data", "dist-backup"),
      ["package.json", "pnpm-lock.yaml"],
    );

    expect(result.ok).toBe(true);
    expect(result.files).toBe(3);
    const backup = join(dir, "data", "dist-backup");
    expect(existsSync(join(backup, "dist", "main.js"))).toBe(true);
    expect(existsSync(join(backup, "dist", "services", "a.js"))).toBe(true);
    expect(existsSync(join(backup, "package.json"))).toBe(true);
    // 不存在的元文件跳过，不算失败
    expect(existsSync(join(backup, "pnpm-lock.yaml"))).toBe(false);
    expect(existsSync(join(backup, "manifest.json"))).toBe(true);
  });

  it("再快照一次就覆盖旧的（只保留上一次能起来的版本）", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "main.js"), "old", "utf8");
    const backup = join(dir, "data", "dist-backup");
    snapshotDist(join(dir, "dist"), backup, []);

    writeFileSync(join(dir, "dist", "main.js"), "new", "utf8");
    snapshotDist(join(dir, "dist"), backup, []);

    expect(
      existsSync(join(backup, "dist", "main.js")),
    ).toBe(true);
    // 覆盖后不应残留旧文件之外的垃圾（rm 后再拷）
    expect(existsSync(join(backup, "dist"))).toBe(true);
  });

  it("dist 不存在时报告失败但不抛错", () => {
    const result = snapshotDist(
      join(dir, "nope"),
      join(dir, "data", "dist-backup"),
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("不存在");
  });

  it("回滚回执读走即删（避免重复私信）", () => {
    const file = join(dir, "rollback-notice.json");
    writeRollbackNotice(
      { at: "2026-09-29T00:00:00.000Z", reason: "rolled back", check: { ok: false } },
      file,
    );
    expect(takeRollbackNotice(file)).toMatchObject({ reason: "rolled back" });
    expect(takeRollbackNotice(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("坏回执不抛错，也不留下（返回 undefined）", () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, "{不是 JSON", "utf8");
    expect(takeRollbackNotice(file)).toBeUndefined();
    expect(ROLLBACK_NOTICE_FILE).toBe("data/rollback-notice.json");
  });

  /** 回滚（ADR-0065 第 5 条）：整目录替换，不再是覆盖式还原。 */
  describe("restoreDistFromBackup", () => {
    it("整目录替换：快照里没有的旧文件必须消失（真机混装 dist 的根因）", () => {
      // ① 快照：main.js 是 v1
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist/main.js"), "v1\n", "utf8");
      writeFileSync(join(dir, "dist/keep.js"), "keep\n", "utf8");
      snapshotDist(join(dir, "dist"), join(dir, "data/dist-backup"), []);

      // ② 现役 dist 变成「半新半旧」：新增了 fresh.js、main.js 变了
      writeFileSync(join(dir, "dist/main.js"), "v2\n", "utf8");
      writeFileSync(join(dir, "dist/fresh.js"), "fresh\n", "utf8");
      writeFileSync(join(dir, "dist/sub-stale.js"), "stale\n", "utf8");

      const result = restoreDistFromBackup(
        join(dir, "dist"),
        join(dir, "data/dist-backup"),
        join(dir, "data/dist-broken"),
        [],
      );

      expect(result.ok).toBe(true);
      // 快照内容回来了
      expect(readFileSync(join(dir, "dist/main.js"), "utf8")).toBe("v1\n");
      expect(existsSync(join(dir, "dist/keep.js"))).toBe(true);
      // **覆盖式还原会留下的两个文件**：必须被清掉
      expect(existsSync(join(dir, "dist/fresh.js"))).toBe(false);
      expect(existsSync(join(dir, "dist/sub-stale.js"))).toBe(false);
      // 现场留证
      expect(readFileSync(join(dir, "data/dist-broken/dist/main.js"), "utf8")).toBe("v2\n");
      expect(readFileSync(join(dir, "data/dist-broken/dist/fresh.js"), "utf8")).toBe("fresh\n");
    });

    it("顺带作废 FTP 同步状态（下一轮 CD 全量），别的文件不碰", () => {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist/main.js"), "v1\n", "utf8");
      snapshotDist(join(dir, "dist"), join(dir, "data/dist-backup"), []);
      writeFileSync(join(dir, "ftp-sync-state-code.json"), "{}", "utf8");
      writeFileSync(join(dir, "ftp-sync-state-marker.json"), "{}", "utf8");
      writeFileSync(join(dir, "deploy-0.28.0.json"), "{}", "utf8");

      const result = restoreDistFromBackup(
        join(dir, "dist"),
        join(dir, "data/dist-backup"),
        join(dir, "data/dist-broken"),
        [],
      );

      expect(result.ok).toBe(true);
      expect(result.detail).toContain("作废 FTP 同步状态");
      expect(existsSync(join(dir, "ftp-sync-state-code.json"))).toBe(false);
      expect(existsSync(join(dir, "ftp-sync-state-marker.json"))).toBe(false);
      // 投递标记不是同步状态，绝不能被顺手删掉
      expect(existsSync(join(dir, "deploy-0.28.0.json"))).toBe(true);
    });

    it("没有快照时如实报失败（不抛错）", () => {
      const result = restoreDistFromBackup(
        join(dir, "dist"),
        join(dir, "data/dist-backup"),
        join(dir, "data/dist-broken"),
        [],
      );
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("没有可回滚的构建快照");
    });
  });

  it("removeSyncStateFiles：只删 ftp-sync-state-*.json（下一轮 CD 全量），别的文件一律不碰", () => {
    writeFileSync(join(dir, "ftp-sync-state-code.json"), "{}", "utf8");
    writeFileSync(join(dir, "ftp-sync-state-marker.json"), "{}", "utf8");
    writeFileSync(join(dir, "package.json"), "{}", "utf8");
    writeFileSync(join(dir, "deploy-0.28.0.json"), "{}", "utf8");

    const removed = removeSyncStateFiles(dir).sort();

    expect(removed).toEqual([
      "ftp-sync-state-code.json",
      "ftp-sync-state-marker.json",
    ]);
    expect(existsSync(join(dir, "ftp-sync-state-code.json"))).toBe(false);
    // 同步状态之外的文件一个都不动（尤其是 `deploy-*.json` 这种投递标记）
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "deploy-0.28.0.json"))).toBe(true);
    // 重复调用安全
    expect(removeSyncStateFiles(dir)).toEqual([]);
  });
});
