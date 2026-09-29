import { beforeEach, describe, expect, it } from "vitest";

import { AdminCommandService } from "../../src/services/adminCommands.js";
import { HealthRegistry } from "../../src/services/health.js";
import {
  auditLog,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  permissions,
} from "../helpers/adminCommandsHarness.js";

/**
 * 层 2（功能闸门）：模块降级时它的功能域被**拒绝执行**，别的功能与诊断入口不受影响。
 */
describe("AdminCommandService · 模块闸门", () => {
  let failActivity: boolean;
  let health: HealthRegistry;
  let service: AdminCommandService;

  beforeEach(async () => {
    failActivity = true;
    health = new HealthRegistry([
      { key: "activity", load: async () => {
        if (failActivity) {
          throw new Error("活动表读取失败");
        }
      } },
      { key: "config", load: async () => undefined },
    ]);
    await health.loadAll();
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      health,
    });
  });

  it("拒绝降级模块的指令，并说清原因", async () => {
    const result = await service.handle("g1", "root", "/activity");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("功能不可用");
    expect(result.text).toContain("活动");
    expect(result.text).toContain("活动表读取失败");
    // 超管能拿到「重试加载」
    expect(JSON.stringify(result.rich.keyboard)).toContain("cb:health:retry:activity");
  });

  it("不拦其它功能域，也不拦诊断入口", async () => {
    expect((await service.handle("g1", "root", "/rules")).ok).toBe(true);
    expect((await service.handle("g1", "root", "/help")).ok).toBe(true);
    expect((await service.handle("g1", "root", "/status")).ok).toBe(true);
    const proc = service.processCard("root");
    expect(proc.rich.markdown).toContain("活动：初始化失败 —— 活动表读取失败");
  });

  it("只有全局超管能重试加载，修好后立刻恢复", async () => {
    const denied = await service.moduleRetryCard("admin", "activity");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("只有全局超管");
    expect(health.isAvailable("activity")).toBe(false);

    failActivity = false;
    const retried = await service.moduleRetryCard("root", "activity");
    expect(retried.ok).toBe(true);
    expect(retried.rich.markdown).toContain("模块已恢复");
    expect(health.isAvailable("activity")).toBe(true);
    // 恢复后不再是「功能不可用」的拒绝卡（列表为空是正常的业务结果）
    const after = await service.handle("g1", "root", "/activity");
    expect(after.text).not.toContain("功能不可用");
  });

  it("重试仍然失败时保留降级并回报原因", async () => {
    const retried = await service.moduleRetryCard("root", "activity");
    expect(retried.rich.markdown).toContain("仍然不可用");
    expect(health.isAvailable("activity")).toBe(false);
  });

  it("未知模块名不会崩", async () => {
    const result = await service.moduleRetryCard("root", "nope");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("未知模块");
  });
});
