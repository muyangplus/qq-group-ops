<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiIdentitiesView,
  type AdminApiIdentityItem,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import { useSessionStore } from "@/stores/session";

/**
 * 身份映射只读（P3）。
 *
 * 只回答「这个群号对应哪个群 ID / 这个 QQ号是谁 / 什么时候绑的」——
 * `/bind user`、`/bind groupid`（代绑任意主体）的**写**刻意不搬：那是高权限动作，
 * 留在机器人里更安全（后台只做排查用的展示）。
 *
 * 门槛：平台超管 240（与 `/perm` 同档，身份映射是平台级数据）。
 */
const session = useSessionStore();

const view = ref<AdminApiIdentitiesView | null>(null);
const loading = ref(false);
const error = ref("");
const filter = ref("");

const allowed = computed(() => session.isSuperAdmin);

function matches(row: AdminApiIdentityItem): boolean {
  const keyword = filter.value.trim().toLowerCase();
  if (keyword.length === 0) {
    return true;
  }
  return (
    row.officialId.toLowerCase().includes(keyword) ||
    row.externalId.toLowerCase().includes(keyword) ||
    row.entity.label.toLowerCase().includes(keyword)
  );
}

const users = computed(() => (view.value?.users ?? []).filter(matches));
const groups = computed(() => (view.value?.groups ?? []).filter(matches));

async function load(): Promise<void> {
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    view.value = await adminApi.identities();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function formatTime(value: string | undefined): string {
  if (value === undefined) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <section class="card">
    <h1>身份</h1>
    <p class="hint">
      群号 ↔ 群 ID、QQ号 ↔ openid 的映射（只读）。排查「这个人是谁 / 这个群号对应哪个群」时用；
      <b>代绑（<code>/bind user</code>、<code>/bind groupid</code>）的写操作刻意不搬</b> ——
      那是高权限动作，留在机器人里更安全。门槛：平台超管（240）。
    </p>

    <p v-if="!allowed" class="hint">需要平台超管（240）才能看这个页面。</p>

    <template v-else>
      <div class="toolbar">
        <label for="identity-filter">过滤</label>
        <input
          id="identity-filter"
          v-model="filter"
          placeholder="群号 / QQ号 / openid"
          title="按展示号或内部 ID 过滤（纯前端）"
        />
        <button type="button" class="link" :disabled="loading" @click="load">刷新</button>
        <span class="hint">
          用户 {{ users.length }} / {{ view?.users.length ?? 0 }} · 群
          {{ groups.length }} / {{ view?.groups.length ?? 0 }}
        </span>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-if="error" class="error">{{ error }}</p>

      <div class="section-title">QQ号 ↔ openid</div>
      <p v-if="users.length === 0" class="hint">还没有绑定（或都被过滤掉了）。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>QQ号</th>
            <th>openid</th>
            <th>首次绑定</th>
            <th>最近改绑</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in users" :key="row.officialId">
            <td>{{ row.externalId }}</td>
            <td class="mono">{{ row.officialId }}</td>
            <td class="nowrap">{{ formatTime(row.createdAt) }}</td>
            <td class="nowrap">{{ formatTime(row.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">群号 ↔ 群 ID</div>
      <p v-if="groups.length === 0" class="hint">还没有绑定（或都被过滤掉了）。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>群号</th>
            <th>群 ID</th>
            <th>首次绑定</th>
            <th>最近改绑</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in groups" :key="row.officialId">
            <td>{{ row.externalId }}</td>
            <td class="mono">{{ row.officialId }}</td>
            <td class="nowrap">{{ formatTime(row.createdAt) }}</td>
            <td class="nowrap">{{ formatTime(row.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
