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
const newGroup = ref("");
const newTitle = ref("");
const creating = ref(false);
/** 每行的「绑定到…」下拉当前选择；key 是活动短码。 */
const bindTargets = ref<Record<string, string>>({});

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
/** 只有本群群管理员（130）才能新建活动 / 改发布群，下拉里只列这些群。 */
const manageGroupOptions = computed(() =>
  groupOptions.value.filter((groupId) => canManage(groupId)),
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

/** 新建活动 = 只建**草稿**（不广播），服务端会自动绑定创建群。 */
async function createActivity(): Promise<void> {
  const group = newGroup.value;
  const title = newTitle.value.trim();
  if (group.length === 0 || title.length === 0) {
    error.value = "请选择归属群并填写标题。";
    return;
  }
  creating.value = true;
  try {
    const result = await adminApi.createActivity(group, title);
    notice.value = result.message;
    newTitle.value = "";
    error.value = "";
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    creating.value = false;
  }
}

/** 该行还能绑哪些群：只列自己管得动、且当前没绑过的群。 */
function bindableGroups(item: AdminApiActivityItem): string[] {
  const bound = new Set(item.boundGroups.map((group) => group.officialId));
  return manageGroupOptions.value.filter((groupId) => !bound.has(groupId));
}

async function bindGroup(item: AdminApiActivityItem): Promise<void> {
  const group = bindTargets.value[item.code] ?? "";
  if (group.length === 0) {
    error.value = "先选一个要绑定的群。";
    return;
  }
  busyCode.value = item.code;
  try {
    const result = await adminApi.bindActivityGroup(item.code, group);
    notice.value = `${result.message}（${item.title}）`;
    bindTargets.value = { ...bindTargets.value, [item.code]: "" };
    error.value = "";
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busyCode.value = "";
  }
}

async function unbindGroup(item: AdminApiActivityItem, group: string): Promise<void> {
  busyCode.value = item.code;
  try {
    const result = await adminApi.unbindActivityGroup(item.code, group);
    notice.value = `${result.message}（${item.title}）`;
    error.value = "";
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

    <!-- 新建活动：只建草稿（不广播），服务端自动绑定创建群 -->
    <div class="section-title">新建活动（草稿）</div>
    <div class="toolbar">
      <label for="activity-new-group">归属群</label>
      <select
        id="activity-new-group"
        v-model="newGroup"
        :disabled="manageGroupOptions.length === 0"
      >
        <option value="">（选择归属群）</option>
        <option v-for="groupId in manageGroupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="activity-new-title">标题</label>
      <input
        id="activity-new-title"
        v-model="newTitle"
        maxlength="60"
        placeholder="例如：周三晚自习"
      />
      <button
        type="button"
        :disabled="creating || !newGroup || newTitle.trim().length === 0"
        @click="createActivity"
      >
        新建活动
      </button>
      <span class="hint">
        新建后是「草稿」，不会往群里发卡；开放报名才会广播。需要本群群管理员（130）。
      </span>
    </div>

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
            <!-- 发布群：绑定集合为空时后端回落到归属群，至少一项 -->
            <div class="hint">发布群：</div>
            <ul class="chips">
              <li
                v-for="group in item.boundGroups"
                :key="group.officialId"
                class="chip-with-action"
              >
                <EntityLabel :entity="group" :fallback="group.officialId" />
                <button
                  v-if="canManage(item.groupId) && item.boundGroups.length > 1"
                  type="button"
                  class="chip"
                  :disabled="busyCode === item.code"
                  title="解绑这个发布群（至少要保留归属群作为发布目标）"
                  @click="unbindGroup(item, group.officialId)"
                >
                  解绑
                </button>
              </li>
            </ul>
          </div>
          <div class="row-actions">
            <template v-if="canManage(item.groupId)">
              <select
                v-model="bindTargets[item.code]"
                :disabled="busyCode === item.code || bindableGroups(item).length === 0"
                title="选择要绑定为发布 / 广播目标的群"
              >
                <option value="">绑定到…</option>
                <option v-for="groupId in bindableGroups(item)" :key="groupId" :value="groupId">
                  {{ groupLabel(groupId) }}
                </option>
              </select>
              <button
                type="button"
                :disabled="busyCode === item.code || !bindTargets[item.code]"
                title="把选中的群加为发布 / 广播目标"
                @click="bindGroup(item)"
              >
                绑定
              </button>
            </template>
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
