<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import {
  adminApi,
  type AdminApiRuleChange,
  type AdminApiRuleOverridesView,
  type AdminApiRulesView,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { GROUP_ADMIN_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 规则编辑（E2-c + 收尾批次 E）。
 *
 * 口径（docs/ADMIN-API.md 的 E1-g / E1-d / E1-s）：
 * - **读**：本群审核员 120 起（全局规则要平台超管）；
 * - **写**：本群群管理员 130 起（全局规则要平台超管），`PUT /api/rules { group, field, value }`
 *   或**一次改多项** `{ group, updates: [{ field, value }] }`；
 * - 值由机器人侧的 `parseRuleSetting` 解析：非法值整体拒绝、不留半套（批量会**先全部校验再落库**），
 *   所以提交前先给 **diff**（字段 / 旧值 → 新值）再确认；
 * - **覆盖率总览**（平台超管 240，只读）：哪些群覆盖了哪些字段 —— 与机器人
 *   `/rules overrides` 同一数据源。
 *
 * 页面里另外两块写操作：
 * - **关键词逐条增删**（`POST /api/rules/keywords`）：单条失败只进 `skipped`、不整批失败，
 *   所以界面必须把被跳过的词与原因如实列出来（已存在 / 不存在不会静默成功）；
 * - **恢复继承**（字段级 / 整群）：清掉本群覆盖、回落到全局默认，**不可逆**，整群那条要二次确认。
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

/** 关键词：输入框内容 + 上一次增删的回执（含被跳过的词）。 */
const keywordInput = ref("");
const keywordBusy = ref(false);
const keywordResult = ref<{
  message: string;
  skipped: Array<{ word: string; reason: string }>;
} | null>(null);

/**
 * 恢复继承：`fields` = 字段级确认弹窗；`resettingAll` = 整群确认弹窗。
 * 两者都不可逆，所以都走 `ModalDialog`（字段级只清指定覆盖，整群那份要在弹窗里写清后果）。
 */
const resetBusy = ref(false);
const resetFieldConfirming = ref(false);
const resettingAll = ref(false);
const resetAllBusy = ref(false);

/**
 * 「哪些字段在覆盖」以服务端返回为准：本地先记一份，恢复继承后直接用返回的
 * `overriddenFields` 覆盖（不必再等一次读请求，标记立刻变对）。
 */
const overriddenNames = ref<string[] | null>(null);
const currentOverridden = computed((): string[] =>
  overriddenNames.value ?? overrideFields.value,
);

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

/**
 * 关键词展示口径：**本群覆盖优先，其次生效配置**，两个都缺 = 没配过（显示「（未配置）」而不是空表）。
 * 数组里的顺序就是后端保存的顺序（trim、去重、按字典序）。
 */
const keywords = computed((): string[] => {
  const own = view.value?.override?.keywords;
  const effective = view.value?.effective?.keywords;
  const chosen = own !== undefined ? own : effective;
  return Array.isArray(chosen) ? chosen.filter((word): word is string => typeof word === "string") : [];
});

/** 关键词的界面门槛：本群群管理员 130；全局（`__default__`）只有平台超管 240。 */
const canEditKeywords = computed((): boolean => {
  if (groupId.value === "" || (isGlobal.value && !session.isSuperAdmin)) {
    return false;
  }
  return session.levelIn(groupId.value) >= GROUP_ADMIN_LEVEL;
});

const keywordDisabledReason = computed((): string => {
  if (groupId.value === "") {
    return "先选一个群";
  }
  if (isGlobal.value && !session.isSuperAdmin) {
    return "全局关键词需要平台超管（240）";
  }
  return "改关键词需要本群群管理员（130）";
});

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
    // 重新拉取后以响应里的覆盖字段为准（丢掉上一次恢复继承留下的本地标记）
    overriddenNames.value = null;
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
  await loadOverrides();
});

watch(groupId, () => {
  notice.value = "";
  // 换群：关键词输入、待改清单与上一次的回执都不该跟着搬过去
  keywordInput.value = "";
  keywordResult.value = null;
  overriddenNames.value = null;
  pendingChanges.value = [];
  lastChanges.value = null;
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
    await loadOverrides();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/**
 * 一次粘贴多个词：**逗号 / 顿号 / 空格**（含全角与换行）都当分隔符，拆成数组交给后端。
 *
 * 为什么在前端拆：后端的 `words` 就是「批量逐条」的语义，一次请求比循环单发少很多往返；
 * 逐条的校验（空 / 超长 / 已存在 / 不存在）仍然由后端做，错的只进 `skipped`。
 */
function splitWords(text: string): string[] {
  return text
    .split(/[,，、;；\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/** 把后端的 `skipped` 展开成人话：`词（原因）` 逐个列出，不静默吞掉。 */
function skipText(skipped: Array<{ word: string; reason: string }>): string {
  return skipped.map((item) => `${item.word === "" ? "（空）" : item.word}（${item.reason}）`).join("；");
}

/** 关键词增删：失败时只提示错误、**不**清空输入（重试还要用），成功后重新拉取规则视图。 */
async function changeKeywords(action: "add" | "remove", words: string[]): Promise<void> {
  if (words.length === 0 || !canEditKeywords.value) {
    return;
  }
  keywordBusy.value = true;
  try {
    const result = await adminApi.ruleKeywords(groupId.value, action, words);
    keywordResult.value = { message: result.message, skipped: result.skipped };
    error.value = "";
    if (action === "add") {
      keywordInput.value = "";
    }
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    keywordBusy.value = false;
  }
}

async function addKeywords(): Promise<void> {
  await changeKeywords("add", splitWords(keywordInput.value));
}

async function removeKeyword(word: string): Promise<void> {
  await changeKeywords("remove", [word]);
}

/**
 * 恢复字段继承：清掉当前**全部**已覆盖字段的覆盖。
 *
 * 之所以做「全部已覆盖字段」而不是让用户再勾一遍：这个页面上「恢复继承」的心智就是
 * 「把本群改过的都退回默认」，逐字段的精细操作在机器人 `/rules reset` 里也有；
 * 提交前弹窗把字段名单列出来，避免误点。
 */
async function confirmResetFields(): Promise<void> {
  const fields = currentOverridden.value;
  if (fields.length === 0 || !canEditKeywords.value) {
    return;
  }
  resetBusy.value = true;
  try {
    const result = await adminApi.resetRuleFields(groupId.value, fields);
    notice.value = result.message;
    // 用返回的 overriddenFields 立刻刷新「哪些字段在覆盖」的标记
    overriddenNames.value = [...result.overriddenFields];
    error.value = "";
    resetFieldConfirming.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    resetBusy.value = false;
  }
}

/** 恢复整群继承：清空该群全部覆盖（不可逆），弹窗里必须写清后果。 */
async function confirmResetAll(): Promise<void> {
  if (!canEditKeywords.value) {
    return;
  }
  resetAllBusy.value = true;
  try {
    const result = await adminApi.resetRuleGroup(groupId.value);
    notice.value = result.message;
    overriddenNames.value = [...result.overriddenFields];
    error.value = "";
    resettingAll.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    resetAllBusy.value = false;
  }
}

// —— 覆盖率总览（只读，平台超管 240）：哪些群覆盖了哪些字段
const overrides = ref<AdminApiRuleOverridesView | null>(null);
const overridesError = ref("");

async function loadOverrides(): Promise<void> {
  if (!session.isSuperAdmin) {
    return;
  }
  try {
    overrides.value = await adminApi.ruleOverrides();
    overridesError.value = "";
  } catch (err) {
    overrides.value = null;
    overridesError.value = err instanceof ApiError ? err.message : String(err);
  }
}

// —— 一次改多项：先把改动攒进清单，再一次性提交（服务端先全校验、再落库）
const pendingChanges = ref<Array<{ field: string; value: string }>>([]);
const batchConfirming = ref(false);
const batchBusy = ref(false);
/** 上一次批量提交的 diff 回执（服务端算的，与审计同一份）。 */
const lastChanges = ref<AdminApiRuleChange[] | null>(null);

/** 清单里一项的「旧值 → 新值」：旧值取当前生效值，与单字段确认同一口径。 */
function pendingDiff(item: { field: string; value: string }): {
  before: string;
  after: string;
} {
  return {
    before: currentValue(item.field),
    after: item.value === "" ? "（清空 / 恢复默认）" : item.value,
  };
}

/** 加入清单：同名字段只留最后一次（清单是「待改」而不是历史）。 */
function addPendingChange(): void {
  const name = field.value.trim();
  if (name === "" || !canEdit.value) {
    return;
  }
  pendingChanges.value = [
    ...pendingChanges.value.filter((item) => item.field !== name),
    { field: name, value: value.value },
  ];
  field.value = "";
  value.value = "";
  notice.value = "";
}

function removePendingChange(name: string): void {
  pendingChanges.value = pendingChanges.value.filter(
    (item) => item.field !== name,
  );
}

async function confirmBatch(): Promise<void> {
  if (pendingChanges.value.length === 0) {
    return;
  }
  batchBusy.value = true;
  try {
    const result = await adminApi.updateRules(groupId.value, pendingChanges.value);
    notice.value = `${result.message}（改了 ${result.changes.length} 个字段）`;
    lastChanges.value = result.changes;
    pendingChanges.value = [];
    batchConfirming.value = false;
    error.value = "";
    await load();
    await loadOverrides();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    batchBusy.value = false;
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

    <!-- 覆盖率总览（只读，平台超管 240）：与机器人 `/rules overrides` 同一数据源 -->
    <template v-if="session.isSuperAdmin">
      <h2 class="section-title">覆盖率总览</h2>
      <p class="hint">
        全局默认只影响<b>未覆盖</b>的群；下面是各群显式覆盖的字段（与机器人
        <code>/rules overrides</code> 同一数据源）。
        <span v-if="overrides">
          共 {{ overrides.totalGroups }} 个群 · {{ overrides.totalFields }} 个字段。
        </span>
      </p>
      <p v-if="overridesError" class="error">{{ overridesError }}</p>
      <p
        v-else-if="overrides && overrides.items.length === 0"
        class="hint"
      >
        没有任何群覆盖全局规则（全部继承全局）。
      </p>
      <table v-else-if="overrides" id="rule-overrides" class="table">
        <thead>
          <tr>
            <th>群</th>
            <th>覆盖字段数</th>
            <th>覆盖了哪些字段</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in overrides.items" :key="item.groupId">
            <td>
              <EntityLabel :entity="item.group" :fallback="item.groupId" />
            </td>
            <td>{{ item.fieldCount }}</td>
            <td class="reason">
              <code
                v-for="(label, index) in item.labels"
                :key="item.fields[index] ?? index"
                class="chip"
              >
                {{ label }}
              </code>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-if="view">
      <h2 class="section-title">
        覆盖字段（覆盖中 {{ currentOverridden.length }}）
      </h2>
      <p v-if="currentOverridden.length === 0" class="hint">
        这个{{ isGlobal ? "全局" : "群" }}没有显式覆盖，全部继承默认值。
      </p>
      <ul v-else class="chips">
        <li v-for="name in currentOverridden" :key="name">
          <button type="button" class="chip" @click="startEdit(name)">
            {{ name }}
          </button>
        </li>
      </ul>

      <h2 class="section-title">修改一个字段</h2>
      <div class="toolbar">
        <input
          id="rule-field"
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
          id="rule-value"
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

      <h2 class="section-title">一次改多项</h2>
      <p class="hint">
        把几个字段的改动攒进清单、一次提交（服务端<b>先全部校验、再落库</b>：有一项不合法就整体拒绝，
        不会改一半）；确认框里会列出每个字段的<b>旧值 → 新值</b>。
      </p>
      <div class="toolbar">
        <button
          type="button"
          class="link"
          :disabled="!canEdit || field.trim() === ''"
          :title="canEdit ? '把上面填的字段 / 值加进待改清单' : '改规则需要本群群管理员 130'"
          @click="addPendingChange"
        >
          加入清单
        </button>
        <span v-if="pendingChanges.length > 0" class="hint">
          清单 {{ pendingChanges.length }} 项
        </span>
      </div>
      <table v-if="pendingChanges.length > 0" id="rule-batch" class="table">
        <thead>
          <tr>
            <th>字段</th>
            <th>旧值</th>
            <th>新值</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pendingChanges" :key="item.field">
            <td><code>{{ item.field }}</code></td>
            <td class="reason">{{ pendingDiff(item).before }}</td>
            <td class="reason">{{ pendingDiff(item).after }}</td>
            <td>
              <button
                type="button"
                class="link"
                @click="removePendingChange(item.field)"
              >
                移出
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="pendingChanges.length > 0" class="toolbar">
        <button
          type="button"
          :disabled="batchBusy || !canEdit"
          @click="batchConfirming = true"
        >
          提交 {{ pendingChanges.length }} 项
        </button>
        <button
          type="button"
          class="link"
          :disabled="batchBusy"
          @click="pendingChanges = []"
        >
          清空清单
        </button>
      </div>
      <p v-if="pendingChanges.length > 0" class="hint">
        清单里的「旧值」是按你填的字段名在当前配置里查的；填的是<b>别名</b>时
        （例如 <code>warning</code> → <code>warningMessage</code>），以提交后回执里的 diff 为准。
      </p>
      <p v-if="lastChanges" class="ok">
        上次提交：
        {{
          lastChanges
            .map((change) => `${change.label} ${change.before} → ${change.after}`)
            .join("；")
        }}
      </p>

      <h2 class="section-title">关键词管理</h2>
      <p class="hint">
        关键词命中后按 <code>warning</code> / <code>mute</code> / <code>wordFilter</code> 等字段的动作处理。
        增删是<b>逐条</b>的：保存时自动 <code>trim</code>、去重、按字典序排列，单条最长 50 字；
        <b>已存在 / 不存在的词不会被静默忽略</b>，会作为「跳过」连原因一起列出来。
        门槛与改规则一致（本群群管理员 130；全局要平台超管 240）。
      </p>
      <p v-if="keywords.length === 0" class="hint">（未配置）</p>
      <ul v-else class="chips">
        <li v-for="word in keywords" :key="word" class="chip-with-action">
          <code>{{ word }}</code>
          <!-- 单个词直接删：删不存在的词后端会如实报「不存在」，不会假装成功 -->
          <button
            type="button"
            class="chip"
            :disabled="keywordBusy || !canEditKeywords"
            :title="canEditKeywords ? `删除关键词「${word}」` : keywordDisabledReason"
            @click="removeKeyword(word)"
          >
            删
          </button>
        </li>
      </ul>

      <div class="toolbar">
        <input
          v-model="keywordInput"
          type="text"
          placeholder="加词：一个或多个（逗号 / 顿号 / 空格分隔）"
          :disabled="keywordBusy || !canEditKeywords"
        />
        <button
          type="button"
          :disabled="keywordBusy || !canEditKeywords || splitWords(keywordInput).length === 0"
          :title="
            !canEditKeywords
              ? keywordDisabledReason
              : splitWords(keywordInput).length === 0
                ? '先填要加的词（可用逗号 / 顿号 / 空格分隔多个）'
                : '加词（可批量）'
          "
          @click="addKeywords"
        >
          加词
        </button>
      </div>
      <p v-if="!canEditKeywords" class="hint">{{ keywordDisabledReason }}；服务端仍会再判一次权限。</p>
      <p v-if="keywordResult" class="ok">
        {{ keywordResult.message }}
        <span v-if="keywordResult.skipped.length > 0" class="error">
          · 跳过 {{ keywordResult.skipped.length }} 个（{{ skipText(keywordResult.skipped) }}）
        </span>
      </p>

      <h2 class="section-title">恢复继承</h2>
      <p class="hint">
        「恢复继承」= 删掉本{{ isGlobal ? "全局" : "群" }}的覆盖，让字段回落到<b>全局默认</b>。
        字段级只清下面列出的字段；整群那条会清空<b>全部</b>覆盖，<b>不可逆</b>。
      </p>
      <div class="toolbar">
        <button
          type="button"
          :disabled="
            resetBusy || !canEditKeywords || currentOverridden.length === 0
          "
          :title="
            !canEditKeywords
              ? keywordDisabledReason
              : currentOverridden.length === 0
                ? '没有覆盖字段可恢复：这个群全部继承默认值'
                : `把 ${currentOverridden.length} 个已覆盖字段恢复成全局默认`
          "
          @click="resetFieldConfirming = true"
        >
          恢复字段继承
        </button>
        <button
          type="button"
          class="danger"
          :disabled="resetAllBusy || !canEditKeywords"
          :title="
            canEditKeywords
              ? '清空本群全部覆盖（不可逆，提交前二次确认）'
              : keywordDisabledReason
          "
          @click="resettingAll = true"
        >
          恢复全部继承
        </button>
      </div>

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

    <!-- 一次改多项：确认框里逐项列 diff（与审计同一份口径） -->
    <ModalDialog
      :open="batchConfirming"
      title="确认一次改多项？"
      :busy="batchBusy"
      confirm-text="确认提交多项"
      @close="batchConfirming = false"
      @confirm="confirmBatch"
    >
      <p class="hint">
        共 {{ pendingChanges.length }} 项：服务端会<b>先全部校验、再落库</b>，
        有一项不合法就整体拒绝（不会改一半）。
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>字段</th>
            <th>旧值</th>
            <th>新值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pendingChanges" :key="item.field">
            <td><code>{{ item.field }}</code></td>
            <td class="reason">{{ pendingDiff(item).before }}</td>
            <td class="reason">{{ pendingDiff(item).after }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        {{ currentGroupName }} · 提交后写一条 <code>admin_api:rule_update</code> 审计
        （理由里带每个字段的旧值 → 新值）。
      </p>
    </ModalDialog>

    <!-- 恢复字段继承：把要清的字段名单列出来，避免误点 -->
    <ModalDialog
      :open="resetFieldConfirming"
      title="恢复字段继承？"
      :busy="resetBusy"
      confirm-text="确认恢复"
      @close="resetFieldConfirming = false"
      @confirm="confirmResetFields"
    >
      <p class="hint">
        {{ currentGroupName }} · 将要清掉这些字段的覆盖：
        <code>{{ currentOverridden.join("、") || "—" }}</code>
      </p>
      <p class="hint">
        清掉后它们回落到<b>全局默认</b>；这是<b>不可逆</b>的（要改回来自定义值只能再写一次）。
        机器人侧的指令层同样有字段级恢复。
      </p>
    </ModalDialog>

    <!-- 恢复全部继承：清空该群所有覆盖，危险动作必须写清后果 -->
    <ModalDialog
      :open="resettingAll"
      title="恢复全部继承？"
      danger
      :busy="resetAllBusy"
      confirm-text="不可逆：确认清空"
      @close="resettingAll = false"
      @confirm="confirmResetAll"
    >
      <p class="hint">
        {{ currentGroupName }} · <b>不可逆</b>：清空本{{ isGlobal ? "全局" : "群" }}全部覆盖，
        所有字段回落到全局默认。
      </p>
      <p v-if="isGlobal" class="hint">
        全局规则会回到种子默认值，所有没有自己覆盖的群都会立刻跟着变。
      </p>
      <p v-else class="hint">
        当前有 {{ currentOverridden.length }} 个字段在覆盖
        {{ currentOverridden.length > 0 ? `（${currentOverridden.join("、")}）` : "" }}，
        清空后需要重新配置才能恢复。
      </p>
    </ModalDialog>
  </section>
</template>
