import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireInstanceLock,
  isProcessAlive,
  readInstanceLock,
  releaseInstanceLock,
  writeDuplicateEvidence,
} from "../src/services/instanceLock.js";

/**
 * 单实例锁（ADR-0064）：真机上出现过**两个 `node dist/main.js` 同时从同一个应用目录跑**
 * （都是自我重启助手拉起的游离进程），于是一次部署各发一张「发现新版本」、各自重启一次。
 * 这个锁就是要在启动时把第二份挡掉。
 */
const dirs: string[] = [];

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-lock-"));
  dirs.push(dir);
  return join(dir, "bot-instance.lock");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("单实例锁", () => {
  it("没有锁时直接拿到，并把 pid / 版本写进锁文件", () => {
    const file = lockPath();
    const result = acquireInstanceLock({
      file,
      pid: 1001,
      version: "0.27.1",
      now: () => new Date("2026-10-04T12:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(readInstanceLock(file)).toEqual({
      pid: 1001,
      startedAt: "2026-10-04T12:00:00.000Z",
      version: "0.27.1",
    });
  });

  it("持有者还活着 → 拒绝启动（并如实告知是谁占着）", () => {
    const file = lockPath();
    acquireInstanceLock({ file, pid: 1001, version: "0.27.1" });

    const second = acquireInstanceLock({
      file,
      pid: 1002,
      version: "0.27.1",
      isAlive: () => true,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder.pid).toBe(1001);
    }
    // 锁没有被第二份覆盖：仍是 1001 占着
    expect(readInstanceLock(file)?.pid).toBe(1001);
  });

  it("持有者已经退出（崩溃 / 被 kill）→ 接管，不会把自己锁在门外", () => {
    const file = lockPath();
    acquireInstanceLock({ file, pid: 1001, version: "0.27.1" });

    const second = acquireInstanceLock({
      file,
      pid: 2002,
      version: "0.27.1",
      isAlive: () => false,
    });

    expect(second.ok).toBe(true);
    expect(readInstanceLock(file)?.pid).toBe(2002);
  });

  it("同一个 pid 重复抢（幂等）不算冲突", () => {
    const file = lockPath();
    acquireInstanceLock({ file, pid: 1001, version: "0.27.1" });
    const again = acquireInstanceLock({
      file,
      pid: 1001,
      version: "0.27.1",
      isAlive: () => true,
    });
    expect(again.ok).toBe(true);
  });

  it("坏锁文件当没有（不让一个坏文件拦住启动）", () => {
    const file = lockPath();
    writeFileSync(file, "{ not json", "utf8");
    expect(acquireInstanceLock({ file, pid: 3003, version: "0.27.1" }).ok).toBe(true);
    expect(readInstanceLock(file)?.pid).toBe(3003);
  });

  it("只在自己持有时才释放；别人持有时不动它", () => {
    const file = lockPath();
    acquireInstanceLock({ file, pid: 1001, version: "0.27.1" });

    expect(releaseInstanceLock({ file, pid: 9999 })).toBe(false);
    expect(readInstanceLock(file)?.pid).toBe(1001);

    expect(releaseInstanceLock({ file, pid: 1001 })).toBe(true);
    expect(readInstanceLock(file)).toBeUndefined();
  });

  it("探活：当前进程算活着，不存在的 pid 算死了", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // 取一个几乎不可能存在的 pid（Linux 上限通常 4194304）
    expect(isProcessAlive(99_999_999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });

  it("拒绝启动时留下证据文件（含持有者与提示）", () => {
    const file = lockPath();
    const evidence = join(file, "..", "duplicate-instance.json");
    writeDuplicateEvidence({
      holder: { pid: 622365, startedAt: "2026-10-04T03:57:00.000Z", version: "0.26.0" },
      pid: 700000,
      file: evidence,
    });

    const parsed = JSON.parse(readFileSync(evidence, "utf8")) as {
      refusedPid: number;
      holder: { pid: number };
      hint: string;
    };
    expect(parsed.refusedPid).toBe(700000);
    expect(parsed.holder.pid).toBe(622365);
    expect(parsed.hint).toContain("只能有一份");
  });
});
