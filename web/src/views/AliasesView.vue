<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiAliasItem } from "@/api/admin";
import { ApiError } from "@/api/client";
import ModalDialog from "@/components/ModalDialog.vue";
import { useSessionStore } from "@/stores/session";

/**
 * 别名表（平台超管 240）。
 *
 * 别名 = 「习惯写法 → 班级库里的规范名」，用在两个地方：
 * - `/rules` 的班级 / 学院匹配（`joinRequireClass`、`allowColleges` / `denyColleges` 等）；
 * - `/profile` 解析（用户填的班级 / 学院先按别名展开，再拿规范名去班级库匹配）。
 *
 * 两条硬口径：
 * - **类型（班级 / 学院 / 专业）不需要人选**：服务端拿目标去班级库里查，命中什么就是什么；
 * - 写操作只给**平台超管 240**；非超管页面只显示一句说明、**连请求都不发**
 *   （照 `StatusView.vue` 的写法：服务端也会 403，前端不拿它当权限开关）。
 *
 * 「别名表为空」有两种常见原因，页面要一起说清：真的没配过，或者**班级库没加载**
 * （`data/class-index.json` 缺失 → 保存时报「班级库未加载」，要先在服务器跑 `pnpm class:index`）。
 */
const session = useSessionStore();

const allowed = computed(() => session.isSuperAdmin);

const aliases = ref<AdminApiAliasItem[]>([]);
const loading = ref(false);
const error = ref("");
/** 写操作回执（后端已经用「别名 X → Y（类型）」这种中文，直接显示）。 */
const notice = ref("");
/** 回执是成功还是失败：删除一个本来就不存在的别名时后端回 `ok=false`，别用绿色显示。 */
const noticeOk = ref(true);

/** 新增 / 覆盖表单；`overwriteConfirming` 只在「这个别名已经存在」时开二次确认。 */
const alias = ref("");
const target = ref("");
const submitting = ref(false);
const overwriteConfirming = ref(false);

/** 正在二次确认删除的那条（`null` = 没有弹窗）。 */
const removeTarget = ref<AdminApiAliasItem | null>(null);
const removeBusy = ref(false);

/** 类型码 → 人话；服务端将来加了新类型也不会显示成空白。 */
const KIND_LABELS: Record<string, string> = {
  class: "班级",
  college: "学院",
  major: "专业",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 别名是「忽略空白匹配」的（服务端 `compactText`），所以判重也按去空白后的写法比。 */
function compactText(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 表单里这个别名是否已经存在（存在 = 提交是「覆盖」，要二次确认）。 */
const existing = computed((): AdminApiAliasItem | null => {
  const key = compactText(alias.value.trim());
  if (key === "") {
    return null;
  }
  return aliases.value.find((entry) => compactText(entry.alias) === key) ?? null;
});

const canSubmit = computed(
  (): boolean =>
    alias.value.trim() !== "" &&
    target.value.trim() !== "" &&
    target.value.trim() !== alias.value.trim(),
);

async function load(): Promise<void> {
  // 非超管不发请求：这是平台级数据，服务端本来就只给 240
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    const response = await adminApi.aliases();
    aliases.value = response.aliases;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 提交前分流：新别名直接写，已存在的走「覆盖」二次确认（避免手滑改掉现有映射）。 */
function submit(): void {
  if (!canSubmit.value || submitting.value || !allowed.value) {
    return;
  }
  notice.value = "";
  if (existing.value) {
    overwriteConfirming.value = true;
    return;
  }
  void save();
}

/** 保存：成功后用返回的 `aliases` **整体替换**表格（不用再拉一次）。 */
async function save(): Promise<void> {
  submitting.value = true;
  try {
    const response = await adminApi.setAlias(alias.value.trim(), target.value.trim());
    notice.value = response.message;
    noticeOk.value = response.ok;
    aliases.value = response.aliases;
    error.value = "";
    overwriteConfirming.value = false;
    alias.value = "";
    target.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

function openRemove(entry: AdminApiAliasItem): void {
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
    const response = await adminApi.removeAlias(entry.alias);
    notice.value = response.message;
    noticeOk.value = response.ok;
    // 删除后不管有没有删掉（`ok=false` = 本来就不存在），都以后端返回的整表为准
    aliases.value = response.aliases;
    error.value = "";
    removeTarget.value = null;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    removeBusy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h1>别名</h1>

    <p v-if="!allowed" class="hint">需要平台超管（240）</p>
    <template v-else>
      <p class="hint">
        别名是「习惯写法 → 班级库里的规范名」，用在 <code>/rules</code> 的班级 / 学院匹配和
        <code>/profile</code> 解析里：用户填的别名会先展开成规范名，再拿去班级库匹配。
        匹配忽略空白差异、长别名优先；全局生效，重启不丢。
      </p>
      <p class="hint">
        <b>类型（班级 / 学院 / 专业）由服务端按班级库自动判定</b>，这里不用选；
        保存时目标必须是班级库里的班级 / 学院 / 专业，否则会被拒绝并说明原因。
        只有<b>平台超管（240）</b>能维护别名表（服务端也会再判一次权限）。
      </p>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-if="error" class="error">{{ error }}</p>
      <!-- `ok=false`（例如删一个本来就不存在的别名）按错误色显示，别当成成功 -->
      <p v-if="notice" :class="noticeOk ? 'ok' : 'error'">{{ notice }}</p>

      <h2 class="section-title">新增 / 覆盖</h2>
      <div class="toolbar">
        <input
          v-model="alias"
          type="text"
          maxlength="40"
          placeholder="别名（习惯写法）"
          :disabled="submitting"
        />
        <span class="hint">→</span>
        <input
          v-model="target"
          type="text"
          placeholder="规范名（班级库里的班级 / 学院 / 专业）"
          :disabled="submitting"
        />
        <button
          type="button"
          :disabled="!canSubmit || submitting"
          :title="
            !canSubmit
              ? '别名与规范名都要填，且不能完全相同'
              : existing
                ? `这个别名已存在，提交会覆盖成新目标`
                : '新增别名'
          "
          @click="submit"
        >
          {{ existing ? "覆盖" : "新增" }}
        </button>
        <span v-if="existing" class="badge">
          已存在：「{{ existing.alias }}」→「{{ existing.target }}」（{{
            kindLabel(existing.kind)
          }}），提交会覆盖
        </span>
      </div>

      <h2 class="section-title">别名表（{{ aliases.length }}）</h2>
      <!-- 空表有两种常见原因，一起说清，避免只看到「空的」不知道自己该做什么 -->
      <p v-if="aliases.length === 0 && !loading" class="hint">
        别名表为空（还没有配过别名）。
      </p>
      <table v-if="aliases.length > 0" class="table">
        <thead>
          <tr>
            <th>别名</th>
            <th>规范名</th>
            <th>类型</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in aliases" :key="entry.alias">
            <td><code>{{ entry.alias }}</code></td>
            <td>{{ entry.target }}</td>
            <td>
              <!-- 服务端给的是 `class` / `college` / `major`，这里翻成人话 -->
              {{ kindLabel(entry.kind) }}
            </td>
            <td>
              <button
                type="button"
                class="link"
                :disabled="removeBusy"
                title="删除这条别名（会二次确认）"
                @click="openRemove(entry)"
              >
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        如果保存时报「班级库未加载」，先在服务器执行 <code>pnpm class:index</code>
        生成 <code>data/class-index.json</code> 并重启机器人 —— 别名表的类型判定依赖班级库。
      </p>
    </template>

    <!-- 覆盖已有别名：说清楚旧的映射会被换掉 -->
    <ModalDialog
      :open="overwriteConfirming"
      title="覆盖已有别名？"
      :busy="submitting"
      confirm-text="确认覆盖"
      @close="overwriteConfirming = false"
      @confirm="save"
    >
      <p v-if="existing" class="hint">
        别名「{{ existing.alias }}」现在是 →「{{ existing.target }}」（{{
          kindLabel(existing.kind)
        }}），将改成 →「{{ target.trim() }}」。
      </p>
      <p class="hint">新目标的类型由服务端按班级库自动判定。</p>
    </ModalDialog>

    <!-- 删除：不可逆，二次确认 -->
    <ModalDialog
      :open="removeTarget !== null"
      title="删除别名？"
      danger
      :busy="removeBusy"
      confirm-text="确认删除"
      @close="removeTarget = null"
      @confirm="confirmRemove"
    >
      <template v-if="removeTarget">
        <p class="hint">
          将删除别名「{{ removeTarget.alias }}」→「{{ removeTarget.target }}」（{{
            kindLabel(removeTarget.kind)
          }}）。
        </p>
        <p class="hint">
          删掉后这个写法不再被展开，班级 / 学院匹配与 <code>/profile</code> 解析都会按原文处理。
        </p>
      </template>
    </ModalDialog>
  </section>
</template>
