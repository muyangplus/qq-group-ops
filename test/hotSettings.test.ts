import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import type { PlatformSettingsRepository } from "../src/db/platformSettingsRepository.js";
import type { Scheduler } from "../src/adapters/reconnectingWebSocketGateway.js";
import type { AuditLogStore } from "../src/services/audit.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import { RetentionService } from "../src/services/retention.js";
import { TickScheduler } from "../src/services/tickScheduler.js";

class FakeRepository implements PlatformSettingsRepository {
  public readonly rows = new Map<string, string>();
  public async findAll() {
    return [...this.rows.entries()].map(([key, value]) => ({ key, value }));
  }
  public async save(setting: { key: string; value: string }) {
    this.rows.set(setting.key, setting.value);
  }
  public async remove(key: string) {
    this.rows.delete(key);
  }
}

/** 手动时钟/定时器桩：用来断言「按当前配置」排节拍。 */
class ManualScheduler implements Scheduler {
  public delays: number[] = [];
  public setTimeout(callback: () => void, delayMs: number): unknown {
    this.delays.push(delayMs);
    return { callback };
  }
  public clearTimeout(): void {
    // 测试里不需要真的取消
  }
}

/**
 * P1 验收：`/config` 改完**立即生效、不用重启** —— 服务保留的是取值函数，
 * 每次用的时候读平台配置的当前值。
 */
describe("热配置立即生效", () => {
  it("保留期：改成 0 之后这一轮就不再清理（同一个服务实例）", async () => {
    const repository = new FakeRepository();
    const store = new PlatformSettingsStore(loadSettings({}), repository);
    await store.load();

    const pruned: number[] = [];
    const auditLog = {
      pruneOlderThan: async () => {
        pruned.push(1);
        return 3;
      },
      // 只用到 pruneOlderThan，其余不参与
    } as unknown as AuditLogStore;
    const joinAudit = { pruneReviewedOlderThan: async () => 0 } as never;
    const retention = new RetentionService(auditLog, joinAudit, {
      auditLogRetentionDays: () => store.get("auditLogRetentionDays"),
      joinRequestRetentionDays: () => store.get("joinRequestRetentionDays"),
      rawMessageRetentionDays: () => store.get("rawMessageRetentionDays"),
    });

    await retention.runOnce();
    expect(pruned).toHaveLength(1);

    // `/config set auditLogRetentionDays 0` → 不再清理
    expect((await store.set("auditLogRetentionDays", "0")).ok).toBe(true);
    const second = await retention.runOnce();
    expect(pruned).toHaveLength(1);
    expect(second.auditRecordsRemoved).toBe(0);
  });

  it("扫描周期：改完 restart() 按新值排节拍，改成 0 就停", async () => {
    const repository = new FakeRepository();
    const store = new PlatformSettingsStore(loadSettings({}), repository);
    await store.load();

    const scheduler = new ManualScheduler();
    const tick = new TickScheduler({
      intervalMs: () => store.get("scanIntervalMs"),
      scheduler,
      onError: () => undefined,
    });
    tick.start();
    expect(scheduler.delays).toEqual([60_000]);

    await store.set("scanIntervalMs", "5000");
    tick.restart();
    expect(scheduler.delays.at(-1)).toBe(5_000);

    // 改成 0 = 关闭所有周期任务
    await store.set("scanIntervalMs", "0");
    tick.restart();
    expect(scheduler.delays.at(-1)).toBe(5_000);
    expect(tick.started).toBe(false);
  });
});
