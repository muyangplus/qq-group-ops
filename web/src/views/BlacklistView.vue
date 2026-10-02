<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { adminApi, type AdminApiBlacklistView } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 黑名单（只读）。
 *
 * 与处罚不同，**黑名单是严格的群维度**（后端不带 `?group=` 直接 400）：
 * 所以群下拉没有「全部群」这一项，超管也得先选一个群。
 *
 * 返回体里有本群一组 + 全局一组；全局那组只有平台 240 拿得到，拿不到时
 * `globalVisible === false` —— 界面要说明「权限不够」，不能把空数组显示成「全局没人」。
 * 写操作（拉黑 / 移出）目前仍只在机器人指令里做，后台只读。
 */
const session = useSessionStore();

const view = ref<AdminApiBlacklistView | null>(null);
const groupFilter = ref("");
const loading = ref(false);
const error = ref("");

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（后端要的就是它）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

/** 正文字段缺省时的兜底：空串给「—」，别让单元格看起来像坏了。 */
function orDash(value: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "—";
}

async function load(): Promise<void> {
  if (groupFilter.value === "") {
    // 还没选群（权限画像刚回来 / 没有任何群）：不发请求，等服务端口的 400 不如自己先说清
    error.value = "请先选择一个群：黑名单是群维度的，没有「全部群」。";
    view.value = null;
    return;
  }
  loading.value = true;
  try {
    view.value = await adminApi.blacklist(groupFilter.value);
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/**
 * 默认选中第一个自己够审核员（120）的群：非超管没有别的选择，
 * 超管也总得选一个（所以这里不为超管留「全部群」）。
 *
 * 权限画像由路由守卫先 `load()` 完，所以 `immediate` 这一次基本就拿得到群；
 * 万一画像来得晚（直接进页面且守卫还没跑完），watch 再补一次。
 */
let picked = false;
watch(
  groupOptions,
  (options) => {
    if (picked || groupFilter.value !== "" || options.length === 0) {
      return;
    }
    picked = true;
    groupFilter.value =
      options.find((groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL) ??
      options[0]!;
    void load();
  },
  { immediate: true },
);

async function changeGroup(): Promise<void> {
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
    <h1>黑名单</h1>

    <p class="hint">
      本群黑名单只影响该群；全局黑名单影响<b>所有已绑定群</b>。
      拉黑 / 移出目前仍在机器人指令里做，后台只读。
    </p>

    <div class="toolbar">
      <label for="blacklist-group">群</label>
      <select id="blacklist-group" v-model="groupFilter" @change="changeGroup">
        <!-- 没有「全部群」：黑名单接口是群维度的，后端不带 group 就回 400 -->
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="view && !loading">
      <h2 class="section-title">本群黑名单</h2>
      <p class="hint">只影响本群：群成员被拉黑后无法发言 / 入群（按本群规则生效）。</p>
      <p v-if="view.entries.length === 0" class="hint">本群黑名单是空的。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>加入时间</th>
            <th>被拉黑人</th>
            <th>原因</th>
            <th>加入者</th>
            <th>来源</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in view.entries" :key="`${entry.groupId}:${entry.userId}`">
            <td class="nowrap">{{ formatTime(entry.createdAt) }}</td>
            <td>
              <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
              <EntityLabel
                :entity="entry.user"
                :fallback="entry.userId"
                :details="false"
              />
            </td>
            <td class="reason">{{ orDash(entry.reason) }}</td>
            <td>
              <EntityLabel
                :entity="entry.actor"
                :fallback="entry.actorId"
                :details="false"
              />
            </td>
            <td class="nowrap"><code>{{ orDash(entry.source) }}</code></td>
            <!-- 详情：完整官方长码只在这里出现 -->
            <td>
              <details>
                <summary>详情</summary>
                <dl class="detail-list">
                  <dt>范围</dt>
                  <dd>本群 · {{ groupLabel(entry.groupId) }}</dd>
                  <dt>被拉黑人</dt>
                  <dd class="mono">{{ entry.userId }}</dd>
                  <dt>群 ID</dt>
                  <dd class="mono">{{ entry.groupId }}</dd>
                  <dt>加入者</dt>
                  <dd class="mono">{{ entry.actorId }}</dd>
                  <dt>条目 ID</dt>
                  <dd class="mono">{{ entry.scope }}:{{ entry.userId }}</dd>
                </dl>
              </details>
            </td>
          </tr>
        </tbody>
      </table>

      <h2 class="section-title">全局黑名单</h2>
      <p class="hint">影响所有已绑定群（全局默认群口径）。</p>
      <!-- 权限不够时不要显示成空表：空表会让人以为「全局没人被拉黑」 -->
      <p v-if="!view.globalVisible" class="hint">
        全局黑名单只有平台超管可见（需要 240）。
      </p>
      <p v-else-if="view.globalEntries.length === 0" class="hint">
        全局黑名单是空的。
      </p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>加入时间</th>
            <th>被拉黑人</th>
            <th>原因</th>
            <th>加入者</th>
            <th>来源</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in view.globalEntries"
            :key="`global:${entry.userId}`"
          >
            <td class="nowrap">{{ formatTime(entry.createdAt) }}</td>
            <td>
              <EntityLabel
                :entity="entry.user"
                :fallback="entry.userId"
                :details="false"
              />
            </td>
            <td class="reason">{{ orDash(entry.reason) }}</td>
            <td>
              <EntityLabel
                :entity="entry.actor"
                :fallback="entry.actorId"
                :details="false"
              />
            </td>
            <td class="nowrap"><code>{{ orDash(entry.source) }}</code></td>
            <td>
              <details>
                <summary>详情</summary>
                <dl class="detail-list">
                  <dt>范围</dt>
                  <dd>全局（所有已绑定群）</dd>
                  <dt>被拉黑人</dt>
                  <dd class="mono">{{ entry.userId }}</dd>
                  <dt>加入者</dt>
                  <dd class="mono">{{ entry.actorId }}</dd>
                </dl>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
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
