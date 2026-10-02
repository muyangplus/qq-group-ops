import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";

import { useSessionStore } from "@/stores/session";
import { stubFetch } from "@/test/fetch";
import IdentitiesView from "@/views/IdentitiesView.vue";

/**
 * 身份映射只读页（P3）：只展示「群号 ↔ 群 ID、QQ号 ↔ openid」，
 * 写（`/bind user`、`/bind groupid`）刻意不搬；门槛平台超管 240。
 */
function signIn(platformLevel: number): void {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: platformLevel >= 240 ? "boss" : "gsuper",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { platformLevel, groups: [] },
  };
}

const IDENTITIES = {
  users: [
    {
      officialId: "u-openid-1",
      entity: { kind: "user", officialId: "u-openid-1", label: "10001" },
      externalId: "10001",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      officialId: "u-openid-2",
      entity: { kind: "user", officialId: "u-openid-2", label: "10002" },
      externalId: "10002",
    },
  ],
  groups: [
    {
      officialId: "group-openid-1",
      entity: { kind: "group", officialId: "group-openid-1", label: "50001" },
      externalId: "50001",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
};

describe("IdentitiesView", () => {
  it("平台超管：两张表都列出来，缺时间戳的那行显示「—」", async () => {
    signIn(240);
    const fetch = stubFetch(() => ({ body: IDENTITIES }));

    const wrapper = mount(IdentitiesView);
    await flushPromises();

    expect(fetch.calls[0]?.path).toBe("/api/identities");
    expect(wrapper.text()).toContain("10001");
    expect(wrapper.text()).toContain("u-openid-1");
    expect(wrapper.text()).toContain("50001");
    expect(wrapper.text()).toContain("group-openid-1");
    // 老库 / 内存实现没有时间戳：显示「—」而不是空白
    expect(wrapper.text()).toContain("—");
    // 写操作不搬：页面明确写出来
    expect(wrapper.text()).toContain("代绑");
    fetch.restore();
  });

  it("过滤框按群号 / QQ号 / openid 过滤（纯前端，不再发请求）", async () => {
    signIn(240);
    const fetch = stubFetch(() => ({ body: IDENTITIES }));

    const wrapper = mount(IdentitiesView);
    await flushPromises();

    await wrapper.get("#identity-filter").setValue("10002");
    expect(wrapper.text()).toContain("u-openid-2");
    expect(wrapper.text()).not.toContain("u-openid-1");
    // 过滤是纯前端：只发过那一次 GET
    expect(fetch.calls).toHaveLength(1);
    fetch.restore();
  });

  it("非平台超管：不发请求，直接说明需要 240", async () => {
    signIn(140);
    const fetch = stubFetch(() => ({ body: IDENTITIES }));

    const wrapper = mount(IdentitiesView);
    await flushPromises();

    expect(fetch.calls).toHaveLength(0);
    expect(wrapper.text()).toContain("需要平台超管（240）");
    fetch.restore();
  });
});
