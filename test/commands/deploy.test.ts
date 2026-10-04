import { describe, expect, it } from "vitest";

import type { AdminCommandContext } from "../../src/services/commands/context.js";
import {
  deployCancelCard,
  deployRestartNowCard,
  deployRollbackCard,
} from "../../src/services/commands/deployCommands.js";
import type { DeployPending } from "../../src/services/deployWatcher.js";
import { PermissionService } from "../../src/services/permissions.js";

function context(options: {
  pending?: DeployPending | undefined;
  restartNow?: boolean;
  userId?: string;
  /** 回滚目标：`undefined` = 没有可回滚的版本（不渲染入口）。 */
  rollback?: { version: string; currentVersion: string; sha256: string } | undefined;
  /** 回滚结果：`ok:false` 时如实回原因。 */
  rollbackResult?: { ok: boolean; message: string };
}): {
  ctx: AdminCommandContext;
  cancelled: () => number;
  restarted: () => number;
  rollbacks: () => number;
} {
  let cancelled = 0;
  let restarted = 0;
  let rollbacks = 0;
  const pending = options.pending;
  const ctx = {
    permissions: new PermissionService({
      superAdminIds: new Set([options.userId ?? "root"]),
    }),
    helpers: { mention: () => "" },
    deploy: {
      pending: () => pending,
      cancel: () => {
        cancelled += 1;
        return true;
      },
      restartNow: () => {
        restarted += 1;
        return options.restartNow ?? true;
      },
    },
    install: {
      rollbackTarget: () => options.rollback,
      appliedVersion: () => options.rollback?.currentVersion ?? "",
      rollback: async () => {
        rollbacks += 1;
        return {
          ok: options.rollbackResult?.ok ?? true,
          version: options.rollback?.version ?? "",
          code: (options.rollbackResult?.ok ?? true) ? "ok" : "no_package",
          message: options.rollbackResult?.message ?? "已回滚。",
          rolledBack: true,
        };
      },
    },
  } as unknown as AdminCommandContext;
  return {
    ctx,
    cancelled: () => cancelled,
    restarted: () => restarted,
    rollbacks: () => rollbacks,
  };
}

const PENDING: DeployPending = {
  targetVersion: "0.21.0",
  currentVersion: "0.20.0",
  detectedAt: "2026-09-28T00:00:00.000Z",
  deadlineAt: "2026-09-28T01:00:00.000Z",
};

/** 新版本卡上的两个按钮：取消自动重启 / 立即重启。 */
describe("部署监测的回调卡", () => {
  it("取消自动重启：只说清「不会再自动重启」，并给立即重启入口", () => {
    const h = context({ pending: PENDING });
    const card = deployCancelCard(h.ctx, "root");

    expect(card.ok).toBe(true);
    expect(h.cancelled()).toBe(1);
    expect(card.rich.markdown).toContain("已取消自动重启");
    expect(card.rich.markdown).toContain("v0.21.0");
    expect(card.rich.markdown).toContain("不会再自动重启");
    expect(JSON.stringify(card.rich.keyboard)).toContain("cb:deploy:now");
  });

  it("没有待上线版本时给出直白提示", () => {
    const h = context({ pending: undefined });
    const card = deployCancelCard(h.ctx, "root");
    expect(card.ok).toBe(true);
    expect(card.rich.markdown).toContain("没有待上线的新版本");
    expect(h.cancelled()).toBe(0);
  });

  it("非超管不能操作", () => {
    const h = context({ pending: PENDING, userId: "admin" });
    expect(deployCancelCard(h.ctx, "u1").ok).toBe(false);
    expect(deployRestartNowCard(h.ctx, "u1").ok).toBe(false);
    expect(h.cancelled()).toBe(0);
    expect(h.restarted()).toBe(0);
  });

  it("立即重启：马上触发，并说清新旧版本", () => {
    const h = context({ pending: PENDING });
    const card = deployRestartNowCard(h.ctx, "root", "g1");

    expect(card.ok).toBe(true);
    expect(h.restarted()).toBe(1);
    expect(card.rich.markdown).toContain("正在重启");
    expect(card.rich.markdown).toContain("v0.21.0");
  });

  it("立即重启失败时明确说「机器人仍在运行旧版本」", () => {
    const h = context({ pending: PENDING, restartNow: false });
    const card = deployRestartNowCard(h.ctx, "root");

    expect(card.ok).toBe(false);
    expect(card.rich.markdown).toContain("重启没成功");
    expect(card.rich.markdown).toContain("仍在运行");
    expect(card.rich.markdown).toContain("data/restart-failed.json");
  });

  /** 回滚（ADR-0065）：入口在 `/status proc` 卡片上，回调 `cb:deploy:rollback` 执行。 */
  describe("回滚到上一版本", () => {
    it("有可回滚版本时：回执写清 vX → vY，并说明同步状态会被作废", async () => {
      const h = context({
        rollback: { version: "0.20.0", currentVersion: "0.21.0", sha256: "abc" },
      });
      const card = await deployRollbackCard(h.ctx, "root");

      expect(card.ok).toBe(true);
      expect(h.rollbacks()).toBe(1);
      expect(card.rich.markdown).toContain("v0.21.0 → v0.20.0");
      expect(card.rich.markdown).toContain("指纹自证");
      expect(card.rich.markdown).toContain("FTP 同步状态");
    });

    it("没有可回滚版本时如实说（不假装成功）", async () => {
      const h = context({ rollback: undefined });
      const card = await deployRollbackCard(h.ctx, "root");

      expect(h.rollbacks()).toBe(0);
      expect(card.rich.markdown).toContain("没有可回滚");
    });

    it("回滚失败时保留原话 + 明确「现役产物没有被改动」", async () => {
      const h = context({
        rollback: { version: "0.20.0", currentVersion: "0.21.0", sha256: "abc" },
        rollbackResult: { ok: false, message: "归档里找不到 v0.20.0 的包。" },
      });
      const card = await deployRollbackCard(h.ctx, "root");

      expect(card.ok).toBe(false);
      expect(card.rich.markdown).toContain("回滚没成功");
      expect(card.rich.markdown).toContain("归档里找不到");
      expect(card.rich.markdown).toContain("没有被改动");
    });

    it("非超管不能回滚", async () => {
      const h = context({
        userId: "admin",
        rollback: { version: "0.20.0", currentVersion: "0.21.0", sha256: "abc" },
      });
      const card = await deployRollbackCard(h.ctx, "u1");

      expect(card.ok).toBe(false);
      expect(h.rollbacks()).toBe(0);
    });
  });
});
