import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DeployWatcher } from "../src/services/deployWatcher.js";
import {
  restoreDistFromBackup,
} from "../src/services/distSnapshot.js";
import {
  FailedVersionGuard,
  runRestartPreflight,
} from "../src/services/restartPreflight.js";

/**
 * 「退出前自检」（层 4A 前置版）：旧进程退出**之前**跑 `--check`，跑不过就不退出。
 * 这里覆盖三件基础件：自检子进程、失败版本记忆、坏构建换回上一版。
 */
describe("runRestartPreflight", () => {
  it("自检失败：ok=false + 中文原因（读 data/startup-check.json）", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-preflight-"));
    const out = join(dir, "startup-check.json");
    const app = join(dir, "app.mjs");
    writeFileSync(
      app,
      [
        'import { writeFileSync } from "node:fs";',
        "const out = process.argv[2];",
        'writeFileSync(out, JSON.stringify({ ok: false, error: "schema boom" }));',
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    try {
      const result = runRestartPreflight({
        execPath: process.execPath,
        args: [app, out],
        checkFile: out,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain("schema boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("自检通过：ok=true", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-preflight-"));
    const out = join(dir, "startup-check.json");
    const app = join(dir, "app.mjs");
    writeFileSync(
      app,
      [
        'import { writeFileSync } from "node:fs";',
        "const out = process.argv[2];",
        'writeFileSync(out, JSON.stringify({ ok: true, degraded: [] }));',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    try {
      const result = runRestartPreflight({
        execPath: process.execPath,
        args: [app, out],
        checkFile: out,
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FailedVersionGuard", () => {
  it("记住失败版本，版本一换就忘掉", () => {
    const guard = new FailedVersionGuard();
    guard.markFailed("0.22.0", "schema boom", "deploy");

    expect(guard.isFailed("0.22.0")).toBe(true);
    expect(guard.get("0.22.0")?.kind).toBe("deploy");
    expect(guard.isFailed("0.23.0")).toBe(false);

    guard.forget("0.22.0");
    expect(guard.isFailed("0.22.0")).toBe(false);
    // 空版本号不记
    guard.markFailed(undefined, "x", "manual");
    expect(guard.isFailed(undefined)).toBe(false);
  });
});

describe("restoreDistFromBackup", () => {
  it("坏构建挪到 dist-broken，快照还原回 dist", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-restore-"));
    const dist = join(dir, "dist");
    const backup = join(dir, "data", "dist-backup");
    const broken = join(dir, "data", "dist-broken");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(backup, "dist"), { recursive: true });
    writeFileSync(join(dist, "main.js"), "bad", "utf8");
    writeFileSync(join(backup, "dist", "main.js"), "good", "utf8");
    writeFileSync(join(backup, "package.json"), '{"version":"0.21.0"}', "utf8");
    try {
      const result = restoreDistFromBackup(dist, backup, broken, ["package.json"]);
      expect(result.ok).toBe(true);
      expect(readFileSync(join(dist, "main.js"), "utf8")).toBe("good");
      expect(readFileSync(join(broken, "dist", "main.js"), "utf8")).toBe("bad");
      // 元文件也一起回滚
      expect(readFileSync(join(dir, "package.json"), "utf8")).toContain("0.21.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没有快照时报告失败但不抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-restore-"));
    try {
      const result = restoreDistFromBackup(
        join(dir, "dist"),
        join(dir, "data", "dist-backup"),
        join(dir, "data", "dist-broken"),
        [],
      );
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("没有可回滚");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DeployWatcher.blockVersion", () => {
  function harness(): {
    watcher: DeployWatcher;
    notices: number;
    setDisk: (version: string) => void;
  } {
    let disk = "0.21.0";
    let notices = 0;
    const watcher = new DeployWatcher({
      enabled: true,
      checkIntervalMs: () => 60_000,
      delayMs: 600_000,
      runningVersion: () => "0.20.0",
      onDiskVersion: () => disk,
      recipients: () => ["root"],
      notify: async () => {
        notices += 1;
      },
      requestRestart: () => true,
      clock: () => Date.parse("2026-09-29T00:00:00.000Z"),
    });
    return {
      watcher,
      get notices() {
        return notices;
      },
      setDisk: (version) => {
        disk = version;
      },
    };
  }

  it("被 block 的目标版本不再提醒；换版本重新给机会", async () => {
    const h = harness();
    h.watcher.blockVersion("0.21.0", "自检不过");

    await h.watcher.runOnce();
    expect(h.notices).toBe(0);
    expect(h.watcher.pending()).toBeUndefined();

    // 磁盘版本一变 → 重新提醒
    h.setDisk("0.22.0");
    await h.watcher.runOnce();
    expect(h.notices).toBe(1);
    expect(h.watcher.pending()?.targetVersion).toBe("0.22.0");
  });
});
