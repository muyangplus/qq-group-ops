<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiAuditRecord } from "@/api/admin";
import { ApiError } from "@/api/client";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 审计查询（E2-c）。
 *
 * 口径（docs/ADMIN-API.md 的 E1-g）：平台超管可以不选群查全量；
 * 其余人**必须选一个自己够审核员（120）的群**（服务端不带 `?group=` 会回 400）。
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

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <section class="card">
    <h1>审计查询</h1>

    <div class="toolbar">
      <label for="audit-group">群</label>
      <select id="audit-group" v-model="groupFilter" @change="search">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupId }}
        </option>
      </select>
      <input v-model="actorFilter" type="text" placeholder="操作人（actor）" />
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
          <th>动作</th>
          <th>状态</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in items" :key="record.recordId">
          <td class="nowrap">{{ formatTime(record.createdAt) }}</td>
          <td><code>{{ record.groupId || "—" }}</code></td>
          <td><code>{{ record.actorId }}</code></td>
          <td><code>{{ record.action }}</code></td>
          <td>{{ record.status }}</td>
          <td class="reason">{{ record.reason }}</td>
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
