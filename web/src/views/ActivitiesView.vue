<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiActivityAction,
  type AdminApiActivityItem,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { GROUP_ADMIN_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 活动列表与开关（E2-c）。
 *
 * 口径（docs/ADMIN-API.md）：列表按「本群审核员 120 起」裁剪；
 * `open / close / cancel` 要本群**群管理员 130**；名单 CSV 走
 * `GET /api/activities/:code/export.csv`（默认脱敏，`?full=1` 带隐私列，两种都写审计）。
 */
const session = useSessionStore();

const items = ref<AdminApiActivityItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const groupFilter = ref("");
const statusFilter = ref("");
const loading = ref(false);
const error = ref("");
const notice = ref("");
const busyCode = ref("");

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（过滤器要发给后端）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  open: "报名中",
  closed: "已结束",
  cancelled: "已取消",
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await adminApi.activities({
      page: page.value,
      pageSize: pageSize.value,
      group: groupFilter.value,
      status: statusFilter.value,
    });
    items.value = result.items;
    total.value = result.total;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function canManage(groupId: string): boolean {
  return session.levelIn(groupId) >= GROUP_ADMIN_LEVEL;
}

async function setStatus(
  item: AdminApiActivityItem,
  action: AdminApiActivityAction,
): Promise<void> {
  busyCode.value = item.code;
  try {
    const result = await adminApi.setActivityStatus(item.code, action);
    notice.value = `${result.message}（${item.title}）`;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busyCode.value = "";
  }
}

async function goto(next: number): Promise<void> {
  page.value = Math.min(Math.max(1, next), totalPages.value);
  await load();
}

/** 名单导出是**下载**：同源链接直接带会话 cookie，`?full=1` 才含学号 / 班级 / 学院。 */
function exportUrl(code: string, full: boolean): string {
  return `/api/activities/${encodeURIComponent(code)}/export.csv${full ? "?full=1" : ""}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <section class="card">
    <h1>活动</h1>

    <div class="toolbar">
      <label for="activity-group">群</label>
      <select id="activity-group" v-model="groupFilter" @change="goto(1)">
        <option value="">（我够权限的全部群）</option>
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="activity-status">状态</label>
      <select id="activity-status" v-model="statusFilter" @change="goto(1)">
        <option value="">（全部）</option>
        <option value="draft">草稿</option>
        <option value="open">报名中</option>
        <option value="closed">已结束</option>
        <option value="cancelled">已取消</option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>
    <p v-if="!loading && items.length === 0" class="hint">没有活动。</p>

    <ul class="list">
      <li v-for="item in items" :key="item.activityId">
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              <code>{{ item.code }}</code>
              <strong>{{ item.title }}</strong>
              <span class="badge">{{ STATUS_LABEL[item.status] ?? item.status }}</span>
            </div>
            <div class="hint">
              <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
              群 <EntityLabel :entity="item.group" :fallback="item.groupId" /> · 报名
              {{ item.registered }}<span v-if="item.capacity"> / {{ item.capacity }}</span>
              · 创建于 {{ formatTime(item.createdAt) }}
            </div>
          </div>
          <div class="row-actions">
            <button
              type="button"
              :disabled="!canManage(item.groupId) || busyCode === item.code || item.status === 'open'"
              :title="canManage(item.groupId) ? '开放报名' : '需要本群群管理员（130）'"
              @click="setStatus(item, 'open')"
            >
              开放
            </button>
            <button
              type="button"
              :disabled="!canManage(item.groupId) || busyCode === item.code || item.status === 'closed'"
              :title="canManage(item.groupId) ? '结束报名' : '需要本群群管理员（130）'"
              @click="setStatus(item, 'close')"
            >
              结束
            </button>
            <button
              type="button"
              class="danger"
              :disabled="!canManage(item.groupId) || busyCode === item.code || item.status === 'cancelled'"
              :title="canManage(item.groupId) ? '取消活动' : '需要本群群管理员（130）'"
              @click="setStatus(item, 'cancel')"
            >
              取消
            </button>
            <a
              class="button"
              :href="exportUrl(item.code, false)"
              :title="canManage(item.groupId) ? '导出脱敏名单（不含学号 / 班级 / 学院）' : '需要本群群管理员（130）'"
              :class="{ disabled: !canManage(item.groupId) }"
            >
              名单
            </a>
            <a
              class="button"
              :href="exportUrl(item.code, true)"
              title="导出完整名单（含学号 / 班级 / 学院，会写审计）"
              :class="{ disabled: !canManage(item.groupId) }"
            >
              完整名单
            </a>
          </div>
        </div>
      </li>
    </ul>

    <div class="pager">
      <button type="button" class="link" :disabled="page <= 1" @click="goto(page - 1)">
        上一页
      </button>
      <span class="hint">第 {{ page }} / {{ totalPages }} 页</span>
      <button
        type="button"
        class="link"
        :disabled="page >= totalPages"
        @click="goto(page + 1)"
      >
        下一页
      </button>
    </div>
  </section>
</template>
