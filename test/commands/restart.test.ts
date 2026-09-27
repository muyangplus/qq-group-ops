import { describe, expect, it } from "vitest";

import type { AdminCommandContext } from "../../src/services/commands/context.js";
import { restartCard } from "../../src/services/commands/restartCommands.js";
import { PermissionService } from "../../src/services/permissions.js";
import { createRestartHook } from "../../src/services/restart.js";
import { restartRequests, service } from "../helpers/adminCommandsHarness.js";

/**
 * `/restart`：只打开**确认卡**，真正重启走 `cb:restart:go`；
 * 权限仅全局超管；没有装配重启钩子时明确拒绝（不把进程杀掉）。
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
    expect(card.rich.markdown).toContain("自我重启助手");
    expect(card.rich.markdown).toContain("助手没起来时旧进程**不会退出**");
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
    expect(restartRequests).toEqual([{ requestedBy: "root" }]);
    // 群内结果 @ 发起人
    expect(card.rich.markdown).toContain("<@!root>");
    expect(card.rich.markdown).toContain("已安排重启");
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
});
