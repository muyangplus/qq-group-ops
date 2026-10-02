import { describe, expect, it } from "vitest";

import type { Scheduler } from "../src/adapters/reconnectingWebSocketGateway.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestStatus } from "../src/core/enums.js";
import { TickScheduler } from "../src/services/tickScheduler.js";

class FakeScheduler implements Scheduler {
  public readonly callbacks: Array<{ callback: () => void; delayMs: number }> = [];

  public setTimeout(callback: () => void, delayMs: number): unknown {
    this.callbacks.push({ callback, delayMs });
    return this.callbacks.length;
  }

  public clearTimeout(handle: unknown): void {
    const index = Number(handle) - 1;
    if (index >= 0 && index < this.callbacks.length) {
      this.callbacks.splice(index, 1);
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/**
 * 统一计时任务调度器（P1）：一个扫描周期驱动所有周期检查，
 * 每个任务只声明自己的最小间隔，是否到点由调度器判断。
 */
describe("TickScheduler", () => {
  function create(intervalMs = 1_000): {
    scheduler: TickScheduler;
    fake: FakeScheduler;
    advance: (ms: number) => void;
    log: string[];
  } {
    const fake = new FakeScheduler();
    let now = 0;
    const log: string[] = [];
    const scheduler = new TickScheduler({
      intervalMs,
      scheduler: fake,
      clock: () => now,
    });
    return {
      scheduler,
      fake,
      advance: (ms: number) => {
        now += ms;
      },
      log,
    };
  }

  it("一轮扫所有到期任务，未到点的按 minIntervalMs 跳过", async () => {
    const { scheduler, advance } = create();
    const runs: string[] = [];
    scheduler.register({
      name: "every-tick",
      run: () => {
        runs.push("every-tick");
      },
    });
    scheduler.register({
      name: "hourly",
      minIntervalMs: 3_600_000,
      run: () => {
        runs.push("hourly");
      },
    });

    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(runs).toEqual(["every-tick", "hourly", "every-tick"]);

    advance(3_600_000);
    await scheduler.runOnce();
    expect(runs).toEqual([
      "every-tick",
      "hourly",
      "every-tick",
      "every-tick",
      "hourly",
    ]);
  });

  it("串行执行：前一个任务 await 完才跑下一个", async () => {
    const { scheduler } = create();
    const order: string[] = [];
    scheduler.register({
      name: "slow",
      run: async () => {
        order.push("slow:start");
        await sleep(5);
        order.push("slow:end");
      },
    });
    scheduler.register({
      name: "fast",
      run: () => {
        order.push("fast");
      },
    });

    await scheduler.runOnce();
    expect(order).toEqual(["slow:start", "slow:end", "fast"]);
  });

  it("单个任务抛错只记日志，后续任务照常跑", async () => {
    const failures: Array<{ task: string; error: unknown }> = [];
    const fake = new FakeScheduler();
    const scheduler = new TickScheduler({
      intervalMs: 1_000,
      scheduler: fake,
      clock: () => 0,
      onError: (task, error) => {
        failures.push({ task, error });
      },
    });
    const ran: string[] = [];
    scheduler.register({
      name: "boom",
      run: () => {
        throw new Error("任务炸了");
      },
    });
    scheduler.register({
      name: "after",
      run: () => {
        ran.push("after");
      },
    });

    await scheduler.runOnce();
    expect(failures.map((item) => item.task)).toEqual(["boom"]);
    expect(ran).toEqual(["after"]);
  });

  it("runOnStart: false 的任务跳过启动那次，一个周期后才上场", async () => {
    const { scheduler, advance } = create();
    const runs: string[] = [];
    scheduler.register({
      name: "appeal-watcher",
      runOnStart: false,
      minIntervalMs: 1_000,
      run: () => {
        runs.push("appeal-watcher");
      },
    });
    scheduler.register({
      name: "retention",
      run: () => {
        runs.push("retention");
      },
    });

    await scheduler.runOnce();
    expect(runs).toEqual(["retention"]);

    advance(1_000);
    await scheduler.runOnce();
    expect(runs).toEqual(["retention", "appeal-watcher", "retention"]);
  });

  it("固定节拍：只排一个定时器，stop 后不再排", () => {
    const { scheduler, fake } = create(5_000);
    scheduler.register({ name: "x", run: () => undefined });

    scheduler.start();
    expect(scheduler.started).toBe(true);
    expect(fake.callbacks).toHaveLength(1);
    expect(fake.callbacks[0]?.delayMs).toBe(5_000);

    scheduler.stop();
    expect(scheduler.started).toBe(false);
    expect(fake.callbacks).toHaveLength(0);
  });

  it("intervalMs <= 0 = 统一总开关：不排任何定时器", () => {
    const { scheduler, fake } = create(0);
    scheduler.register({ name: "x", run: () => undefined });

    scheduler.start();
    expect(scheduler.started).toBe(false);
    expect(fake.callbacks).toHaveLength(0);
  });

  it("overrun 保护：上一轮没跑完时跳过这一轮", async () => {
    const { scheduler, fake } = create(1_000);
    let started = 0;
    let release: (() => void) | undefined;
    scheduler.register({
      name: "slow",
      run: async () => {
        started += 1;
        await new Promise<void>((done) => {
          release = done;
        });
      },
    });

    scheduler.start();
    fake.callbacks[0]?.callback(); // 第 1 轮：跑起来了但没结束
    await sleep(0);
    release?.(); // 先不放行，模拟「还在跑」
    expect(started).toBe(1);

    // 第 2 轮：上一轮 in-flight → 跳过，不再叠加
    fake.callbacks[0]?.callback();
    await sleep(0);
    expect(started).toBe(1);
  });

  it("快照：给出每个任务的上次/下次执行与降级状态（只读，不触发任务）", async () => {
    const { scheduler, advance } = create();
    let enabled = true;
    const runs: string[] = [];
    scheduler.register({
      name: "fast",
      run: () => {
        runs.push("fast");
      },
    });
    scheduler.register({
      name: "slow",
      minIntervalMs: 10_000,
      run: () => {
        runs.push("slow");
      },
    });
    scheduler.register({
      name: "degraded",
      enabled: () => enabled,
      run: () => {
        runs.push("degraded");
      },
    });
    scheduler.start();

    // 还没跑过：没有上次执行时间
    const before = scheduler.snapshot();
    expect(before.intervalMs).toBe(1_000);
    expect(before.started).toBe(true);
    expect(before.tasks.map((task) => task.name)).toEqual([
      "fast",
      "slow",
      "degraded",
    ]);
    expect(before.tasks.every((task) => task.lastRunAt === undefined)).toBe(true);

    await scheduler.runOnce();
    expect(runs).toEqual(["fast", "slow", "degraded"]);

    // 打开 / 关闭降级闸门都如实反映（快照本身不该触发任务）
    enabled = false;
    advance(1_000);
    const after = scheduler.snapshot();
    const byName = new Map(after.tasks.map((task) => [task.name, task]));
    expect(byName.get("fast")).toMatchObject({
      minIntervalMs: 0,
      enabled: true,
      lastRunAt: new Date(0).toISOString(),
    });
    expect(byName.get("slow")?.minIntervalMs).toBe(10_000);
    // 下一轮扫描在 now + intervalMs（= 2000）；slow 自己还没到点（0 + 10s），两者取较晚者
    expect(byName.get("slow")?.nextRunAt).toBe(new Date(10_000).toISOString());
    expect(byName.get("fast")?.nextRunAt).toBe(new Date(2_000).toISOString());
    expect(byName.get("degraded")?.enabled).toBe(false);
    expect(runs).toEqual(["fast", "slow", "degraded"]);
  });

  it("快照：调度器停着（SCAN_INTERVAL_MS=0）时 started=false 且没有下次时间", () => {
    const { scheduler } = create(0);
    scheduler.register({ name: "retention", minIntervalMs: 60_000, run: () => undefined });

    const state = scheduler.snapshot();

    expect(state.intervalMs).toBe(0);
    expect(state.started).toBe(false);
    expect(state.tasks[0]?.nextRunAt).toBeUndefined();
  });

  it("待审批 TTL 任务：每轮检查，过期申请立刻从 /pending 消失", async () => {
    const auditLog = new JoinAuditService();
    auditLog.submit("g1", "u1", "待审批", "pending");
    const now = Date.now();
    auditLog.setPendingTtlMs(1_000);

    const scheduler = new TickScheduler({ intervalMs: 1_000 });
    scheduler.register({
      name: "join-pending-ttl",
      run: () => {
        auditLog.expireStalePending(now + 2_000);
      },
    });

    await scheduler.runOnce();
    expect(auditLog.pending("g1")).toEqual([]);
    expect(auditLog.get("pending").status).toBe(JoinRequestStatus.Expired);
  });
});
