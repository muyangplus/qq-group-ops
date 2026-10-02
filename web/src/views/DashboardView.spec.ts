import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import { createRouter, createWebHistory } from "vue-router";

import { useSessionStore } from "@/stores/session";
import DashboardView from "@/views/DashboardView.vue";

/**
 * 概览页（E2-c / E2-f）：登录账号与「能审批的群」都走展示口径 ——
 * 正文出 QQ号 / 群号，完整 openid / group_openid 收进「详情」。
 */
const USER_REF = {
  kind: "user" as const,
  officialId: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
  label: "10001",
  externalId: "10001",
};
const GROUP_REF = {
  kind: "group" as const,
  officialId: "Z9Y8X7W6V5U4T3S2R1Q0P9O8N7M6L5K4",
  label: "50001",
  externalId: "50001",
};

function mountView(): ReturnType<typeof mount> {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: USER_REF.officialId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: USER_REF,
    permissions: {
      platformLevel: 0,
      groups: [{ groupId: GROUP_REF.officialId, level: 130, group: GROUP_REF }],
    },
  };
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", name: "dashboard", component: { template: "<div />" } },
      { path: "/pending", name: "pending", component: { template: "<div />" } },
      { path: "/audit", name: "audit", component: { template: "<div />" } },
      { path: "/rules", name: "rules", component: { template: "<div />" } },
      { path: "/activities", name: "activities", component: { template: "<div />" } },
      { path: "/status", name: "status", component: { template: "<div />" } },
    ],
  });
  return mount(DashboardView, { global: { plugins: [router] } });
}

describe("DashboardView 展示口径", () => {
  it("登录账号显示 QQ号，长 openid 只在「详情」里", () => {
    const wrapper = mountView();

    const account = wrapper
      .findAll("dd")
      .find((cell) => cell.text().includes("10001"));
    expect(account, "找不到登录账号那一行").toBeDefined();
    expect(account!.text()).toContain("详情");
    expect(account!.find(".entity-details").text()).toContain(USER_REF.officialId);
    expect(account!.find(".entity-label").text()).toBe("10001");
  });

  it("「能审批的群」显示群号，长 group_openid 只在「详情」里", () => {
    const wrapper = mountView();

    const groups = wrapper.get(".groups");
    expect(groups.text()).toContain("50001");
    expect(groups.get(".entity-label").text()).toBe("50001");
    expect(groups.get(".entity-details").text()).toContain(GROUP_REF.officialId);
  });
});
