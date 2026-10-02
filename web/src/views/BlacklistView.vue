<script setup lang="ts">
import { computed, ref, watch } from "vue";

import {
  adminApi,
  type AdminApiBlacklistEntry,
  type AdminApiBlacklistView,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 黑名单（列表 + 加入 / 解除）。
 *
 * 与处罚不同，**黑名单是严格的群维度**（后端不带 `?group=` 直接 400）：
 * 所以群下拉没有「全部群」这一项，超管也得先选一个群。
 *
 * 返回体里有本群一组 + 全局一组；全局那组只有平台 240 拿得到，拿不到时
 * `globalVisible === false` —— 界面要说明「权限不够」，不能把空数组显示成「全局没人」。
 *
 * 写操作与机器人里的 `/blacklist` 同源：本群要审核员 120、全局要平台超管 240，
 * 且**加入本群黑名单默认同时把人移出本群**；界面只负责藏按钮 / 禁用，服务端仍会 403。
 */
const session = useSessionStore();

const view = ref<AdminApiBlacklistView | null>(null);
const groupFilter = ref("");
const loading = ref(false);
const error = ref("");
/** 写操作成功回执（加入 / 解除）。 */
const notice = ref("");

/** 「加入黑名单」表单：目标给 QQ号 / #短码 / openid 原文，具体解析交给后端。 */
const addTarget = ref("");
const addReason = ref("");
const addScope = ref<"group" | "global">("group");
const addConfirming = ref(false);
const addBusy = ref(false);

/** 正在二次确认解除的那条（`null` = 没有弹窗）；范围取条目自己的 `scope`。 */
const removeTarget = ref<AdminApiBlacklistEntry | null>(null);
const removeBusy = ref(false);

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

/**
 * 界面的启用口径：本群审核员 120（平台超管按生效档折算，`isSuperAdmin` 再兜一层）。
 * 服务端仍会再判一次权限（不满足 403）。
 */
function canModerate(groupId: string): boolean {
  return session.isSuperAdmin || session.levelIn(groupId) >= MODERATOR_LEVEL;
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

/** 打开「加入黑名单」的二次确认；目标为空 / 本群没选群时按钮本来就禁用，这里再挡一次。 */
function openAdd(): void {
  if (addTarget.value.trim() === "") {
    return;
  }
  if (addScope.value === "group" && groupFilter.value === "") {
    return;
  }
  notice.value = "";
  addConfirming.value = true;
}

async function confirmAdd(): Promise<void> {
  const userId = addTarget.value.trim();
  if (userId === "") {
    return;
  }
  const scope = addScope.value;
  addBusy.value = true;
  try {
    const response = await adminApi.addBlacklist({
      scope,
      // 全局条目没有群（后端只在 scope=group 时要 group）；本群必须带当前群
      group: scope === "group" ? groupFilter.value : undefined,
      userId,
      reason: addReason.value.trim() === "" ? undefined : addReason.value.trim(),
    });
    // 后端 message 里已经带了「已踢出 N 个群」的口径，直接照实显示
    notice.value = response.result.message;
    error.value = "";
    addConfirming.value = false;
    // 清空输入，方便接着加下一个人；范围保留（超管可能连加几个全局）
    addTarget.value = "";
    addReason.value = "";
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    addBusy.value = false;
  }
}

function openRemove(entry: AdminApiBlacklistEntry): void {
  notice.value = "";
  removeTarget.value = entry;
}

async function confirmRemove(): Promise<void> {
  const entry = removeTarget.value;
  if (entry === null) {
    return;
  }
  removeBusy.value = true;
  try {
    const response = await adminApi.removeBlacklist({
      scope: entry.scope,
      // 解除全局不带群；解除本群必须带这条记录所属的群
      group: entry.scope === "group" ? entry.groupId : undefined,
      userId: entry.userId,
    });
    notice.value = response.result.message;
    error.value = "";
    removeTarget.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    removeBusy.value = false;
  }
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
      写操作与机器人里的 <code>/blacklist</code> 同源：本群要审核员 120、
      全局要平台超管 240；<b>加入本群黑名单会默认同时把人移出本群</b>。
      界面只负责藏按钮 / 禁用，服务端仍会再判一次权限。
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

    <h2 class="section-title">加入黑名单</h2>
    <div class="toolbar">
      <label for="blacklist-target">目标</label>
      <input
        id="blacklist-target"
        v-model="addTarget"
        type="text"
        placeholder="QQ号 / #短码 / openid"
      />
      <label for="blacklist-reason">理由</label>
      <input
        id="blacklist-reason"
        v-model="addReason"
        type="text"
        maxlength="120"
        placeholder="可选"
      />
      <label for="blacklist-scope">范围</label>
      <select id="blacklist-scope" v-model="addScope">
        <option value="group">
          本群{{ groupFilter === "" ? "" : `（${groupLabel(groupFilter)}）` }}
        </option>
        <!-- 全局拉黑要平台超管 240：非超管连选项都不出现（服务端仍会 403） -->
        <option v-if="session.isSuperAdmin" value="global">
          全局（所有已绑定群）
        </option>
      </select>
      <button
        type="button"
        :disabled="
          addTarget.trim() === '' || (addScope === 'group' && groupFilter === '')
        "
        :title="
          addTarget.trim() === ''
            ? '先填目标（QQ号 / #短码 / openid）'
            : addScope === 'group' && groupFilter === ''
              ? '先选一个群：本群黑名单是群维度的'
              : '加入黑名单（提交前确认）'
        "
        @click="openAdd"
      >
        加入黑名单
      </button>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>

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
            <th>操作</th>
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
            <td>
              <div class="row-actions">
                <button
                  type="button"
                  :disabled="!canModerate(entry.groupId)"
                  :title="
                    canModerate(entry.groupId)
                      ? '解除本群黑名单'
                      : '需要本群审核员（120）'
                  "
                  @click="openRemove(entry)"
                >
                  解除
                </button>
              </div>
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
            <th>操作</th>
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
            <!-- 全局那组本来就只对平台超管可见，这里再判一次，避免靠后端裁剪当权限开关 -->
            <td>
              <div v-if="session.isSuperAdmin" class="row-actions">
                <button type="button" title="解除全局拦截" @click="openRemove(entry)">
                  解除
                </button>
              </div>
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 加入：提交前说清「会踢人」，全局那份额外警告影响面 -->
    <ModalDialog
      :open="addConfirming"
      :title="addScope === 'global' ? '加入全局黑名单？' : '加入本群黑名单？'"
      :busy="addBusy"
      :danger="addScope === 'global'"
      :confirm-text="addScope === 'global' ? '确认全局拉黑' : '确认拉黑'"
      @close="addConfirming = false"
      @confirm="confirmAdd"
    >
      <p class="hint">
        目标 <code>{{ addTarget.trim() }}</code> · 范围
        {{
          addScope === "global"
            ? "全局（所有已绑定群）"
            : `本群 ${groupFilter === "" ? "" : groupLabel(groupFilter)}`
        }}
      </p>
      <p v-if="addScope === 'global'" class="hint">
        会影响<b>所有已绑定群</b>，并把人从所有群移出；<b>不可逆</b>。
        只有平台超管能操作。
      </p>
      <p v-else class="hint">
        会把人移出本群并加入本群黑名单（<b>不可逆</b>）；本群黑名单只影响该群。
      </p>
      <p v-if="addReason.trim()" class="hint">理由：{{ addReason.trim() }}</p>
    </ModalDialog>

    <!-- 解除：全局那份说清「不再被全局拦截」，本群那份说明官方群拉黑也会一并解除 -->
    <ModalDialog
      :open="removeTarget !== null"
      title="解除黑名单？"
      :busy="removeBusy"
      confirm-text="确认解除"
      @close="removeTarget = null"
      @confirm="confirmRemove"
    >
      <template v-if="removeTarget">
        <p class="hint">
          目标
          <EntityLabel
            :entity="removeTarget.user"
            :fallback="removeTarget.userId"
            :details="false"
          />
          · 范围
          {{
            removeTarget.scope === "global"
              ? "全局（所有已绑定群）"
              : `本群 ${groupLabel(removeTarget.groupId)}`
          }}
        </p>
        <p v-if="removeTarget.scope === 'global'" class="hint">
          解除后此人不再被全局拦截（这条全局黑名单会被删除）。
        </p>
        <p v-else class="hint">
          解除后此人不再被本群拦截；官方群拉黑也会一并解除。
        </p>
      </template>
    </ModalDialog>
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
