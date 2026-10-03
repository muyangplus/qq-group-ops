import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch } from "@/test/fetch";
import AuditView from "@/views/AuditView.vue";

/**
 * 审计页（收尾批次 B）：筛选（时间范围 / 操作对象 / 只看被拒）原样进请求、回到第 1 页；
 * 展示口径仍是「正文出展示名、长 id 收进详情」；导出链接如实说明它的筛选面。
 */
function signIn(
  platformLevel: number,
  groups: Array<{ groupId: string; level: number }> = [],
): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: platformLevel >= 240 ? "boss" : "mod",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: {
      platformLevel,
      groups: groups.map((group) => ({
        ...group,
        group: {
          kind: "group" as const,
          officialId: group.groupId,
          label: group.groupId,
        },
      })),
    },
  };
}

const RECORD = {
  recordId: "r1",
  groupId: "g1",
  actorId: "openid-op",
  action: "approve_join_request",
  status: "rejected",
  reason: "资料不完整",
  createdAt: "2026-10-03T00:00:00.000Z",
  group: { kind: "group" as const, officialId: "g1", label: "50001" },
  actor: {
    kind: "user" as const,
    officialId: "openid-op",
    label: "10001",
    externalId: "10001",
  },
  targetUserId: "openid-target",
  target: {
    kind: "user" as const,
    officialId: "openid-target",
    label: "10002",
    externalId: "10002",
  },
};

const PAGE = { total: 1, page: 1, pageSize: 30, items: [RECORD] };

describe("AuditView", () => {
  it("筛选原样进请求：时间范围 / 操作对象 / 只看被拒（且回到第 1 页）", async () => {
    signIn(240);
    const fetch = stubFetch(() => ({ body: PAGE }));

    const wrapper = mount(AuditView);
    await flushPromises();
    expect(fetch.call(0)?.path).toBe("/api/audit?page=1&pageSize=30");

    // 操作对象（QQ号 / #短码 / 完整 id 都行，服务端按展示信息匹配）
    await wrapper.get("#audit-target").setValue("10002");
    await wrapper.get("#audit-from").setValue("2026-10-02");
    await wrapper.get("#audit-to").setValue("2026-10-03");
    await wrapper.get("#audit-rejected").setValue(true);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "查询")!
      .trigger("click");
    await flushPromises();

    const path = fetch.calls.at(-1)?.path ?? "";
    expect(path).toContain("/api/audit?");
    expect(path).toContain("target=10002");
    expect(path).toContain("from=2026-10-02");
    expect(path).toContain("to=2026-10-03");
    expect(path).toContain("status=rejected");
    expect(path).toContain("page=1");
    fetch.restore();
  });

  it("正文只出展示名（QQ号 / 群号），长 id 收在「详情」；导出链接如实说明筛选面", async () => {
    signIn(240);
    const fetch = stubFetch(() => ({ body: PAGE }));

    const wrapper = mount(AuditView);
    await flushPromises();

    expect(wrapper.text()).toContain("共 1 条");
    const labels = wrapper
      .findAll("tbody .entity-label")
      .map((node) => node.text());
    expect(labels).toEqual(["50001", "10001", "10002"]);
    // 完整长码在「详情」里（同一行折叠区），不在正文单元格
    expect(wrapper.find("tbody .audit-details").text()).toContain("openid-op");

    const titles = wrapper
      .findAll("a.link")
      .map((link) => link.attributes("title") ?? "");
    expect(titles[0]).toContain("不含上面的时间 / 对象 / 状态筛选");
    // 导出仍是「同源下载链接」，且只带群 / 脱敏参数
    const hrefs = wrapper.findAll("a.link").map((link) => link.attributes("href"));
    expect(hrefs[0]).toBe("/api/audit/export.csv");
    expect(hrefs[1]).toBe("/api/audit/export.csv?full=1");
    fetch.restore();
  });

  it("非超管且一个够权限的群都没有：不发请求，直接说明看不了", async () => {
    signIn(0, []);
    const fetch = stubFetch(() => ({ body: PAGE }));

    const wrapper = mount(AuditView);
    await flushPromises();

    expect(fetch.calls).toHaveLength(0);
    expect(wrapper.get(".error").text()).toContain("120");
    fetch.restore();
  });
});
