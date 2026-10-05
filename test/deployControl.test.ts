import { describe, expect, it } from "vitest";

import { combineDeployControls } from "../src/services/deployControl.js";
import type { DeployControl, DeployPending } from "../src/services/deployWatcher.js";

/**
 * 两条「新版本」来源的合流（ADR-0065 后续修正）。
 *
 * 生产上同时存在：
 * - 包模式（`DeployInstaller`）：产物包校验通过 → 提醒 + 宽限期到点**替换产物并重启**；
 * - 逐文件模式（`DeployWatcher`）：磁盘版本变了 → 提醒 + 宽限期到点重启。
 *
 * 命令层（`/deploy cancel`、`/deploy now`、卡片按钮）与后台「状态」页只认一个控制面，
 * 所以这里钉住路由规则：**作用在真正有等待项的那个来源上**，且包模式优先。
 */

function pendingOf(targetVersion: string, mode: "files" | "package"): DeployPending {
  return {
    targetVersion,
    currentVersion: "1.0.0",
    detectedAt: "2026-10-04T00:00:00.000Z",
    deadlineAt: "2026-10-04T00:10:00.000Z",
    mode,
  };
}

function fake(
  pending: DeployPending | undefined,
  log: string[],
): DeployControl {
  return {
    pending: () => pending,
    cancel: () => {
      if (pending === undefined) {
        return false;
      }
      log.push(`cancel:${pending.targetVersion}`);
      return true;
    },
    restartNow: () => {
      if (pending === undefined) {
        return false;
      }
      log.push(`now:${pending.targetVersion}`);
      return true;
    },
  };
}

describe("combineDeployControls", () => {
  it("pending() 取第一个有等待项的来源（包模式优先）", () => {
    const log: string[] = [];
    const combined = combineDeployControls([
      fake(pendingOf("0.29.2", "package"), log),
      fake(pendingOf("0.27.3", "files"), log),
    ]);

    expect(combined.pending()?.targetVersion).toBe("0.29.2");
    expect(combined.pending()?.mode).toBe("package");
  });

  it("包模式没有等待项时回落到逐文件模式", () => {
    const log: string[] = [];
    const combined = combineDeployControls([
      fake(undefined, log),
      fake(pendingOf("0.27.3", "files"), log),
    ]);

    expect(combined.pending()?.mode).toBe("files");
    expect(combined.cancel()).toBe(true);
    // 只作用在真有等待项的那个来源上（空的那个不会被误调）
    expect(log).toEqual(["cancel:0.27.3"]);
  });

  it("两条都有等待项时，取消 / 立即生效都打在包模式那一条上", () => {
    const log: string[] = [];
    const combined = combineDeployControls([
      fake(pendingOf("0.29.2", "package"), log),
      fake(pendingOf("0.27.3", "files"), log),
    ]);

    expect(combined.restartNow()).toBe(true);
    expect(log).toEqual(["now:0.29.2"]);
  });

  it("都没等待项：pending() 为空、取消 / 立即生效都返回 false", () => {
    const log: string[] = [];
    const combined = combineDeployControls([fake(undefined, log), undefined]);

    expect(combined.pending()).toBeUndefined();
    expect(combined.cancel()).toBe(false);
    expect(combined.restartNow()).toBe(false);
    expect(log).toEqual([]);
  });

  it("忽略未装配的来源（假模式没有部署监测）", () => {
    const log: string[] = [];
    const combined = combineDeployControls([
      undefined,
      fake(pendingOf("0.27.3", "files"), log),
    ]);

    expect(combined.pending()?.targetVersion).toBe("0.27.3");
  });
});
