<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiDeliveryItem } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 通知投递记录（只读）。
 *
 * 用途就一句话：排查「我说了要通知，怎么没收到」——
 * 所以先把状态汇总摆在最上面（失败多少一眼可见），再按状态过滤看具体哪几条降级了。
 *
 * 门槛与处罚 / 申诉一致：超管 240 不选群看全量，其余人必须选本群审核员（120）的群。
 */
const session = useSessionStore();

const items = ref<AdminApiDeliveryItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(30);
const counts = ref<Array<{ status: string; count: number }>>([]);
const groupFilter = ref("");
const statusFilter = ref("");
const loading = ref(false);
const error = ref("");

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);

/**
 * 状态选项**只用后端 `counts` 里出现过的值**动态生成：
 * 投递状态是字符串（投递层定的），前端硬编码一份清单迟早和后端漂移。
 */
const statusOptions = computed(() =>
  counts.value.map((entry) => entry.status),
);

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（过滤器要发给后端）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

async function load(): Promise<void> {
  // 非超管不选群会被服务端 400：先默认挑一个自己够 120 的群（跟审计页同一套）。
  if (!session.isSuperAdmin && groupFilter.value === "") {
    const first = groupOptions.value.find(
      (groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL,
    );
    if (first === undefined) {
      error.value = "你在任何群里都没有审核员（120）权限，看不到投递记录。";
      items.value = [];
      total.value = 0;
      counts.value = [];
      return;
    }
    groupFilter.value = first;
  }
  loading.value = true;
  try {
    const result = await adminApi.deliveries({
      page: page.value,
      pageSize: pageSize.value,
      group: groupFilter.value || undefined,
      status: statusFilter.value || undefined,
    });
    items.value = result.items;
    total.value = result.total;
    counts.value = result.counts;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 筛选项变了要回第一页：否则会停在一个新结果里根本不存在的页码上（显示成空表）。 */
async function search(): Promise<void> {
  page.value = 1;
  await load();
}

async function goto(next: number): Promise<void> {
  page.value = Math.min(Math.max(1, next), totalPages.value);
  await load();
}

/**
 * 时间列：`createdAt` 可能是 ISO 字符串，也可能是毫秒数，
 * 两种都按**本地时间**显示成 `YYYY-MM-DD HH:MM:SS`；解析不出来时原样显示（不出 `Invalid Date`）。
 */
function formatTime(value: string | number): string {
  const iso =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return String(value);
  }
  const pad = (part: number): string => String(part).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
</script>

<template>
  <section class="card">
    <h1>投递</h1>

    <p class="hint">
      用途：排查「我说了要通知，怎么没收到」——先看下面的状态汇总（失败多少），
      再按状态筛出降级 / 失败的那几条看说明。投递由机器人进程负责，后台只读。
    </p>

    <div class="toolbar">
      <label for="delivery-group">群</label>
      <select id="delivery-group" v-model="groupFilter" @change="search">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <!-- 文本是展示名，value 仍是内部 groupId：过滤器要用它发给后端 -->
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="delivery-status">状态</label>
      <select id="delivery-status" v-model="statusFilter" @change="search">
        <option value="">（全部）</option>
        <!-- 选项来自后端 counts：没出现过的状态不给，免得筛出空表 -->
        <option v-for="status in statusOptions" :key="status" :value="status">
          {{ status }}
        </option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <!-- 汇总：一眼看出失败 / 降级多少，不用逐行数 -->
    <ul v-if="counts.length > 0" class="chips">
      <li v-for="entry in counts" :key="entry.status">
        <span class="badge">{{ entry.status }} {{ entry.count }}</span>
      </li>
    </ul>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!loading && items.length === 0 && !error" class="hint">
      没有符合条件的投递记录。
    </p>

    <table v-if="items.length > 0" class="table">
      <thead>
        <tr>
          <th>时间</th>
          <th>群</th>
          <th>收件人</th>
          <th>状态</th>
          <th>说明</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <!-- 一次通知可能给多个收件人各一条（`requestId` 会重复），所以 key 用「请求 id + 行号」 -->
        <tr
          v-for="(item, index) in items"
          :key="`${item.requestId}:${index}`"
        >
          <td class="nowrap">{{ formatTime(item.createdAt) }}</td>
          <td>
            <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
            <EntityLabel
              :entity="item.group"
              :fallback="item.groupId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              :entity="item.recipient"
              :fallback="item.userId"
              :details="false"
            />
          </td>
          <td class="nowrap"><code>{{ item.status }}</code></td>
          <!-- 说明列：空值给「—」；降级 / 失败的原因（text_fallback / 错误信息）就在这里 -->
          <td class="reason">{{ item.detail || "—" }}</td>
          <!-- 详情：请求 id 与完整 openid 只在这里出现 -->
          <td>
            <details>
              <summary>详情</summary>
              <dl class="detail-list">
                <dt>请求 ID</dt>
                <dd class="mono">{{ item.requestId }}</dd>
                <dt>收件人</dt>
                <dd class="mono">{{ item.userId }}</dd>
                <dt>群 ID</dt>
                <dd class="mono">{{ item.groupId }}</dd>
              </dl>
            </details>
          </td>
        </tr>
      </tbody>
    </table>

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

<style scoped>
/* 详情折叠区的排版：标签靠左、长 id 允许折行（否则 32 位十六进制会撑破列宽） */
.detail-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 10px;
  margin: 4px 0 0;
  max-width: 42ch;
}

.detail-list dt {
  color: var(--muted);
  white-space: nowrap;
}

.detail-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
