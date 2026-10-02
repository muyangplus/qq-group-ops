<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

/**
 * 应用外壳（E2-a）：顶部显示登录态与登出入口，正文交给路由。
 *
 * 进站先问一次 `/auth/me`：没有会话就跳登录页（E2-b 会把这段换成带深链回跳的路由守卫）。
 */
const session = useSessionStore();
const router = useRouter();

onMounted(async () => {
  if (!session.loaded) {
    await session.load();
  }
  if (!session.signedIn && router.currentRoute.value.name !== "login") {
    await router.replace({ name: "login" });
  }
});

async function signOut(): Promise<void> {
  await session.logout();
  await router.replace({ name: "login" });
}
</script>

<template>
  <header class="topbar">
    <RouterLink class="brand" :to="{ name: 'dashboard' }">
      qq-group-ops 管理后台
    </RouterLink>
    <nav class="topbar-right">
      <span v-if="session.signedIn" class="who">
        {{ session.identity?.userId }}
        <em v-if="session.isSuperAdmin">平台超管</em>
      </span>
      <button
        v-if="session.signedIn"
        type="button"
        class="link"
        @click="signOut"
      >
        登出
      </button>
    </nav>
  </header>
  <main class="page">
    <RouterView />
  </main>
</template>
