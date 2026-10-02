<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiAppealItem } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 申诉队列（只读）。
 *
 * 口径与 `/appeal list` 一致：平台超管 240 可以不选群看全量，
 * 其余人必须带本群审核员（120）的群；所以默认选中第一个够 120 的群。
 *
 * 「复核（通过 / 驳回）」写操作目前仍只在机器人指令里做，这台后台只看不写。
 */
const session = useSessionStore();

const items = ref<AdminApiAppealItem[]>([]);
const holdMinutes = ref(0);
const pendingCount = ref(0);
const groupFilter = ref("");
const statusFilter = ref("");
const loading = ref(false);
const error = ref("");

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);

/** 申诉状态的中文口径：'—' 只会在后端加了新状态时出现，不做静默兜底。 */
const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  accepted: "已通过",
  rejected: "已驳回",
};

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（过滤器要发给后端）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

/** 正文字段缺省时的兜底：空串给「—」，别让单元格看起来像坏了。 */
function orDash(value: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "—";
}

async function load(): Promise<void> {
  // 非超管不选群会被服务端 400：先默认挑一个自己够 120 的群（跟审计页同一套）。
  if (!session.isSuperAdmin && groupFilter.value === "") {
    const first = groupOptions.value.find(
      (groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL,
    );
    if (first === undefined) {
      error.value = "你在任何群里都没有审核员（120）权限，看不到申诉队列。";
      items.value = [];
      pendingCount.value = 0;
      return;
    }
    groupFilter.value = first;
  }
  loading.value = true;
  try {
    const result = await adminApi.appeals({
      group: groupFilter.value || undefined,
      status: statusFilter.value || undefined,
    });
    items.value = result.items;
    holdMinutes.value = result.holdMinutes;
    pendingCount.value = result.pendingCount;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function reload(): Promise<void> {
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

/** 可选时间：没有就「—」（已处理的申诉没有 `reviewedAt` 才会走到这）。 */
function formatOptionalTime(value: string | undefined): string {
  return value === undefined ? "—" : formatTime(value);
}

/**
 * 「时限」列：已处理的走 `—`；`overdue` 是后端算的权威口径（不是前端拿分钟数瞎猜），
 * 没超时就显示还剩几分钟，让人一眼知道轮转什么时候把它转给别人。
 */
function holdText(item: AdminApiAppealItem): string {
  if (item.overdue) {
    return "已超时";
  }
  if (item.status !== "pending") {
    return "—";
  }
  return item.holdRemainingMinutes === undefined
    ? "—"
    : `还剩 ${item.holdRemainingMinutes} 分钟`;
}
</script>

<template>
  <section class="card">
    <h1>申诉</h1>

    <p class="hint">
      复核（通过 / 驳回）目前仍在机器人里做（`/appeal`）：这里只读，
      超时未处理的会按 <b>{{ holdMinutes }}</b> 分钟的时限转派给其他审核员。
    </p>

    <div class="toolbar">
      <label for="appeal-group">群</label>
      <select id="appeal-group" v-model="groupFilter" @change="reload">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="appeal-status">状态</label>
      <select id="appeal-status" v-model="statusFilter" @change="reload">
        <option value="">（全部）</option>
        <option value="pending">待处理</option>
        <option value="accepted">已通过</option>
        <option value="rejected">已驳回</option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="reload">
        刷新
      </button>
    </div>

    <p class="hint">
      待处理 <b>{{ pendingCount }}</b> 条 · 超时转派时限 <b>{{ holdMinutes }}</b> 分钟
    </p>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!loading && items.length === 0 && !error" class="hint">
      没有符合条件的申诉。
    </p>

    <table v-if="items.length > 0" class="table">
      <thead>
        <tr>
          <th>提交时间</th>
          <th>群</th>
          <th>申诉人</th>
          <th>关联处罚</th>
          <th>理由</th>
          <th>状态</th>
          <th>处理人</th>
          <th>时限</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.appealId">
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
              :entity="item.appellant"
              :fallback="item.userId"
              :details="false"
            />
          </td>
          <td class="nowrap"><code>{{ item.punishmentCode }}</code></td>
          <td class="reason">{{ orDash(item.reason) }}</td>
          <td class="nowrap">
            {{ STATUS_LABEL[item.status] ?? item.status }}
          </td>
          <td>
            <EntityLabel
              v-if="item.reviewer"
              :entity="item.reviewer"
              :fallback="item.reviewerId"
              :details="false"
            />
            <span v-else>—</span>
          </td>
          <!-- 超时是「该转派了」的唯一提示，用红色；其余 pending 行给剩余分钟 -->
          <td class="nowrap" :class="{ error: item.overdue }">
            {{ holdText(item) }}
          </td>
          <!-- 详情：内部 id / 处理备注 / 完整官方长码只在这里出现 -->
          <td>
            <details>
              <summary>详情</summary>
              <dl class="detail-list">
                <dt>申诉短码</dt>
                <dd class="mono">{{ item.code }}</dd>
                <dt>申诉 ID</dt>
                <dd class="mono">{{ item.appealId }}</dd>
                <dt>处罚 ID</dt>
                <dd class="mono">{{ item.punishmentId }}</dd>
                <dt>处理备注</dt>
                <dd>{{ orDash(item.note) }}</dd>
                <dt>处理时间</dt>
                <dd>{{ formatOptionalTime(item.reviewedAt) }}</dd>
                <dt>申诉人</dt>
                <dd class="mono">{{ item.userId }}</dd>
                <dt>处理人</dt>
                <dd class="mono">{{ orDash(item.reviewerId) }}</dd>
                <dt>群 ID</dt>
                <dd class="mono">{{ item.groupId }}</dd>
              </dl>
            </details>
          </td>
        </tr>
      </tbody>
    </table>
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
