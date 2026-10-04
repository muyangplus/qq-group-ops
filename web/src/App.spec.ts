import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import { createRouter, createWebHistory } from "vue-router";

import App from "@/App.vue";
import { useSessionStore } from "@/stores/session";

/**
 * 应用外壳（E2-a / E2-f）：顶栏的**登录账号也要走展示口径** ——
 * 正文出 QQ号 / 短码，完整 openid 收进「详情」；不再把 32 位 openid 摊在页头。
 */
const USER_REF = {
  kind: "user" as const,
  officialId: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
  label: "10001",
  externalId: "10001",
  shortCode: "#U12345",
};

/** App 的导航里有全部入口，测试路由要把这些 name 都注册上，否则 RouterLink 解析会抛错。 */
const NAV_ROUTES = [
  "dashboard",
  "pending",
  "audit",
  "appeals",
  "punishments",
  "blacklist",
  "rules",
  "activities",
  "announcements",
  "reports",
  "status",
  "notify",
  "deliveries",
  "settings",
  "aliases",
  "permissions",
  "identities",
  "login",
];

function mountApp(identity: {
  user?: typeof USER_REF;
  userId: string;
}): ReturnType<typeof mount> {
  setActivePinia(createPinia());
  const session = useSessionStore();
  session.identity = {
    userId: identity.userId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { platformLevel: 240, groups: [] },
    ...(identity.user !== undefined ? { user: identity.user } : {}),
  };
  session.loaded = true;
  const router = createRouter({
    history: createWebHistory(),
    routes: NAV_ROUTES.map((name) => ({
      path: `/${name}`,
      name,
      component: { template: "<div />" },
    })),
  });
  return mount(App, { global: { plugins: [router] } });
}

describe("App 顶栏", () => {
  it("登录账号显示 QQ号；完整 openid 在「详情」里，不直接摊在页头", () => {
    const wrapper = mountApp({ user: USER_REF, userId: USER_REF.officialId });

    expect(wrapper.get(".who .entity-label").text()).toBe("10001");
    // 长 openid 只出现在「详情」折叠区（正文是 QQ号）
    expect(wrapper.get(".who .entity-details summary").text()).toBe("详情");
    expect(wrapper.get(".who .entity-details").text()).toContain(
      USER_REF.officialId,
    );
  });

  it("老响应没有展示信息时退回 userId（不显示空白）", () => {
    const wrapper = mountApp({ userId: "u_9876543210" });
    expect(wrapper.get(".who").text()).toContain("u_9876543210");
  });
});
