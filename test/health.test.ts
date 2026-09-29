import { beforeEach, describe, expect, it } from "vitest";

import { HealthRegistry } from "../src/services/health.js";
import {
  moduleForCallback,
  moduleStatusLines,
  startupReportText,
} from "../src/services/commands/healthCommands.js";

/**
 * 层 1（模块隔离加载）：一个模块失败不影响其它模块与进程启动。
 */
describe("HealthRegistry", () => {
  let fail: boolean;

  beforeEach(() => {
    fail = true;
  });

  function registry(): HealthRegistry {
    return new HealthRegistry([
      { key: "activity", load: async () => undefined },
      {
        key: "config",
        load: async () => {
          if (fail) {
            throw new Error("bad row");
          }
        },
      },
    ]);
  }

  it("keeps loading other modules when one fails", async () => {
    const health = registry();
    const report = await health.loadAll();

    expect(report.degraded.map((status) => status.key)).toEqual(["config"]);
    expect(health.isAvailable("activity")).toBe(true);
    expect(health.isAvailable("config")).toBe(false);
    expect(health.reasonOf("config")).toBe("「群规则」初始化失败：bad row");
    expect(health.reasonOf("activity")).toBeUndefined();
  });

  it("retries a single module and reports recovery", async () => {
    const health = registry();
    await health.loadAll();

    fail = false;
    const status = await health.retry("config");

    expect(status.state).toBe("ready");
    expect(health.degraded).toEqual([]);
    expect(health.isAvailable("config")).toBe(true);
  });

  it("treats never-loaded modules as usable (memory mode)", () => {
    const health = registry();
    // 内存模式根本不会调 load()：不能因此把所有功能都判成不可用
    expect(health.isAvailable("config")).toBe(true);
    expect(health.degraded).toEqual([]);
  });

  it("requires every module of a feature to be available", async () => {
    const health = registry();
    await health.loadAll();
    expect(health.isAllAvailable(["activity"])).toBe(true);
    expect(health.isAllAvailable(["activity", "config"])).toBe(false);
  });

  it("rejects duplicate registration", () => {
    const health = registry();
    expect(() =>
      health.register({ key: "activity", load: async () => undefined }),
    ).toThrow(/重复注册/u);
  });
});

describe("module status visibility", () => {
  it("lists degraded modules and migration issues", async () => {
    const health = new HealthRegistry([
      {
        key: "activity",
        load: async () => {
          throw new Error("disk I/O error");
        },
      },
    ]);
    await health.loadAll();

    const lines = moduleStatusLines(health, {
      issues: [{ step: "subscription-scopes", error: "unique failed" }],
    }).join("\n");

    expect(lines).toContain("活动：初始化失败 —— disk I/O error");
    expect(lines).toContain("subscription-scopes：unique failed");
    expect(lines).not.toContain("全部 1 个模块正常");
  });

  it("says everything is fine when nothing degraded", () => {
    const health = new HealthRegistry([
      { key: "activity", load: async () => undefined },
    ]);
    expect(moduleStatusLines(health, { issues: [] }).join("\n")).toContain(
      "全部 1 个模块正常",
    );
  });

  it("writes a startup report mentioning the degraded module", async () => {
    const health = new HealthRegistry([
      {
        key: "config",
        load: async () => {
          throw new Error("bad row");
        },
      },
    ]);
    await health.loadAll();

    const text = startupReportText(health, { issues: [] });
    expect(text).toContain("1 个模块启动失败");
    expect(text).toContain("群规则");
    expect(text).toContain("重试加载");
  });

  it("maps callback namespaces to modules but leaves diagnostics ungated", () => {
    expect(moduleForCallback("activity")).toBe("activity");
    expect(moduleForCallback("punish")).toBe("sanction");
    expect(moduleForCallback("rules")).toBe("config");
    // 诊断 / 恢复入口不受闸门影响
    for (const namespace of ["help", "menu", "status", "health", "restart"]) {
      expect(moduleForCallback(namespace), namespace).toBeUndefined();
    }
  });
});
