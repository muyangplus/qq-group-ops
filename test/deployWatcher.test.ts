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
  /** 到点要不要自己动手（`AUTO_RESTART_ON_DEPLOY`）；**不影响是否提醒**（ADR-0065）。 */
  autoRestart?: boolean;
  /** 扫描间隔；`<= 0` = 关闭监测（唯一的生效判据）。 */
  checkIntervalMs?: number;
  /**
   * 传了就启用「构建指纹」判据：`boot` 是进程启动时取到的指纹，`now` 是当前指纹
   * （缺省与 `boot` 相同 = 产物内容没变过）。
   */
  fingerprint?: { boot: string | undefined; now?: string | undefined } | undefined;
} = {}): {
  watcher: DeployWatcher;
  notices: Array<{ userId: string; card: RichMessage }>;
  restarts: Array<{ requestedBy: string; reason: string; targetVersion: string }>;
  setDisk: (version: string) => void;
  setAccept: (value: boolean) => void;
  setAutoRestart: (value: boolean) => void;
  advance: (ms: number) => void;
  setFingerprint: (value: string | undefined) => void;
} {
  let disk = options.disk ?? "0.20.0";
  const running = options.running ?? "0.20.0";
  let accept = options.acceptRestart ?? true;
  let autoRestart = options.autoRestart ?? true;
  let now = Date.parse("2026-09-28T00:00:00.000Z");
  const notices: Array<{ userId: string; card: RichMessage }> = [];
  const restarts: Array<{
    requestedBy: string;
    reason: string;
    targetVersion: string;
  }> = [];
  /** 当前指纹（会被 setFingerprint 改，模拟「上传还在继续」）。 */
  let currentFingerprint = options.fingerprint
    ? (options.fingerprint.now ?? options.fingerprint.boot)
    : undefined;

  const watcher = new DeployWatcher({
    enabled: () => autoRestart,
    checkIntervalMs: options.checkIntervalMs ?? 60_000,
    delayMs: options.delayMs ?? 3_600_000,
    ...(options.stableChecks !== undefined
      ? { stableChecks: options.stableChecks }
      : {}),
    // 只有显式传了 fingerprint 才启用指纹判据（缺省 = 旧口径，老用例照旧成立）
    ...(options.fingerprint
      ? {
          fingerprint: () => currentFingerprint,
          bootFingerprint: options.fingerprint.boot,
        }
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
    setAutoRestart: (value) => {
      autoRestart = value;
    },
    advance: (ms) => {
      now += ms;
    },
    setFingerprint: (value) => {
      currentFingerprint = value;
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

  it("检测到新版本就通知超管（不等连续几轮），并给出 1 小时后的重启时间", async () => {
    const h = createHarness();
    h.setDisk("0.21.0");

    // 默认 stableChecks = 1：第一轮就提醒（宽限期才是缓冲，不靠连续几轮猜上传完没完）
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

  it("显式要求连续多轮时仍然等够轮数（stableChecks 选项）", async () => {
    const h = createHarness({ stableChecks: 3 });
    h.setDisk("0.21.0");

    await h.watcher.runOnce();
    await h.watcher.runOnce();
    expect(h.notices).toHaveLength(0);

    await h.watcher.runOnce();
    expect(h.notices).toHaveLength(2);
  });

  it("自动重启没受理时保留状态、延后 5 分钟并通知超管", async () => {
    const h = createHarness({ delayMs: 0 });
    h.setAccept(false);
    h.setDisk("0.21.0");
    await h.watcher.runOnce(); // 建 pending，deadline 就是「现在」
    const created = h.watcher.pending()!.deadlineAt;

    await h.watcher.runOnce(); // 到点触发但被拒
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
      // 不接受理：走「保留待重启状态、延后重试」那条路，卡片发不出去也不能崩
      requestRestart: () => false,
      clock: () => 0,
    });
    for (let i = 0; i < 3; i += 1) {
      await watcher.runOnce();
    }
    expect(watcher.pending()?.targetVersion).toBe("0.21.0");
  });

  describe("受理过重启的目标版本（重复通知 / 重复重启回归）", () => {
    it("受理重启后同一版本不再通知、不再排第二轮（旧进程还在退出的窗口里）", async () => {
      // 真机报过：一次部署收到两张「发现新版本」、机器人改版两次（间隔 5s）。
      // 原因：受理重启 ≠ 旧进程已退出，扫描周期还在跑，而「同一个版本已经安排过了」没被记住。
      const h = createHarness({ delayMs: 0 });
      h.setDisk("0.21.0");

      await h.watcher.runOnce(); // 建 pending（宽限期 0 → deadline 就是现在）
      await h.watcher.runOnce(); // 到点 → 受理重启
      expect(h.restarts).toHaveLength(1);
      expect(h.watcher.pending()).toBeUndefined();

      // 旧进程还没退出，扫描周期又跑了几轮：不能再通知、不能再排重启
      await h.watcher.runOnce();
      await h.watcher.runOnce();
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(1);
      expect(h.notices.map((item) => item.userId)).toEqual(["root", "root2"]);
      expect(h.watcher.pending()).toBeUndefined();
    });

    it("手动重启回写「已受理」后，部署监测不再为同一版本排一轮", async () => {
      // 真机报过：手动重启一次后又自己重启一次（相隔约 3 分钟）。
      // 手动 /restart 也会走 runRestartFlow → deployWatcher.markScheduled()。
      const h = createHarness({ delayMs: 0 });
      h.setDisk("0.21.0");
      await h.watcher.runOnce(); // 部署监测已经在提醒
      expect(h.watcher.pending()).toBeDefined();

      h.watcher.markScheduled("0.21.0"); // 手动重启已安排
      expect(h.watcher.pending()).toBeUndefined();

      await h.watcher.runOnce();
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(0);
      expect(h.notices.map((item) => item.userId)).toEqual(["root", "root2"]);
    });

    it("受理后又部署了更新的版本 → 重新提醒并重启", async () => {
      const h = createHarness({ delayMs: 0 });
      h.setDisk("0.21.0");
      await h.watcher.runOnce();
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(1);

      h.setDisk("0.22.0");
      await h.watcher.runOnce();
      expect(h.notices).toHaveLength(4);
      expect(h.watcher.pending()?.targetVersion).toBe("0.22.0");

      await h.watcher.runOnce();
      expect(h.restarts.map((item) => item.targetVersion)).toEqual([
        "0.21.0",
        "0.22.0",
      ]);
    });

    it("受理后磁盘版本回落（撤回部署）再重新上传同一版本 → 重新给机会", async () => {
      const h = createHarness({ delayMs: 0 });
      h.setDisk("0.21.0");
      await h.watcher.runOnce();
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(1);

      h.setDisk("0.20.0"); // 撤回部署：磁盘版本追平运行版本
      await h.watcher.runOnce();

      h.setDisk("0.21.0"); // 重新上传同一版本
      await h.watcher.runOnce();
      expect(h.notices).toHaveLength(4);
      expect(h.watcher.pending()?.targetVersion).toBe("0.21.0");
    });
  });

  describe("构建指纹（版本号变了不等于代码换了）", () => {
    it("指纹与启动时一致 → 不排重启（但会私信一张「可能是上传被跳过」的卡）", async () => {
      // 场景：新代码已落地、package.json 还没落地时进程启动过 → 它跑的已经是最新代码；
      // 随后版本号追上来，绝不能宽限期到点再白跳一次重启（真机报「一次部署跳两次」）。
      const h = createHarness({
        disk: "0.21.0",
        running: "0.20.0",
        fingerprint: { boot: "build-a", now: "build-a" },
        delayMs: 0,
      });

      await h.watcher.runOnce();
      await h.watcher.runOnce();
      h.advance(60_000);
      await h.watcher.runOnce();

      expect(h.restarts).toHaveLength(0);
      expect(h.watcher.pending()).toBeUndefined();
      // 提示只发一次，且不是「发现新版本」那张
      expect(h.notices).toHaveLength(2);
      expect(h.notices[0]?.card.markdown).toContain("版本号变了，但代码没变");
    });

    it("指纹随后变了（上传还在继续）→ 仍然提醒并按时重启", async () => {
      const h = createHarness({
        disk: "0.21.0",
        running: "0.20.0",
        fingerprint: { boot: "build-a", now: "build-a" },
        delayMs: 0,
      });

      // 第一轮：版本号已变但内容没变 → 不排重启（改为私信超管一张「可能是上传被跳过」的卡）
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(0);
      expect(h.watcher.pending()).toBeUndefined();
      expect(h.notices).toHaveLength(2);

      // 后续文件落地 → 指纹变了 → 这才是一次真部署
      h.setFingerprint("build-b");
      await h.watcher.runOnce();
      expect(h.notices.length).toBeGreaterThan(2);
      expect(h.watcher.pending()?.targetVersion).toBe("0.21.0");

      h.advance(60_000);
      await h.watcher.runOnce();
      expect(h.restarts.map((item) => item.targetVersion)).toEqual(["0.21.0"]);
    });

    it("指纹读不到时退回版本号判据（宁可多提醒，也不能漏真部署）", async () => {
      const h = createHarness({
        disk: "0.21.0",
        running: "0.20.0",
        fingerprint: { boot: "build-a", now: "build-a" },
      });

      h.setFingerprint(undefined);
      await h.watcher.runOnce();
      expect(h.notices.length).toBeGreaterThan(0);
      expect(h.watcher.pending()?.targetVersion).toBe("0.21.0");
    });

    it("启动时没取到指纹（dist 缺失）→ 一律按版本号判据", async () => {
      const h = createHarness({
        disk: "0.21.0",
        running: "0.20.0",
        fingerprint: { boot: undefined, now: undefined },
      });

      await h.watcher.runOnce();
      expect(h.notices.length).toBeGreaterThan(0);
    });

    it("指纹没变不再静默：私信超管「可能是上传被跳过，请检查 dist/」，同一版本只提醒一次", async () => {
      // 真机现场（ADR-0065 第 3 条）：版本号升了但 dist 是旧的 —— 以前只记一行日志，
      // 等于对「版本号骗人」哑巴；现在必须私信超管去查。
      const h = createHarness({
        disk: "0.21.0",
        running: "0.20.0",
        fingerprint: { boot: "build-a", now: "build-a" },
        delayMs: 0,
      });

      await h.watcher.runOnce();
      expect(h.notices.map((item) => item.userId)).toEqual(["root", "root2"]);
      const text = h.notices[0]?.card.markdown ?? "";
      expect(text).toContain("可能是上传被跳过");
      expect(text).toContain("检查 `dist/`");
      expect(text).toContain("v0.21.0");
      // 不重启、也没有待重启状态
      expect(h.restarts).toHaveLength(0);
      expect(h.watcher.pending()).toBeUndefined();

      // 同一目标版本只提醒一次（不然每轮扫描都刷屏）
      for (let i = 0; i < 3; i += 1) {
        await h.watcher.runOnce();
      }
      h.advance(3_600_000);
      await h.watcher.runOnce();
      expect(h.notices).toHaveLength(2);

      // 用户后来真的把代码传上来了（指纹变了）→ 按正常部署提醒并重启
      h.setFingerprint("build-b");
      await h.watcher.runOnce();
      expect(h.notices).toHaveLength(4);
      expect(h.watcher.pending()?.targetVersion).toBe("0.21.0");
    });

    it("指纹读不到时仍然按版本号判据，也不发「上传被跳过」提示", async () => {
      const h = createHarness({
        disk: "0.21.0",
        running: "0.20.0",
        fingerprint: { boot: "build-a", now: "build-a" },
      });

      h.setFingerprint(undefined);
      await h.watcher.runOnce();
      expect(h.notices).toHaveLength(2);
      expect(h.notices[0]?.card.markdown).toContain("发现新版本");
      expect(h.notices[0]?.card.markdown).not.toContain("可能是上传被跳过");
    });
  });

  describe("提醒与自动重启解耦（AUTO_RESTART_ON_DEPLOY 只管「到点动不动手」）", () => {
    it("关掉自动重启：照样提醒，但到点不动手；同一版本只提醒一次", async () => {
      const h = createHarness({ autoRestart: false, delayMs: 0 });
      h.setDisk("0.21.0");

      await h.watcher.runOnce();
      expect(h.notices.map((item) => item.userId)).toEqual(["root", "root2"]);
      const text = h.notices[0]?.card.markdown ?? "";
      // 关着的那版文案：明确写「自动重启已关闭，请手动重启加载新版本」
      expect(text).toContain("自动重启已关闭");
      expect(text).toContain("手动重启");
      expect(text).toContain("v0.21.0");
      // 按钮保持「取消 / 立即重启」两个出口
      expect(JSON.stringify(h.notices[0]?.card.keyboard)).toContain("cb:deploy:cancel");
      expect(JSON.stringify(h.notices[0]?.card.keyboard)).toContain("cb:deploy:now");
      // 待提醒状态仍在（用户之后打开开关要能接着走），但到点了也不动手
      expect(h.watcher.pending()?.targetVersion).toBe("0.21.0");

      for (let i = 0; i < 4; i += 1) {
        await h.watcher.runOnce();
      }
      h.advance(3_600_000);
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(0);
      expect(h.notices).toHaveLength(2);
    });

    it("用户后来把自动重启打开 → 下一轮按原计划继续（到点就动手）", async () => {
      const h = createHarness({ autoRestart: false, delayMs: 60_000 });
      h.setDisk("0.21.0");
      await h.watcher.runOnce();
      expect(h.restarts).toHaveLength(0);

      h.setAutoRestart(true);
      h.advance(60_000);
      await h.watcher.runOnce();
      expect(h.restarts).toEqual([
        { requestedBy: "deploy-watcher", reason: "deploy", targetVersion: "0.21.0" },
      ]);
      // 不会再补发一张「发现新版本」
      expect(h.notices).toHaveLength(2);
    });

    it("关着自动重启时点「立即重启」仍然有效（那是人主动要换版本）", async () => {
      const h = createHarness({ autoRestart: false });
      h.setDisk("0.21.0");
      await h.watcher.runOnce();

      expect(h.watcher.restartNow()).toBe(true);
      expect(h.restarts.map((item) => item.targetVersion)).toEqual(["0.21.0"]);
      expect(h.watcher.pending()).toBeUndefined();
    });

    it("生效判据只看扫描间隔：间隔 <= 0 才关闭监测（不管自动重启开关）", async () => {
      const off = createHarness({ checkIntervalMs: 0 });
      off.setDisk("0.21.0");
      await off.watcher.runOnce();
      expect(off.notices).toHaveLength(0);
      expect(off.watcher.pending()).toBeUndefined();

      // 自动重启开着也一样：`<= 0` = 关闭监测
      const on = createHarness({ checkIntervalMs: 0, autoRestart: true });
      on.setDisk("0.21.0");
      await on.watcher.runOnce();
      expect(on.notices).toHaveLength(0);
    });
  });
});
