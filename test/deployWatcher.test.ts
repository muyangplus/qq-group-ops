import { describe, expect, it } from "vitest";

import { DeployWatcher } from "../src/services/deployWatcher.js";
import type { RichMessage } from "../src/services/richMessages.js";

/**
 * 部署监测（P0）：磁盘版本变化 + 连续稳定 → 通知超管「计划 1 小时后重启」，
 * 可取消 / 可立即重启；到期自动走自我重启。
 */
function createHarness(options: {
  disk?: string;
  running?: string;
  delayMs?: number;
  stableChecks?: number;
  acceptRestart?: boolean;
} = {}): {
  watcher: DeployWatcher;
  notices: Array<{ userId: string; card: RichMessage }>;
  restarts: Array<{ requestedBy: string; reason: string; targetVersion: string }>;
  setDisk: (version: string) => void;
  setAccept: (value: boolean) => void;
  advance: (ms: number) => void;
} {
  let disk = options.disk ?? "0.20.0";
  const running = options.running ?? "0.20.0";
  let accept = options.acceptRestart ?? true;
  let now = Date.parse("2026-09-28T00:00:00.000Z");
  const notices: Array<{ userId: string; card: RichMessage }> = [];
  const restarts: Array<{
    requestedBy: string;
    reason: string;
    targetVersion: string;
  }> = [];

  const watcher = new DeployWatcher({
    enabled: true,
    checkIntervalMs: 60_000,
    delayMs: options.delayMs ?? 3_600_000,
    ...(options.stableChecks !== undefined
      ? { stableChecks: options.stableChecks }
      : {}),
    runningVersion: () => running,
    onDiskVersion: () => disk,
    recipients: () => ["root", "root2"],
    notify: async (userId, card) => {
      notices.push({ userId, card });
    },
    requestRestart: (info) => {
      if (!accept) {
        return false;
      }
      restarts.push(info);
      return true;
    },
    clock: () => now,
  });

  return {
    watcher,
    notices,
    restarts,
    setDisk: (version) => {
      disk = version;
    },
    setAccept: (value) => {
      accept = value;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

describe("DeployWatcher", () => {
  it("版本没变（或读不到）时什么都不做", async () => {
    const h = createHarness();
    await h.watcher.runOnce();
    await h.watcher.runOnce();
    expect(h.notices).toHaveLength(0);
    expect(h.watcher.pending()).toBeUndefined();

    h.setDisk("unknown");
    await h.watcher.runOnce();
    expect(h.notices).toHaveLength(0);
  });

  it("连续 3 轮稳定才通知超管，并给出 1 小时后的重启时间", async () => {
    const h = createHarness();
    h.setDisk("0.21.0");

    await h.watcher.runOnce();
    await h.watcher.runOnce();
    expect(h.notices).toHaveLength(0); // 还没稳定

    await h.watcher.runOnce();
    expect(h.notices.map((item) => item.userId)).toEqual(["root", "root2"]);
    const pending = h.watcher.pending();
    expect(pending?.targetVersion).toBe("0.21.0");
    expect(pending?.currentVersion).toBe("0.20.0");
    expect(
      Date.parse(pending!.deadlineAt) - Date.parse(pending!.detectedAt),
    ).toBe(3_600_000);
    expect(h.notices[0]?.card.markdown).toContain("v0.21.0");
    expect(JSON.stringify(h.notices[0]?.card.keyboard)).toContain(
      "cb:deploy:cancel",
    );
    expect(JSON.stringify(h.notices[0]?.card.keyboard)).toContain(
      "cb:deploy:now",
    );
  });

  it("到点自动重启：带上 reason=deploy 与目标版本", async () => {
    const h = createHarness({ delayMs: 60_000 });
    h.setDisk("0.21.0");
    for (let i = 0; i < 3; i += 1) {
      await h.watcher.runOnce();
    }
    expect(h.restarts).toHaveLength(0);

    h.advance(60_000);
    await h.watcher.runOnce();
    expect(h.restarts).toEqual([
      { requestedBy: "deploy-watcher", reason: "deploy", targetVersion: "0.21.0" },
    ]);
    expect(h.watcher.pending()).toBeUndefined();
  });

  it("取消后同一版本不再提醒，但更新的版本会重新提醒", async () => {
    const h = createHarness();
    h.setDisk("0.21.0");
    for (let i = 0; i < 3; i += 1) {
      await h.watcher.runOnce();
    }
    expect(h.watcher.cancel()).toBe(true);
    expect(h.watcher.pending()).toBeUndefined();

    await h.watcher.runOnce();
    await h.watcher.runOnce();
    expect(h.notices).toHaveLength(2); // 只有最初那两条（root / root2）

    // 又部署了更新的版本 → 重新提醒
    h.setDisk("0.22.0");
    for (let i = 0; i < 3; i += 1) {
      await h.watcher.runOnce();
    }
    expect(h.notices).toHaveLength(4);
    expect(h.watcher.pending()?.targetVersion).toBe("0.22.0");
  });

  it("立即重启：不等宽限期", async () => {
    const h = createHarness();
    h.setDisk("0.21.0");
    for (let i = 0; i < 3; i += 1) {
      await h.watcher.runOnce();
    }

    expect(h.watcher.restartNow()).toBe(true);
    expect(h.restarts).toHaveLength(1);
    expect(h.watcher.pending()).toBeUndefined();
  });

  it("磁盘版本回落（撤回部署）→ 清除待重启状态", async () => {
    const h = createHarness();
    h.setDisk("0.21.0");
    for (let i = 0; i < 3; i += 1) {
      await h.watcher.runOnce();
    }
    expect(h.watcher.pending()).toBeDefined();

    h.setDisk("0.20.0");
    await h.watcher.runOnce();
    expect(h.watcher.pending()).toBeUndefined();
    expect(h.restarts).toHaveLength(0);
  });

  it("自动重启没受理时保留状态、延后 5 分钟并通知超管", async () => {
    const h = createHarness({ delayMs: 0 });
    h.setAccept(false);
    h.setDisk("0.21.0");
    for (let i = 0; i < 3; i += 1) {
      await h.watcher.runOnce();
    }
    const created = h.watcher.pending()!.deadlineAt;

    await h.watcher.runOnce(); // 既定 deadline 是「现在」，触发但被拒
    expect(h.restarts).toHaveLength(0);
    const pending = h.watcher.pending();
    expect(pending?.targetVersion).toBe("0.21.0");
    // 延后 5 分钟重试
    expect(Date.parse(pending!.deadlineAt) - Date.parse(created)).toBe(300_000);
    expect(
      h.notices.some((item) => item.card.markdown.includes("自动重启没成功")),
    ).toBe(true);
  });

  it("没有收件人（没有超管）时只记日志、不崩", async () => {
    const watcher = new DeployWatcher({
      enabled: true,
      checkIntervalMs: 60_000,
      delayMs: 0,
      runningVersion: () => "0.20.0",
      onDiskVersion: () => "0.21.0",
      recipients: () => [],
      notify: async () => undefined,
      requestRestart: () => true,
      clock: () => 0,
    });
    for (let i = 0; i < 3; i += 1) {
      await watcher.runOnce();
    }
    expect(watcher.pending()?.targetVersion).toBe("0.21.0");
  });
});
