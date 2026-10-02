<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiStatus, type AdminApiTasksView } from "@/api/admin";
import { ApiError } from "@/api/client";
import { useSessionStore } from "@/stores/session";

/**
 * 状态看板（E2-c）：`GET /api/status` + 周期任务监测 `GET /api/tasks`。
 *
 * 平台级信息，服务端要**平台超管 240**（见 docs/ADMIN-API.md 的 E1-g），
 * 所以非超管这里只显示一句说明、连请求都不发。
 */
const session = useSessionStore();
const status = ref<AdminApiStatus | null>(null);
const tasks = ref<AdminApiTasksView | null>(null);
const loading = ref(false);
const error = ref("");

const allowed = computed(() => session.isSuperAdmin);

async function load(): Promise<void> {
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    // 只读巡检模式（`pnpm admin:api`）没有调度器：那个端点回 503，不该把整页打成错误
    const [next, nextTasks] = await Promise.all([
      adminApi.status(),
      adminApi.tasks().catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 503) {
          return null;
        }
        throw err;
      }),
    ]);
    status.value = next;
    tasks.value = nextTasks;
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

function formatTime(value: string | undefined): string {
  if (value === undefined) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 任务节拍：`0` = 每轮都跑（跟统一扫描周期同频），否则换算成秒/分/小时。
 * 全项目只有一个定时器，每个任务只是「到点才真的执行」。
 */
function cadence(minIntervalMs: number, scanIntervalMs: number): string {
  if (minIntervalMs <= 0) {
    return `每轮（${Math.round(scanIntervalMs / 1000)} 秒）`;
  }
  if (minIntervalMs % 3_600_000 === 0) {
    return `${minIntervalMs / 3_600_000} 小时`;
  }
  if (minIntervalMs % 60_000 === 0) {
    return `${minIntervalMs / 60_000} 分钟`;
  }
  return `${Math.round(minIntervalMs / 1000)} 秒`;
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

      <template v-if="tasks">
        <h2 class="section-title">周期任务监测</h2>
        <p class="hint">
          统一扫描周期 <b>{{ tasks.intervalMs }} ms</b>
          （<code>SCAN_INTERVAL_MS</code>，{{ tasks.started ? "调度器运行中" : "调度器已停：周期任务全部不跑" }}）。
          保留清理 / 活动提醒 / 申诉轮转 / 待审批 TTL / 部署监测都挂在这一个节拍上；
          「降级」= 依赖的模块不可用，那一轮整轮跳过（模块恢复后立刻补跑）。
        </p>
        <table class="table">
          <thead>
            <tr>
              <th>任务</th>
              <th>节拍</th>
              <th>状态</th>
              <th>上次执行</th>
              <th>下次最早</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in tasks.tasks" :key="task.name">
              <td><code>{{ task.name }}</code></td>
              <td>{{ cadence(task.minIntervalMs, tasks.intervalMs) }}</td>
              <td>
                <span v-if="!task.enabled" class="badge">降级跳过</span>
                <span v-else-if="!tasks.started" class="hint">已停</span>
                <span v-else>正常</span>
              </td>
              <td class="nowrap">{{ formatTime(task.lastRunAt) }}</td>
              <td class="nowrap">{{ formatTime(task.nextRunAt) }}</td>
            </tr>
          </tbody>
        </table>

        <template v-if="tasks.deploy">
          <h3 class="row-title">待生效的部署</h3>
          <dl class="facts">
            <dt>目标版本</dt>
            <dd><code>v{{ tasks.deploy.targetVersion }}</code>（服务器上已就绪）</dd>
            <dt>当前运行</dt>
            <dd><code>v{{ tasks.deploy.currentVersion }}</code></dd>
            <dt>检测时间</dt>
            <dd>{{ formatTime(tasks.deploy.detectedAt) }}</dd>
            <dt>计划重启</dt>
            <dd>{{ formatTime(tasks.deploy.deadlineAt) }}</dd>
          </dl>
        </template>
      </template>
      <p v-else-if="status && !loading" class="hint">
        本进程没有周期任务调度器（只读巡检模式）：周期任务监测只在机器人进程内那口有。
      </p>

      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
    </template>
  </section>
</template>
