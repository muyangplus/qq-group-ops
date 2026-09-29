import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  respawnCommand,
  respawnHelperPath,
  spawnRespawnHelper,
} from "../src/services/respawn.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/**
 * 假「机器人入口」：`--check` 时按参数决定自检成败（并写结果文件），正常启动时写下 marker。
 * 真实入口 `dist/main.js` 也是这个契约（`src/startupCheck.ts`）。
 */
function fakeApp(dir: string, marker: string): string {
  const file = join(dir, "fake-app.mjs");
  writeFileSync(
    file,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'const isCheck = process.argv.includes("--check");',
      'mkdirSync("data", { recursive: true });',
      'if (isCheck && process.argv.includes("fail-check")) {',
      '  writeFileSync("data/startup-check.json", JSON.stringify({ ok: false, error: "schema boom" }));',
      "  process.exit(1);",
      "}",
      'if (isCheck) {',
      '  writeFileSync("data/startup-check.json", JSON.stringify({ ok: true, degraded: [] }));',
      "  process.exit(0);",
      "}",
      `writeFileSync(${JSON.stringify(marker)}, "ok");`,
    ].join("\n"),
    "utf8",
  );
  return file;
}

/**
 * 自我重启（`/restart` 在 `node dist/main.js` 场景下的兜底）：
 * 助手脚本必须先等旧进程退出、再启动新进程，否则会出现两个实例抢端口 / 双重回复。
 */
describe("respawn", () => {
  it("命令行只有三个部分：助手脚本 / 旧 PID / 可执行文件 + 原参数", () => {
    const { command, args } = respawnCommand(
      { pid: 4321, execPath: "node", args: ["dist/main.js"] },
      "scripts/respawn.mjs",
    );
    expect(command).toBe("node");
    expect(args).toEqual(["scripts/respawn.mjs", "4321", "node", "dist/main.js"]);
  });

  it("助手脚本随包存在（发布产物里 scripts/ 一起走）", () => {
    expect(existsSync(respawnHelperPath())).toBe(true);
  });

  it("助手路径不存在时直接报告失败，调用方据此不退出旧进程", () => {
    const handle = spawnRespawnHelper(
      { pid: process.pid, execPath: process.execPath, args: ["nothing.js"] },
      join(tmpdir(), "qqops-not-here-respawn.mjs"),
    );
    expect(handle.ok).toBe(false);
    expect(handle.failed()).toBe(true);
  });

  it(
    "真进程 e2e：旧 PID 已消失 → 自检通过 → 助手启动新进程（并在 cwd 下留失败证据）",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qqops-respawn-"));
      const marker = join(dir, "marker.txt");
      const app = fakeApp(dir, marker);
      // 一个「刚退出」的旧进程：助手应当立刻放行，不等 60 秒
      const dead = spawnSync(process.execPath, ["-e", ""]);
      expect(typeof dead.pid).toBe("number");

      const helper = spawn(process.execPath, [
        respawnHelperPath(),
        String(dead.pid),
        process.execPath,
        app,
      ], { cwd: dir, stdio: "ignore" });
      helper.unref();

      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await sleep(150);
      }
      expect(existsSync(marker)).toBe(true);
      // 新进程写完 marker 就退出 → 助手应把失败证据写进 cwd
      const failureFile = join(dir, "data", "restart-failed.json");
      const failDeadline = Date.now() + 8_000;
      while (!existsSync(failureFile) && Date.now() < failDeadline) {
        await sleep(150);
      }
      expect(existsSync(failureFile)).toBe(true);
    },
    25_000,
  );

  /**
   * 层 4A：助手在拉起新进程**之前**跑一次 `--check`；自检不过就不拉起，
   * 把结果写进 `restart-failed.json`（宁可留在旧版本，也不要换个起不来的版本）。
   */
  describe("启动前自检（layer 4A）", () => {
    function runHelper(
      dir: string,
      appArgs: readonly string[],
    ): { status: number | null; failure?: Record<string, unknown> } {
      const dead = spawnSync(process.execPath, ["-e", ""]);
      const helper = spawnSync(
        process.execPath,
        [
          respawnHelperPath(),
          String(dead.pid),
          process.execPath,
          ...appArgs,
        ],
        { cwd: dir, stdio: "ignore", timeout: 30_000 },
      );
      const failureFile = join(dir, "data", "restart-failed.json");
      return {
        status: helper.status,
        ...(existsSync(failureFile)
          ? {
              failure: JSON.parse(
                readFileSync(failureFile, "utf8"),
              ) as Record<string, unknown>,
            }
          : {}),
      };
    }

    it("自检不过 → 不拉起新进程，并留下原因", () => {
      const dir = mkdtempSync(join(tmpdir(), "qqops-preflight-"));
      const app = fakeApp(dir, join(dir, "started.txt"));

      const result = runHelper(dir, [app, "fail-check"]);

      expect(result.status).not.toBe(0);
      expect(existsSync(join(dir, "started.txt"))).toBe(false);
      expect(String(result.failure?.reason)).toContain("startup check failed");
      expect(result.failure?.check).toMatchObject({ ok: false, error: "schema boom" });
    }, 40_000);

    it("自检通过 → 照常拉起新进程", () => {
      const dir = mkdtempSync(join(tmpdir(), "qqops-preflight-"));
      const app = fakeApp(dir, join(dir, "started.txt"));

      runHelper(dir, [app]);

      expect(existsSync(join(dir, "started.txt"))).toBe(true);
    }, 40_000);

    /**
     * 层 4B：新构建自检不过 → 用 `data/dist-backup/` 换回上一版 → 再自检 → 拉起。
     * 这里让「新构建」在 dist 里带一个 `dist-bad.txt`，而快照里没有。
     */
    it("自检不过 + 有快照 → 回滚到上一版并启动，留回滚回执", () => {
      const dir = mkdtempSync(join(tmpdir(), "qqops-rollback-"));
      const appCode = [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'const bad = process.argv[1].replace(/app\\.mjs$/u, "dist-bad.txt");',
        'const isCheck = process.argv.includes("--check");',
        'mkdirSync("data", { recursive: true });',
        "if (isCheck) {",
        '  const ok = !(await import("node:fs")).existsSync(bad);',
        '  writeFileSync("data/startup-check.json", JSON.stringify({ ok }));',
        "  process.exit(ok ? 0 : 1);",
        "}",
        'writeFileSync(process.argv[2] ?? "started.txt", "ok");',
      ].join("\n");
      // 新构建（含 dist-bad.txt → 自检会失败）
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "app.mjs"), appCode, "utf8");
      writeFileSync(join(dir, "dist", "dist-bad.txt"), "bad", "utf8");
      // 上一次启动成功的快照（没有 dist-bad.txt → 自检通过）
      mkdirSync(join(dir, "data", "dist-backup", "dist"), { recursive: true });
      writeFileSync(
        join(dir, "data", "dist-backup", "dist", "app.mjs"),
        appCode,
        "utf8",
      );

      const result = runHelper(dir, [
        join("dist", "app.mjs"),
        join(dir, "started-restored.txt"),
      ]);

      expect(existsSync(join(dir, "started-restored.txt"))).toBe(true);
      // 坏构建被留证
      expect(existsSync(join(dir, "data", "dist-broken", "dist", "dist-bad.txt"))).toBe(true);
      // 回滚回执写好了（机器人启动时会读走并私信超管）
      const noticeFile = join(dir, "data", "rollback-notice.json");
      expect(existsSync(noticeFile)).toBe(true);
      expect(String(JSON.parse(readFileSync(noticeFile, "utf8")).reason)).toContain(
        "rolled back",
      );
      expect(result.status).toBe(0);
    }, 40_000);

    it("自检不过 + 没有快照 → 不拉起，并把两次失败都记下来", () => {
      const dir = mkdtempSync(join(tmpdir(), "qqops-norollback-"));
      const app = fakeApp(dir, join(dir, "started.txt"));

      const result = runHelper(dir, [app, "fail-check"]);

      expect(result.status).not.toBe(0);
      expect(existsSync(join(dir, "started.txt"))).toBe(false);
      expect(String(result.failure?.rollback)).toContain("no dist snapshot");
    }, 40_000);
  });
});
