import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch } from "@/test/fetch";
import StatusView from "@/views/StatusView.vue";

/**
 * 状态页（E2-c / 运维面）：
 * - 平台超管 240 才发请求（非超管连请求都不发）；
 * - 降级模块给「重试加载」按钮（与机器人 `/status proc` 同一入口），正常模块禁用；
 * - 登录令牌：按成员聚合的未用链接 + 机器令牌（只报 scope）+ 吊销（二次确认，会话不受影响）；
 * - 重试 / 吊销后刷新对应数据；「仍然起不来」如实显示服务端原话，不当成页面错误。
 */
function signIn(platformLevel: number): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: platformLevel >= 240 ? "boss" : "mod",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { platformLevel, groups: [] },
  };
}

const STATUS = {
  version: "0.25.0",
  uptimeMs: 3_600_000,
  database: "sqlite",
  migrationIssues: 0,
  activeTokens: 2,
  sessions: 1,
};

const TASKS = {
  intervalMs: 60_000,
  started: true,
  tasks: [
    {
      name: "deploy-watcher",
      minIntervalMs: 60_000,
      runOnStart: true,
      enabled: true,
    },
  ],
};

const USER_REF = {
  kind: "user" as const,
  officialId: "u1",
  label: "10001",
  externalId: "10001",
};

const TOKENS = {
  total: 2,
  items: [
    {
      userId: "u1",
      user: USER_REF,
      count: 2,
      createdAt: "2026-10-03T00:00:00.000Z",
      expiresAt: "2026-10-03T00:15:00.000Z",
    },
  ],
  machine: [{ scopes: ["read:audit"], expiresAt: "2027-01-01T00:00:00.000Z" }],
};

/** 模块健康：`config` 的状态可控（重试成功前后不一样）。 */
function healthView(moduleState: "ready" | "degraded"): unknown {
  return {
    process: {
      runningVersion: "0.25.0",
      diskVersion: "0.25.0",
      uptimeMs: 3_600_000,
      startedAt: "2026-10-03T00:00:00.000Z",
      pid: 1234,
      node: "v24.0.0",
      platform: "linux",
      arch: "x64",
      rss: 1_048_576,
      heapUsed: 524_288,
      heapTotal: 1_048_576,
      mode: "fake",
    },
    database: { driver: "sqlite", migrationIssues: [] },
    queue: { pending: 0, failures: 0 },
    notify: { subscribers: 0, deliveries: 0 },
    modules: [
      {
        key: "config",
        label: "群规则",
        state: moduleState,
        ...(moduleState === "degraded" ? { error: "bad row" } : {}),
      },
      { key: "activity", label: "活动", state: "ready" },
    ],
    restart: { brokenBuild: false },
  };
}

/**
 * 状态页会打 4 个 GET（status / tasks / health / tokens）+ 两个可能的 POST
 * （模块重试 / 令牌吊销）—— 按 path 与 method 分发，避免互相串台。
 */
function stubStatus(
  options: { moduleState?: { value: "ready" | "degraded" }; tokens?: unknown } = {},
): ReturnType<typeof stubFetch> {
  const moduleState = options.moduleState ?? { value: "degraded" as const };
  return stubFetch((call) => {
    if (call.path === "/api/status") {
      return { body: STATUS };
    }
    if (call.path === "/api/tasks") {
      return { body: TASKS };
    }
    if (call.path === "/api/tokens") {
      return { body: options.tokens ?? TOKENS };
    }
    if (call.path === "/api/tokens/revoke") {
      return {
        body: {
          ok: true,
          result: {
            userId: "u1",
            user: USER_REF,
            revoked: 2,
            message: "已作废 2 张未用的登录令牌（已建立的会话不受影响）。",
          },
        },
      };
    }
    if (call.method === "POST") {
      moduleState.value = "ready";
      return {
        body: {
          ok: true,
          result: {
            module: { key: "config", label: "群规则", state: "ready" },
            recovered: true,
            message: "「群规则」已重新加载成功，功能立即恢复，不用重启进程。",
          },
        },
      };
    }
    return { body: healthView(moduleState.value) };
  });
}

describe("StatusView", () => {
  it("降级模块可点「重试加载」：带着 CSRF 发 POST，成功后刷新健康与任务", async () => {
    signIn(240);
    const fetch = stubStatus();

    const wrapper = mount(StatusView);
    await flushPromises();

    expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/status",
      "GET /api/tasks",
      "GET /api/health",
      "GET /api/tokens",
    ]);
    const rows = wrapper.get("#health-modules").findAll("tbody tr");
    expect(rows[0]?.text()).toContain("bad row");
    const retryButton = rows[0]!.find("button");
    expect(retryButton.text()).toContain("重试加载");
    // 正常的模块禁用按钮（只有降级的那一个能点）
    expect(rows[1]!.find("button").attributes("disabled")).toBeDefined();

    await retryButton.trigger("click");
    await flushPromises();

    expect(fetch.calls[4]).toMatchObject({
      method: "POST",
      path: "/api/health/modules/config/retry",
      csrf: true,
    });
    // 重试后自动刷新健康表与周期任务表
    expect(fetch.calls.slice(5).map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/health",
      "GET /api/tasks",
    ]);
    expect(wrapper.text()).toContain("已重新加载成功");
    expect(wrapper.get("#health-modules").findAll("tbody tr")[0]?.text()).toContain("正常");
    fetch.restore();
  });

  it("重试后仍然起不来：如实显示服务端原话，不当成页面错误", async () => {
    signIn(240);
    // 模块重试的应答是「仍然失败」：HTTP 200 + ok:false + 原话原因
    const failing = stubFetch((call) => {
      if (call.path === "/api/status") return { body: STATUS };
      if (call.path === "/api/tasks") return { body: TASKS };
      if (call.path === "/api/tokens") return { body: TOKENS };
      if (call.path === "/api/health/modules/config/retry") {
        return {
          body: {
            ok: false,
            result: {
              module: {
                key: "config",
                label: "群规则",
                state: "degraded",
                error: "bad row",
              },
              recovered: false,
              message: "「群规则」仍然起不来：bad row。修好数据 / 环境后可再试一次。",
            },
          },
        };
      }
      return { body: healthView("degraded") };
    });

    const wrapper = mount(StatusView);
    await flushPromises();

    await wrapper
      .get("#health-modules")
      .findAll("tbody tr")[0]!
      .find("button")
      .trigger("click");
    await flushPromises();

    const notice = wrapper.get("#module-retry-notice");
    expect(notice.text()).toContain("仍然起不来");
    expect(notice.text()).toContain("bad row");
    failing.restore();
  });

  it("登录令牌：正文出 QQ号（长 id 收进详情）、机器令牌只报 scope；吊销走二次确认", async () => {
    signIn(240);
    const fetch = stubStatus();

    const wrapper = mount(StatusView);
    await flushPromises();

    const table = wrapper.get("#admin-tokens");
    expect(table.text()).toContain("2 张");
    expect(table.findAll(".entity-label").map((node) => node.text())).toEqual([
      "10001",
    ]);
    expect(table.findAll(".entity-details").map((node) => node.text())[0]).toContain(
      "u1",
    );
    // 机器令牌：只出 scope 与到期，不出密钥
    const machine = wrapper.get("#admin-machine-tokens");
    expect(machine.text()).toContain("read:audit");
    expect(machine.text()).toContain("2027");

    // 吊销必须先弹确认（不可逆动作），确认后才发 POST
    await table.find("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("确认吊销");
    expect(fetch.calls.some((call) => call.path === "/api/tokens/revoke")).toBe(false);

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "确认吊销")!
      .trigger("click");
    await flushPromises();

    const revoke = fetch.calls.find((call) => call.path === "/api/tokens/revoke");
    expect(revoke).toMatchObject({ method: "POST", csrf: true, body: { user: "u1" } });
    expect(wrapper.text()).toContain("已作废 2 张");
    // 吊销后刷新令牌表
    expect(
      fetch.calls.filter((call) => call.path === "/api/tokens").length,
    ).toBeGreaterThan(1);
    fetch.restore();
  });

  it("非超管：连请求都不发，只说明需要 240", async () => {
    signIn(0);
    const fetch = stubFetch(() => ({ body: STATUS }));

    const wrapper = mount(StatusView);
    await flushPromises();

    expect(fetch.calls).toHaveLength(0);
    expect(wrapper.get(".hint").text()).toContain("240");
    fetch.restore();
  });
});
