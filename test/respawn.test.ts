import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
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
    "真进程 e2e：旧 PID 已消失 → 助手启动新进程（并在 cwd 下留失败证据）",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qqops-respawn-"));
      const marker = join(dir, "marker.txt");
      // 一个「刚退出」的旧进程：助手应当立刻放行，不等 60 秒
      const dead = spawnSync(process.execPath, ["-e", ""]);
      expect(typeof dead.pid).toBe("number");

      const helper = spawn(process.execPath, [
        respawnHelperPath(),
        String(dead.pid),
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(marker)}, "ok")`,
      ], { cwd: dir, stdio: "ignore" });
      helper.unref();

      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await sleep(150);
      }
      expect(existsSync(marker)).toBe(true);
      // 新进程秒退（就是上面那个 -e 脚本）→ 助手应把失败证据写进 cwd
      const failureFile = join(dir, "data", "restart-failed.json");
      const failDeadline = Date.now() + 8_000;
      while (!existsSync(failureFile) && Date.now() < failDeadline) {
        await sleep(150);
      }
      expect(existsSync(failureFile)).toBe(true);
    },
    25_000,
  );
});
