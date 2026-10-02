<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiAuditRecord } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { entityLabel, isEmptyGroupRef } from "@/lib/entity";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 审计查询（E2-c）。
 *
 * 口径（docs/ADMIN-API.md 的 E1-g）：平台超管可以不选群查全量；
 * 其余人**必须选一个自己够审核员（120）的群**（服务端不带 `?group=` 会回 400）。
 *
 * 展示口径（E2-e）：正文只出「群号 / QQ号 → 短码」，完整官方长码收进每行末尾的「详情」折叠区。
 */
const session = useSessionStore();

const items = ref<AdminApiAuditRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(30);
const groupFilter = ref("");
const actorFilter = ref("");
const actionFilter = ref("");
const loading = ref(false);
const error = ref("");

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);
/** 非超管必须选群：默认就选第一个自己够权限的群，省得用户先撞一次 400。 */
const needsGroup = computed(() => !session.isSuperAdmin);

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（过滤器要发给后端）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

async function load(): Promise<void> {
  if (needsGroup.value && groupFilter.value === "") {
    const first = groupOptions.value.find(
      (groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL,
    );
    if (first === undefined) {
      error.value = "你在任何群里都没有审核员（120）权限，看不到审计记录。";
      items.value = [];
      total.value = 0;
      return;
    }
    groupFilter.value = first;
  }
  loading.value = true;
  try {
    const result = await adminApi.audit({
      page: page.value,
      pageSize: pageSize.value,
      group: groupFilter.value || undefined,
      actor: actorFilter.value.trim() || undefined,
      action: actionFilter.value.trim() || undefined,
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

/** 「详情」折叠区里的一行：展示名 + 完整官方长码（或审计记录 id），等宽显示。 */
interface AuditIdRow {
  label: string;
  name: string;
  value: string;
}

/**
 * 一行的完整 id（群 / 操作人 / 操作对象 + 记录 id）。
 *
 * 官方长码（32 位十六进制）只在这里出现，正文单元格一律用展示名；
 * 平台级动作的群 id 是空串（匿名化之类根本没有群），这时只列平台范围 / 操作人 / 对象 / 记录。
 */
function auditIdRows(record: AdminApiAuditRecord): AuditIdRow[] {
  const rows: AuditIdRow[] = [];
  if (isEmptyGroupRef(record.group)) {
    rows.push({ label: "范围", name: "平台全局", value: "（无群）" });
  } else {
    rows.push({
      label: "群",
      name: entityLabel(record.group, record.groupId),
      value: record.group.officialId,
    });
  }
  rows.push({
    label: "操作人",
    name: entityLabel(record.actor, record.actorId),
    value: record.actor.officialId,
  });
  if (record.target && record.targetUserId !== undefined) {
    rows.push({
      label: "操作对象",
      name: entityLabel(record.target, record.targetUserId),
      value: record.target.officialId,
    });
  }
  rows.push({ label: "审计记录", name: "", value: record.recordId });
  return rows;
}

/**
 * 时间列：`createdAt` 可能是 ISO 字符串（`2026-09-26T05:31:59.203Z`）也可能是毫秒数，
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
    <h1>审计查询</h1>

    <div class="toolbar">
      <label for="audit-group">群</label>
      <select id="audit-group" v-model="groupFilter" @change="search">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <!-- 文本是展示名，value 仍是内部 groupId：过滤器要用它发给后端 -->
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <input v-model="actorFilter" type="text" placeholder="操作人（完整 id）" />
      <input v-model="actionFilter" type="text" placeholder="动作（如 data_delete）" />
      <button type="button" :disabled="loading" @click="search">查询</button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!loading && items.length === 0 && !error" class="hint">
      没有符合条件的审计记录。
    </p>

    <table v-if="items.length > 0" class="table">
      <thead>
        <tr>
          <th>时间</th>
          <th>群</th>
          <th>操作人</th>
          <th>操作对象</th>
          <th>动作</th>
          <th>状态</th>
          <th>说明</th>
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
              :entity="record.actor"
              :fallback="record.actorId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              v-if="record.target"
              :entity="record.target"
              :fallback="record.targetUserId ?? '—'"
              :details="false"
            />
            <span v-else>—</span>
          </td>
          <td><code>{{ record.action }}</code></td>
          <td>{{ record.status }}</td>
          <!-- 说明列：空值给「—」，长文本按 `.reason` 换行，不撑破表格 -->
          <td class="reason">{{ record.reason || "—" }}</td>
          <!-- 详情：完整官方 id 只在这里出现 -->
          <td>
            <details>
              <summary>详情</summary>
              <dl class="audit-details">
                <template v-for="row in auditIdRows(record)" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd>
                    <span v-if="row.name">{{ row.name }} · </span>
                    <span class="mono">{{ row.value }}</span>
                  </dd>
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
/* 审计详情折叠区的排版：标签靠左、长 id 允许折行（表格列宽不被 32 位十六进制撑坏） */
.audit-details {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 10px;
  margin: 4px 0 0;
  max-width: 42ch;
}

.audit-details dt {
  color: var(--muted);
  white-space: nowrap;
}

.audit-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
