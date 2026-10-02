import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch } from "@/test/fetch";
import ReportsView from "@/views/ReportsView.vue";

/**
 * 报表页（E5）：四块汇总 + 按群表 + 两档 CSV 导出。
 *
 * 口径（ADR-0059）：只用已有记录做聚合；平台超管 240 看全量，其余人必须选自己 ≥130 的群。
 */
const GROUP_REF = { kind: "group" as const, officialId: "g1", label: "50001" };

function signIn(options: { platformLevel: number; groups: Array<{ groupId: string; level: number }> }): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: "boss",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: {
      platformLevel: options.platformLevel,
      groups: options.groups.map((group) => ({ ...group, group: GROUP_REF })),
    },
  };
}

const REPORT = {
  range: {
    days: 7,
    from: "2026-09-26T00:00:00.000Z",
    to: "2026-10-02T12:00:00.000Z",
  },
  groups: [
    {
      groupId: "g1",
      group: GROUP_REF,
      events: 5,
      approvals: 2,
      rejections: 1,
      punishments: 1,
      registrations: 1,
      deliveries: 1,
    },
  ],
  daily: [
    {
      date: "2026-10-01",
      events: 2,
      approvals: 1,
      rejections: 0,
      expired: 0,
      punishments: 1,
      registrations: 0,
      deliveries: 0,
    },
    {
      date: "2026-10-02",
      events: 3,
      approvals: 1,
      rejections: 1,
      expired: 0,
      punishments: 0,
      registrations: 1,
      deliveries: 1,
    },
  ],
  totals: {
    events: 5,
    approvals: 2,
    rejections: 1,
    expired: 0,
    punishments: 1,
    registrations: 1,
    waitlist: 0,
    deliveries: 1,
    deliveryFailed: 1,
    newActivities: 1,
    openActivities: 1,
  },
  activities: [
    {
      code: "#AAA111",
      title: "春游",
      status: "open",
      registered: 2,
      registeredInRange: 1,
      waitlist: 0,
      capacity: 2,
      full: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ],
};

describe("ReportsView", () => {
  it("平台超管：默认看全量，四块都渲染，另给「导出完整 CSV」", async () => {
    signIn({ platformLevel: 240, groups: [] });
    const fetch = stubFetch(() => ({ body: REPORT }));

    const wrapper = mount(ReportsView);
    await flushPromises();

    expect(fetch.calls[0]?.path).toBe("/api/reports?days=7");
    expect(wrapper.text()).toContain("事件合计");
    expect(wrapper.text()).toContain("2026-10-02".slice(5));
    expect(wrapper.text()).toContain("50001");
    expect(wrapper.text()).toContain("春游");
    expect(wrapper.text()).toContain("已满");
    // 两份导出链接：脱敏 + 含内部群 ID
    const links = wrapper.findAll("a.button").map((link) => link.attributes("href"));
    expect(links).toContain("/api/reports/export.csv?days=7");
    expect(links).toContain("/api/reports/export.csv?days=7&full=1");
    fetch.restore();
  });

  it("群管理员 130：默认锁死自己的群，请求带 group，且不给完整导出", async () => {
    signIn({ platformLevel: 0, groups: [{ groupId: "g1", level: 130 }] });
    const fetch = stubFetch(() => ({ body: { ...REPORT, group: GROUP_REF } }));

    const wrapper = mount(ReportsView);
    await flushPromises();

    expect(fetch.calls[0]?.path).toBe("/api/reports?group=g1&days=7");
    const links = wrapper.findAll("a.button").map((link) => link.attributes("href"));
    expect(links).toEqual(["/api/reports/export.csv?group=g1&days=7"]);
    // 非超管没有「全部群」选项
    expect(wrapper.get("#report-group").findAll("option")).toHaveLength(1);
    fetch.restore();
  });

  it("只有 120：不发请求，直接说明看不了（避免白跑一次 403）", async () => {
    signIn({ platformLevel: 0, groups: [{ groupId: "g1", level: 120 }] });
    const fetch = stubFetch(() => ({ body: REPORT }));

    const wrapper = mount(ReportsView);
    await flushPromises();

    expect(fetch.calls).toHaveLength(0);
    expect(wrapper.get(".error").text()).toContain("130");
    fetch.restore();
  });

  it("服务端报错：原样显示中文原因", async () => {
    signIn({ platformLevel: 240, groups: [] });
    const fetch = stubFetch(() => ({
      status: 503,
      body: { error: "unavailable", message: "统计报表数据源未装配。" },
    }));

    const wrapper = mount(ReportsView);
    await flushPromises();

    expect(wrapper.get(".error").text()).toContain("统计报表数据源未装配");
    fetch.restore();
  });
});
