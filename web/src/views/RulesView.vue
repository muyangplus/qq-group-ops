<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { adminApi, type AdminApiRulesView } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { GROUP_ADMIN_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 规则编辑（E2-c）。
 *
 * 口径（docs/ADMIN-API.md 的 E1-g / E1-d）：
 * - **读**：本群审核员 120 起（全局规则要平台超管）；
 * - **写**：本群群管理员 130 起（全局规则要平台超管），`PUT /api/rules { group, field, value }`；
 * - 值由机器人侧的 `parseRuleSetting` 解析：非法值整体拒绝、不留半套，
 *   所以提交前先给 **diff**（字段 / 旧值 → 新值）再确认。
 */
const session = useSessionStore();

const groups = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
const groupId = ref("");
const view = ref<AdminApiRulesView | null>(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");

const field = ref("");
const value = ref("");
const confirming = ref(false);
const busy = ref(false);
const diff = ref<{ before: string; after: string } | null>(null);

/** 常用字段名（只是提示：真正合法的字段由机器人侧解析，写错会回 400）。 */
const FIELD_HINTS = [
  "keywords",
  "warning",
  "mute",
  "autoApprove",
  "joinAudit",
  "wordFilter",
  "export",
  "punishActions",
  "joinDecision",
  "joinRequireClass",
  "joinRequireName",
  "joinAnswerPattern",
  "joinReviewOpinion",
  "notifyAutoApproved",
  "allowColleges",
  "denyColleges",
  "allowYears",
  "denyYears",
];

const canEdit = computed(
  () => groupId.value !== "" && session.levelIn(groupId.value) >= GROUP_ADMIN_LEVEL,
);
const isGlobal = computed(() => groupId.value === "__default__");
const overrideFields = computed(() =>
  view.value?.override ? Object.keys(view.value.override).sort() : [],
);

/** 群选择器的展示文本：`__default__` →「全局默认」，其余走群号 → 短码（`value` 仍是内部 id）。 */
function groupLabel(id: string): string {
  return id === "__default__" ? "全局默认" : session.groupLabelIn(id);
}

/** 页面顶部「当前群」的正文文本。 */
const currentGroupName = computed((): string =>
  groupId.value === "" ? "" : groupLabel(groupId.value),
);

async function load(): Promise<void> {
  if (groupId.value === "") {
    return;
  }
  if (isGlobal.value && !session.isSuperAdmin) {
    error.value = "全局规则需要平台超级管理员。";
    view.value = null;
    return;
  }
  loading.value = true;
  try {
    view.value = await adminApi.rules(groupId.value);
    error.value = "";
  } catch (err) {
    view.value = null;
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 默认选中第一个自己能改的群；超管额外给一个「全局规则」。 */
onMounted(async () => {
  const editable = groups.value.find(
    (groupId) => session.levelIn(groupId) >= GROUP_ADMIN_LEVEL,
  );
  groupId.value = editable ?? groups.value[0] ?? (session.isSuperAdmin ? "__default__" : "");
  await load();
});

watch(groupId, () => {
  notice.value = "";
  void load();
});

function currentValue(name: string): string {
  const own = view.value?.override?.[name];
  const effective = view.value?.effective?.[name];
  const chosen = own !== undefined ? own : effective;
  if (chosen === undefined) {
    return "（未设置）";
  }
  return Array.isArray(chosen) ? chosen.join("、") : String(chosen);
}

function startEdit(name: string): void {
  field.value = name;
  // 覆盖值优先：编辑的语义就是「写一条覆盖」
  const own = view.value?.override?.[name];
  const seed = own !== undefined ? own : view.value?.effective?.[name];
  value.value = seed === undefined ? "" : Array.isArray(seed) ? seed.join(",") : String(seed);
  notice.value = "";
}

function openConfirm(): void {
  if (field.value.trim() === "" || !canEdit.value) {
    return;
  }
  diff.value = {
    before: currentValue(field.value.trim()),
    after: value.value === "" ? "（清空 / 恢复默认）" : value.value,
  };
  confirming.value = true;
}

async function confirmUpdate(): Promise<void> {
  busy.value = true;
  try {
    const result = await adminApi.updateRule(groupId.value, field.value.trim(), value.value);
    notice.value = `${result.message}（字段：${result.fields.join("、") || "—"}）`;
    confirming.value = false;
    field.value = "";
    value.value = "";
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h1>规则编辑</h1>

    <div class="toolbar">
      <label for="rules-group">群</label>
      <select id="rules-group" v-model="groupId">
        <!-- 文本是展示名，value 仍是内部 id（`__default__` = 全局默认规则） -->
        <option v-for="id in groups" :key="id" :value="id">{{ groupLabel(id) }}</option>
        <option v-if="session.isSuperAdmin" value="__default__">全局默认（平台超管）</option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
      <span v-if="!canEdit" class="hint">
        只读（改规则需要本群群管理员 130{{ isGlobal ? " / 平台超管 240" : "" }}）
      </span>
    </div>

    <p v-if="groupId !== ''" class="hint">
      当前群 <EntityLabel :entity="view?.group" :fallback="currentGroupName" />
    </p>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>

    <template v-if="view">
      <h2 class="section-title">
        覆盖字段（{{ overrideFields.length }}）
      </h2>
      <p v-if="overrideFields.length === 0" class="hint">
        这个{{ isGlobal ? "全局" : "群" }}没有显式覆盖，全部继承默认值。
      </p>
      <ul v-else class="chips">
        <li v-for="name in overrideFields" :key="name">
          <button type="button" class="chip" @click="startEdit(name)">
            {{ name }}
          </button>
        </li>
      </ul>

      <h2 class="section-title">修改一个字段</h2>
      <div class="toolbar">
        <input
          v-model="field"
          type="text"
          list="rule-fields"
          placeholder="字段名，如 keywords / warning"
          :disabled="!canEdit"
        />
        <datalist id="rule-fields">
          <option v-for="name in FIELD_HINTS" :key="name" :value="name" />
        </datalist>
        <input
          v-model="value"
          type="text"
          placeholder="新值（清空 = 恢复默认）"
          :disabled="!canEdit"
        />
        <button type="button" :disabled="!canEdit || field.trim() === ''" @click="openConfirm">
          提交
        </button>
      </div>
      <p class="hint">
        值由机器人侧同一套解析器校验（非法值整体拒绝、不留半套）：开关类填
        <code>on/off</code>，关键词用逗号 / 顿号分隔，禁言时长填秒数。
      </p>

      <h2 class="section-title">生效配置</h2>
      <table class="table">
        <tbody>
          <tr v-for="(v, k) in view.effective ?? {}" :key="k">
            <th class="nowrap">{{ k }}</th>
            <td class="reason">{{ Array.isArray(v) ? v.join("、") : String(v) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!view.effective" class="hint">
        当前连的是只读巡检进程：它没有机器人内存态，只能给出覆盖字段。
      </p>
    </template>

    <ModalDialog
      :open="confirming"
      title="确认修改？"
      :busy="busy"
      confirm-text="确认提交"
      @close="confirming = false"
      @confirm="confirmUpdate"
    >
      <p class="hint">
        {{ currentGroupName }} · 字段 <code>{{ field.trim() }}</code>
      </p>
      <p class="diff">
        <span class="before">{{ diff?.before }}</span>
        →
        <span class="after">{{ diff?.after }}</span>
      </p>
      <p class="hint">
        提交后会写一条 <code>admin_api:rule_update</code> 审计，可在「审计查询」里核对。
      </p>
    </ModalDialog>
  </section>
</template>
