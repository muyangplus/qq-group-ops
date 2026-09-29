import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  });
});
