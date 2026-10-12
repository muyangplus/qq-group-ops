import { describe, expect, it } from "vitest";

import { AdminCommandService } from "../../src/services/adminCommands.js";
import {
  auditLog,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  permissions,
  service,
  stopRequests,
  stopService,
} from "../helpers/adminCommandsHarness.js";

/**
 * `/stop` 家族（ADR-0070，用户 2026-10-12 提出）：
 * `/stop` 停进程（带二次确认）、`/stop <时长|forever>` 静默、`/start` 恢复；
 * 只有全局超管、只在私信，每个动作写审计。
 */
describe("AdminCommandService · /stop 与 /start", () => {
  it("只有全局超管能用", async () => {
    for (const userId of ["member", "mod", "admin"]) {
      const result = await service.handle(undefined, userId, "/stop");
      expect(result.ok, userId).toBe(false);
      expect(result.text).toContain("只有全局超管");
    }
    const start = await service.handle(undefined, "member", "/start");
    expect(start.ok).toBe(false);
  });

  it("只能在私信里用（群里发 → 群里静默、结果私信）", async () => {
    const result = await service.handle("g1", "root", "/stop");
    expect(result.silent).toBe(true);
    expect(result.text).toContain("结果已私信发送");
  });

  it("`/stop`（无参）→ 选择卡：二次确认 + 几档静默按钮", async () => {
    const result = await service.handle(undefined, "root", "/stop");

    expect(result.ok, result.text).toBe(true);
    const keyboard = JSON.stringify(result.rich.keyboard);
    expect(keyboard).toContain("cb:stop:go");
    expect(keyboard).toContain("cb:stop:silence:1h");
    expect(keyboard).toContain("cb:stop:silence:forever");
    expect(keyboard).toContain("cb:stop:resume");
    // 二次确认弹窗必须写明「不会再自动起来」
    expect(keyboard).toContain("不会再自动起来");
  });

  it("`/stop 30m` → 立即静默 + 写审计", async () => {
    const result = await service.handle(undefined, "root", "/stop 30m");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已进入静默");
    expect(stopService.silenced()).toBe(true);
    expect(stopService.current()?.until).not.toBeNull();
    expect(auditLog.all().map((record) => record.action)).toEqual([
      "platform_silence",
    ]);
  });

  it("`/stop forever` → 永久静默（`until === null`，要 `/start` 才结束）", async () => {
    await service.handle(undefined, "root", "/stop forever");

    expect(stopService.silenced()).toBe(true);
    expect(stopService.current()?.until).toBeNull();
  });

  it("时长写错 → 什么都不改", async () => {
    const result = await service.handle(undefined, "root", "/stop 一会儿");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("认不出时长");
    expect(stopService.silenced()).toBe(false);
    expect(auditLog.all()).toHaveLength(0);
  });

  it("确认停止 → 请求停机（不真的退进程）+ 审计 platform_stop", async () => {
    const result = service.stopGoCard("root");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("正在停机");
    expect(result.text).toContain("不会再自动起来");
    expect(stopRequests).toEqual([{ requestedBy: "root", reason: "manual" }]);
    expect(auditLog.all().map((record) => record.action)).toEqual([
      "platform_stop",
    ]);
  });

  it("`/start` → 恢复 + 审计 platform_resume（静默中可用）", async () => {
    await service.handle(undefined, "root", "/stop forever");

    const result = await service.handle(undefined, "root", "/start");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("已恢复");
    expect(stopService.silenced()).toBe(false);
    expect(auditLog.all().map((record) => record.action)).toEqual([
      "platform_silence",
      "platform_resume",
    ]);
  });

  it("没在静默时 `/start` 如实说（不假装改了什么）", async () => {
    const result = await service.handle(undefined, "root", "/start");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("现在没有在静默");
    expect(auditLog.all()).toHaveLength(0);
  });

  it("卡片按钮：`cb:stop:silence:1h` 静默、`cb:stop:resume` 恢复", async () => {
    const silenced = service.stopSilenceCallbackCard("root", "1h");
    expect(silenced.ok).toBe(true);
    expect(stopService.silenced()).toBe(true);

    const resumed = service.stopResumeCard("root");
    expect(resumed.ok).toBe(true);
    expect(stopService.silenced()).toBe(false);
  });

  it("`/status proc` 写明「静默中」（排查「机器人怎么不理人」的第一线索）", async () => {
    await service.handle(undefined, "root", "/stop 10m");

    const status = await service.handle(undefined, "root", "/status proc");

    expect(status.rich.markdown).toContain("静默中");
    expect(status.rich.markdown).toContain("非超管的消息一律不处理");
    expect(status.rich.markdown).toContain("/start");
  });

  it("没装配停机状态时明确拒绝", async () => {
    const bare = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
    });

    const result = await bare.handle(undefined, "root", "/stop");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有装配停机状态");
  });

  it("没装配停机钩子时：仍然能静默，但卡片上没有「确认停止」", async () => {
    const bare = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      stop: stopService,
    });

    const result = await bare.handle(undefined, "root", "/stop");
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.rich.keyboard)).not.toContain("cb:stop:go");
    expect(result.text).toContain("没有装配停机钩子");
    // 静默按钮仍然在（静默不依赖进程管理器）
    expect(JSON.stringify(result.rich.keyboard)).toContain("cb:stop:silence:1h");
  });
});
