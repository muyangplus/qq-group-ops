import { describe, expect, it } from "vitest";

import type { AdminCommandContext } from "../../src/services/commands/context.js";
import {
  deployCancelCard,
  deployRestartNowCard,
} from "../../src/services/commands/deployCommands.js";
import type { DeployPending } from "../../src/services/deployWatcher.js";
import { PermissionService } from "../../src/services/permissions.js";

function context(options: {
  pending?: DeployPending | undefined;
  restartNow?: boolean;
  userId?: string;
}): {
  ctx: AdminCommandContext;
  cancelled: () => number;
  restarted: () => number;
} {
  let cancelled = 0;
  let restarted = 0;
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
  } as unknown as AdminCommandContext;
  return {
    ctx,
    cancelled: () => cancelled,
    restarted: () => restarted,
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
});
