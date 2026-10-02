import { createRouter, createWebHistory } from "vue-router";

import DashboardView from "@/views/DashboardView.vue";
import LoginView from "@/views/LoginView.vue";

/**
 * 路由表（E2-a）。
 *
 * 页面按计划逐项落地：E2-c 补状态看板 / 待审批 / 审计 / 规则 / 活动五个页面，
 * 现在只有登录页与一个占位看板，先把「登录 → 会话 → 路由」这条链路跑通。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: DashboardView },
    { path: "/login", name: "login", component: LoginView },
    { path: "/:pathMatch(.*)*", name: "not-found", redirect: "/" },
  ],
});
