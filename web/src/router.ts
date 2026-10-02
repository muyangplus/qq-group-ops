import { createRouter, createWebHistory } from "vue-router";

import { onUnauthorized } from "@/api/client";
import { useSessionStore } from "@/stores/session";
import DashboardView from "@/views/DashboardView.vue";
import LoginView from "@/views/LoginView.vue";
import PendingView from "@/views/PendingView.vue";
import StatusView from "@/views/StatusView.vue";

/**
 * 路由表与登录守卫（E2-a 建脚手架，E2-b 补会话保持，E2-c 逐页落地）。
 *
 * 守卫只做**体验**：进来先问一次 `/auth/me`，没会话就带去登录页并记下原地址；
 * 能不能干活一律由服务端判（只读有逐路由门槛，写端点按本群 130 / 平台 240）。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: DashboardView },
    { path: "/pending", name: "pending", component: PendingView },
    { path: "/status", name: "status", component: StatusView },
    { path: "/login", name: "login", component: LoginView },
    { path: "/:pathMatch(.*)*", name: "not-found", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  if (!session.loaded) {
    await session.load();
  }
  if (session.signedIn || to.name === "login") {
    return true;
  }
  // 没会话：带着原地址去登录页，登录成功后回跳（链接里的 ?token= 也一起带过去）
  return {
    name: "login",
    query: { ...to.query, redirect: to.fullPath },
  };
});

/**
 * 会话在页面停留期间失效（cookie 过期 / 机器人重启）时，任何一个 API 调用都会回 401：
 * 这里把用户送回登录页，并标记 `expired` 让登录页说清「是过期，不是令牌错」。
 */
onUnauthorized(() => {
  const current = router.currentRoute.value;
  if (current.name === "login") {
    return;
  }
  void router.replace({
    name: "login",
    query: { redirect: current.fullPath, expired: "1" },
  });
});
