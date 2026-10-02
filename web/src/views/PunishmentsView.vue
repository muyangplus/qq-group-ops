<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiPunishmentItem } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 处罚记录（只读）。
 *
 * 口径与 `/punish list` 一致：平台超管 240 可以不选群看全量，
 * 其余人**必须选一个自己够审核员（120）的群**，否则服务端直接 400 / 403。
 * 所以这里跟审计页用同一套「默认选中第一个够 120 的群」的写法，省得用户先撞一次错。
 *
 * 展示口径：正文只出「群号 / QQ号 → 短码」，完整官方长码与执行结果收进每行末尾的「详情」。
 */
const session = useSessionStore();

const items = ref<AdminApiPunishmentItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(30);
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

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（过滤器要发给后端）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

/** 正文字段缺省时的兜底：空串给「—」，别让单元格看起来像坏了。 */
function orDash(value: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "—";
}

/**
 * 详情折叠区里的一行：标签 + 值。
 *
 * `mono` 给短码 / 内部 id 这类要等宽显示的值用（长 id 才看得清）。
 */
interface PunishmentDetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * 一行处罚的全部细节。
 *
 * 触发原文（`messageExcerpt`）只在这里出现：正文列放不下，而且它可能是整段聊天内容；
 * 后端没保留时是空串，明确写「未保留原文」而不是留白（免得看着像前端丢了数据）。
 */
function detailRows(record: AdminApiPunishmentItem): PunishmentDetailRow[] {
  const rows: PunishmentDetailRow[] = [
    { label: "处罚短码", value: record.code, mono: true },
    { label: "执行结果", value: orDash(record.detail) },
    { label: "记录 ID", value: record.recordId, mono: true },
    { label: "来源", value: orDash(record.source) },
  ];
  rows.push({
    label: "触发原文",
    value:
      record.messageExcerpt.length > 0 ? record.messageExcerpt : "未保留原文",
  });
  return rows;
}

async function load(): Promise<void> {
  // 非超管不选群会被服务端 400：先默认挑一个自己够 120 的群（跟审计页同一套）。
  if (!session.isSuperAdmin && groupFilter.value === "") {
    const first = groupOptions.value.find(
      (groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL,
    );
    if (first === undefined) {
      error.value = "你在任何群里都没有审核员（120）权限，看不到处罚记录。";
      items.value = [];
      total.value = 0;
      return;
    }
    groupFilter.value = first;
  }
  loading.value = true;
  try {
    const result = await adminApi.punishments({
      page: page.value,
      pageSize: pageSize.value,
      group: groupFilter.value || undefined,
      status: statusFilter.value || undefined,
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
    <h1>处罚</h1>

    <div class="toolbar">
      <label for="punish-group">群</label>
      <select id="punish-group" v-model="groupFilter" @change="search">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <!-- 文本是展示名，value 仍是内部 groupId：过滤器要用它发给后端 -->
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="punish-status">状态</label>
      <select id="punish-status" v-model="statusFilter" @change="search">
        <option value="">（全部）</option>
        <option value="active">生效中</option>
        <option value="released">已解除</option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <p class="hint">
      处罚是<b>群维度</b>的：解除后仍留记录（状态变「已解除」），所以列表按时间倒序当台账看。
    </p>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!loading && items.length === 0 && !error" class="hint">
      没有符合条件的处罚记录。
    </p>

    <table v-if="items.length > 0" class="table">
      <thead>
        <tr>
          <th>时间</th>
          <th>群</th>
          <th>被处罚人</th>
          <th>执行者</th>
          <th>动作</th>
          <th>原因</th>
          <th>状态</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in items" :key="record.recordId">
          <td class="nowrap">{{ formatTime(record.createdAt) }}</td>
          <td>
            <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
            <EntityLabel
              :entity="record.group"
              :fallback="record.groupId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              :entity="record.target"
              :fallback="record.userId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              :entity="record.actor"
              :fallback="record.actorId"
              :details="false"
            />
          </td>
          <td class="reason">{{ orDash(record.actions) }}</td>
          <!-- 原因列只出规则侧的说法；触发原文收进详情，避免正文被聊天记录撑爆 -->
          <td class="reason">{{ orDash(record.ruleReason) }}</td>
          <td>
            <span v-if="record.status === 'active'" class="badge">生效中</span>
            <span v-else class="badge">已解除</span>
          </td>
          <!-- 详情：完整官方 id / 原文 / 执行结果只在这里出现 -->
          <td>
            <details>
              <summary>详情</summary>
              <dl class="detail-list">
                <template v-for="row in detailRows(record)" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
                </template>
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
/* 详情折叠区的排版：标签靠左、长 id / 原文允许折行（否则 32 位十六进制会撑破列宽） */
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
