<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiStatus } from "@/api/admin";
import { ApiError } from "@/api/client";
import { useSessionStore } from "@/stores/session";

/**
 * 状态看板（E2-c）：`GET /api/status`。
 *
 * 平台级信息，服务端要**平台超管 240**（见 docs/ADMIN-API.md 的 E1-g），
 * 所以非超管这里只显示一句说明、连请求都不发。
 */
const session = useSessionStore();
const status = ref<AdminApiStatus | null>(null);
const loading = ref(false);
const error = ref("");

const allowed = computed(() => session.isSuperAdmin);

async function load(): Promise<void> {
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    status.value = await adminApi.status();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    days > 0 ? `${days} 天` : "",
    hours > 0 ? `${hours} 小时` : "",
    `${minutes} 分钟`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}
</script>

<template>
  <section class="card">
    <h1>状态</h1>

    <p v-if="!allowed" class="hint">
      需要平台超级管理员（240）才能查看运行状态。
    </p>
    <template v-else>
      <p v-if="loading" class="hint">加载中…</p>
      <p v-if="error" class="error">{{ error }}</p>
      <dl v-if="status" class="facts">
        <dt>版本</dt>
        <dd><code>{{ status.version }}</code></dd>
        <dt>运行时长</dt>
        <dd>{{ formatUptime(status.uptimeMs) }}</dd>
        <dt>数据库</dt>
        <dd><code>{{ status.database }}</code></dd>
        <dt>迁移问题</dt>
        <dd>
          <span v-if="status.migrationIssues === 0">无</span>
          <span v-else class="error">
            {{ status.migrationIssues }} 条（详情在机器人的 `/status proc`）
          </span>
        </dd>
        <dt>未用登录令牌</dt>
        <dd>{{ status.activeTokens }} 张</dd>
        <dt>管理后台会话</dt>
        <dd>{{ status.sessions }} 个（重启机器人即全部失效）</dd>
      </dl>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
    </template>
  </section>
</template>
