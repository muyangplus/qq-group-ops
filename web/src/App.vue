<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";

import EntityLabel from "@/components/EntityLabel.vue";
import { useSessionStore } from "@/stores/session";

/**
 * 应用外壳（E2-a）：顶部显示登录态与登出入口，正文交给路由。
 *
 * 「没登录就跳登录页」在路由守卫里做（`router.ts`），这里只管渲染与登出。
 */
const session = useSessionStore();
const router = useRouter();

/** 会话剩余时间：E2-b 的「过期提示」，让人知道什么时候会掉线。 */
const expiresIn = computed((): string => {
  const at = session.identity?.expiresAt;
  if (!at) {
    return "";
  }
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) {
    return "会话已过期";
  }
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.round(minutes / 60)} 小时后过期` : `${minutes} 分钟后过期`;
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
    <nav v-if="session.signedIn" class="tabs">
      <RouterLink :to="{ name: 'dashboard' }">概览</RouterLink>
      <RouterLink :to="{ name: 'pending' }">待审批</RouterLink>
      <RouterLink :to="{ name: 'audit' }">审计</RouterLink>
      <!-- 申诉 / 处罚 / 黑名单是「只读面」：有群权限（120 起）的人都能看 -->
      <RouterLink :to="{ name: 'appeals' }">申诉</RouterLink>
      <RouterLink :to="{ name: 'punishments' }">处罚</RouterLink>
      <RouterLink :to="{ name: 'blacklist' }">黑名单</RouterLink>
      <RouterLink :to="{ name: 'rules' }">规则</RouterLink>
      <RouterLink :to="{ name: 'activities' }">活动</RouterLink>
      <!-- 定时发言：每群群管（130）配本群；没有够 130 的群时页面里会说明 -->
      <RouterLink :to="{ name: 'announcements' }">定时发言</RouterLink>
      <!-- 报表：超管看全量，群管理员（130）看本群；入口对所有登录者可见 -->
      <RouterLink :to="{ name: 'reports' }">报表</RouterLink>
      <!-- 状态 / 配置 / 通知 / 投递 / 别名是平台级信息：非平台超管看不到入口（服务端也会 403） -->
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'status' }">
        状态
      </RouterLink>
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'notify' }">
        通知
      </RouterLink>
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'deliveries' }">
        投递
      </RouterLink>
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'settings' }">
        配置
      </RouterLink>
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'aliases' }">
        别名
      </RouterLink>
      <!-- 权限是「权限的权限」：只有平台超管能看到入口（服务端也会 403） -->
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'permissions' }">
        权限
      </RouterLink>
      <!-- 身份映射是平台级只读（代绑的写留在机器人里） -->
      <RouterLink v-if="session.isSuperAdmin" :to="{ name: 'identities' }">
        身份
      </RouterLink>
    </nav>
    <nav class="topbar-right">
      <!-- 登录账号也不露原始 openid：正文出 QQ号 / 短码，完整 id 收进「详情」 -->
      <span v-if="session.signedIn" class="who">
        <EntityLabel
          :entity="session.identity?.user"
          :fallback="session.identity?.userId ?? '（未登录）'"
        />
        <em v-if="session.isSuperAdmin">平台超管</em>
      </span>
      <span v-if="expiresIn" class="muted-text">{{ expiresIn }}</span>
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
