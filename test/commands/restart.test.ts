import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AdminCommandContext } from "../../src/services/commands/context.js";
import {
  restartCard,
  restartCheckCard,
} from "../../src/services/commands/restartCommands.js";
import { PermissionService } from "../../src/services/permissions.js";
import { createRestartHook } from "../../src/services/restart.js";
import { restartRequests, service } from "../helpers/adminCommandsHarness.js";

/**
 * `/restart`：只打开**确认卡**，真正重启走 `cb:restart:go`；
 * 权限仅全局超管；没有装配重启钩子时明确拒绝（不把进程杀掉）。
 *
 * 另外两条用户口径：自检没过时要把 `data/startup-check.json` 发过来（卡上一个按钮），
 * 且**手动重试不限次数**（只有部署监测的自动重试对同一版本只试一次）。
 */
describe("AdminCommandService · /restart", () => {
  it("只有全局超管能用", async () => {
    const denied = await service.handle("g1", "admin", "/restart");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("只有全局超管");
    expect(restartRequests).toHaveLength(0);

    const mod = await service.handle("g1", "mod", "/restart");
    expect(mod.ok).toBe(false);
    expect(restartRequests).toHaveLength(0);
  });

  it("`/restart` 只出确认卡，不直接重启", async () => {
    const card = await service.handle("g1", "root", "/restart");
    expect(card.ok).toBe(true);
    expect(card.rich.markdown).toContain("重启机器人");
    expect(card.rich.markdown).toContain("当前版本");
    expect(card.rich.markdown).toContain("大约 5 秒不能响应");
    expect(card.rich.markdown).toContain("**不会**关掉机器人");
    // 手动重试不受「同一版本只试一次」的限制（那是部署监测自动重试的规则）
    expect(card.rich.markdown).toContain("手动重启不限次数");
    const keyboard = JSON.stringify(card.rich.keyboard);
    expect(keyboard).toContain("cb:restart:go");
    expect(keyboard).toContain("确认重启");
    // 二次确认弹窗（官方 modal）也要带上
    expect(keyboard).toContain("modal");
    expect(keyboard).toContain("短暂离线");
    expect(restartRequests).toHaveLength(0);
  });

  it("回调 `cb:restart:go` 才真正请求重启，并把发起人记下来", async () => {
    const card = service.restartNowCard("root", "g1");
    expect(card.ok).toBe(true);
    expect(restartRequests).toEqual([
      { requestedBy: "root", reason: "manual" },
    ]);
    // 群内结果 @ 发起人
    expect(card.rich.markdown).toContain("<@!root>");
    expect(card.rich.markdown).toContain("正在重启");
  });

  it("没装配重启钩子时明确拒绝（纯测试 / 直接 import 服务层）", () => {
    const ctx = {
      permissions: new PermissionService({
        superAdminIds: new Set(["root"]),
      }),
      restart: undefined,
    } as unknown as AdminCommandContext;

    const card = restartCard(ctx, "root");
    expect(card.ok).toBe(false);
    expect(card.rich.markdown).toContain("重启不可用");
    expect(card.rich.markdown).toContain("没有装配重启钩子");
  });

  it("钩子同步抛错时报告「未受理」，不让异常冒到回调层", () => {
    const hook = createRestartHook(() => {
      throw new Error("助手起不来");
    });

    expect(hook.available).toBe(true);
    expect(hook.request({ requestedBy: "root" })).toBe(false);
    expect(createRestartHook(undefined).request({ requestedBy: "root" })).toBe(
      false,
    );
  });

  it("「再次检查」不过时：内联自检原文，并给「重新检查并重启」与「自检结果」两个出口", () => {
    const ctx = {
      permissions: new PermissionService({
        superAdminIds: new Set(["root"]),
      }),
      restart: {
        available: true,
        request: () => true,
        preflight: () => ({
          ok: false,
          exitCode: 1,
          summary: { ok: false, error: "database is not open" },
          reason: "自检退出码 1：database is not open",
        }),
      },
    } as unknown as AdminCommandContext;

    const card = restartCheckCard(ctx, "root");
    const keyboard = JSON.stringify(card.rich.keyboard);

    expect(card.ok).toBe(false);
    expect(card.rich.markdown).toContain("自检不通过");
    expect(card.rich.markdown).toContain("database is not open");
    expect(card.rich.markdown).toContain("手动重试不限次数");
    expect(keyboard).toContain("cb:restart:go");
    expect(keyboard).toContain("cb:restart:detail");
    expect(keyboard).toContain("cb:restart:force");
    expect(keyboard).toContain("cb:restart:again");
  });
});

/** 回调 `cb:restart:detail`：把 `data/startup-check.json` 原文发过来。 */
describe("AdminCommandService · 自检结果", () => {
  function tempCheckFile(payload: unknown): string {
    const file = join(tmpdir(), `qqops-startup-check-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(payload), "utf8");
    return file;
  }

  it("超管：原文（格式化后的 JSON）随卡发出来", () => {
    const file = tempCheckFile({
      at: "2026-10-02T07:20:00.000Z",
      ok: false,
      error: "database is not open",
    });

    const card = service.startupCheckCard("root", file);

    expect(card.ok).toBe(false);
    expect(card.rich.markdown).toContain("自检结果");
    expect(card.rich.markdown).toContain('"error": "database is not open"');
    expect(card.rich.markdown).toContain("不通过");
    expect(JSON.stringify(card.rich.keyboard)).toContain("cb:restart:go");
    rmSync(file, { force: true });
  });

  it("读不到文件时明确说清（而不是发一张空卡）", () => {
    const card = service.startupCheckCard(
      "root",
      join(tmpdir(), "qqops-startup-check-missing.json"),
    );

    expect(card.rich.markdown).toContain("读不到自检结果");
    expect(card.rich.markdown).toContain("重新检查并重启");
  });

  it("非超管拒绝（服务端判定，不靠界面隐藏）", () => {
    const file = tempCheckFile({ ok: true });

    const card = service.startupCheckCard("admin", file);

    expect(card.ok).toBe(false);
    expect(card.rich.markdown).toContain("只有全局超管");
    rmSync(file, { force: true });
  });
});
