<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiEnvItem,
  type AdminApiSettingItem,
  type AdminApiSettingsView,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import { useSessionStore } from "@/stores/session";

/**
 * 配置页（E2-f）：**可改的只有既有的热改项**（机器人 `/config` 用的同一套存储，
 * 改完立即生效并写审计）；`.env` 里留守的**核心项**只读展示（ADR-0066 之后热改项不再从
 * `.env` 读，所以它只出现在「可改项」那段，不会两段同时出现）。
 *
 * 密钥类（`*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_KEY`）服务端**不回传值**，
 * 这里只显示「已配置 / 未配置」—— 把线上密钥送进浏览器没有任何好处。
 *
 * 平台级配置，服务端要**平台超管 240**，所以非超管连请求都不发。
 */
const session = useSessionStore();
const view = ref<AdminApiSettingsView | null>(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");
/** 正在编辑的项（key）与它当前的输入值。 */
const editingKey = ref("");
const draft = ref("");
const saving = ref(false);

const allowed = computed(() => session.isSuperAdmin);
const envItems = computed(() => view.value?.env ?? []);

async function load(): Promise<void> {
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    view.value = await adminApi.settings();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function startEdit(item: AdminApiSettingItem): void {
  editingKey.value = item.key;
  draft.value = String(item.value);
  notice.value = "";
  error.value = "";
}

function cancelEdit(): void {
  editingKey.value = "";
  draft.value = "";
}

async function save(item: AdminApiSettingItem): Promise<void> {
  saving.value = true;
  try {
    const result = await adminApi.updateSetting(item.key, draft.value);
    applyItem(result.setting);
    notice.value = `${item.label} 已生效：${result.setting.display}`;
    cancelEdit();
  } catch (err) {
    // 校验失败（400）的中文原因直接给用户看：后端就是按展示文案写的
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function reset(item: AdminApiSettingItem): Promise<void> {
  saving.value = true;
  try {
    const result = await adminApi.clearSetting(item.key);
    applyItem(result.setting);
    notice.value = resetNotice(item, result.setting.display);
    cancelEdit();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

/** 就地替换一项（避免整页重新拉取导致编辑状态丢失）。 */
function applyItem(updated: AdminApiSettingItem): void {
  if (!view.value) {
    return;
  }
  view.value = {
    ...view.value,
    settings: view.value.settings.map((item) =>
      item.key === updated.key ? updated : item,
    ),
  };
}

function sourceLabel(item: AdminApiSettingItem): string {
  if (item.source === "override") {
    return "后台 / /config 覆盖";
  }
  return item.envBacked ? ".env 默认" : "内置默认";
}

/** 「恢复默认」的提示：说清会回到哪里（`.env` 值还是代码内置值）。 */
function defaultHint(item: AdminApiSettingItem): string {
  return item.envBacked ? "改回 .env 里的值" : "改回代码内置默认值";
}

/** 恢复成功后的提示语（同上一行口径）。 */
function resetNotice(item: AdminApiSettingItem, display: string): string {
  return `${item.label} 已恢复${item.envBacked ? " .env 默认值" : "内置默认值"}：${display}`;
}

function boolValue(item: AdminApiSettingItem): boolean {
  return item.value === true;
}

function envDisplay(item: AdminApiEnvItem): string {
  if (item.secret) {
    return item.configured ? "已配置（不回显）" : "未配置";
  }
  return item.configured ? (item.value ?? "") : "未配置";
}
</script>

<template>
  <section class="card">
    <h1>配置</h1>

    <p v-if="!allowed" class="hint">
      需要平台超级管理员（240）才能查看与修改配置。
    </p>
    <template v-else>
      <p class="hint">
        这里能改的是<b>热改项</b>（与机器人 <code>/config</code> 同一套存储）：改完<b>立即生效</b>并写审计。
        它们都<b>存在库里</b>：<code>.env</code> 里的同名行只在启动时导入一次，之后改文件不再有任何影响
        （「来源」列写「内置默认」的项，默认值就在代码里）。下面一段是真正还留在
        <code>.env</code> 里的核心项，只读展示（密钥类不回传值，改它们要登服务器改文件后重启）。
      </p>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="notice" class="ok">{{ notice }}</p>

      <template v-if="view">
        <h2 class="section-title">可改的运行时配置</h2>
        <table class="table">
          <thead>
            <tr>
              <th>配置项</th>
              <th>当前值</th>
              <th>来源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in view.settings" :key="item.key">
              <td>
                <div class="row-title">{{ item.label }}</div>
                <div class="hint"><code>{{ item.envKey }}</code><template v-if="item.unit"> · {{ item.unit }}</template></div>
              </td>
              <td>
                <template v-if="editingKey === item.key">
                  <select v-if="typeof item.value === 'boolean'" v-model="draft">
                    <option value="true">开</option>
                    <option value="false">关</option>
                  </select>
                  <input v-else v-model="draft" type="text" @keyup.enter="save(item)" />
                </template>
                <template v-else>
                  {{ item.display }}
                  <span v-if="typeof item.value === 'boolean'" class="hint">
                    （{{ boolValue(item) ? "开" : "关" }}）
                  </span>
                </template>
              </td>
              <td class="hint">{{ sourceLabel(item) }}</td>
              <td class="row-actions">
                <template v-if="editingKey === item.key">
                  <button type="button" :disabled="saving" @click="save(item)">保存</button>
                  <button type="button" class="link" @click="cancelEdit">取消</button>
                </template>
                <template v-else>
                  <button type="button" class="link" @click="startEdit(item)">修改</button>
                  <button
                    type="button"
                    class="link"
                    :disabled="saving || item.source === 'env'"
                    :title="item.source === 'env' ? (item.envBacked ? '当前就是 .env 默认值' : '当前就是内置默认值') : defaultHint(item)"
                    @click="reset(item)"
                  >
                    恢复默认
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <h2 class="section-title">.env 只读项</h2>
        <p class="hint">
          这些项在 <code>.env</code>（线上是 <code>data/.env</code>）里，改完要重启进程；
          密钥类只显示有没有配。
        </p>
        <table class="table">
          <thead>
            <tr>
              <th>键</th>
              <th>说明</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in envItems" :key="item.key">
              <td><code>{{ item.key }}</code></td>
              <td>{{ item.label }}</td>
              <td :class="{ hint: !item.configured }">{{ envDisplay(item) }}</td>
            </tr>
          </tbody>
        </table>

        <template v-if="view.issues.length > 0">
          <h2 class="section-title">加载期问题</h2>
          <ul class="list">
            <li v-for="issue in view.issues" :key="issue" class="error">{{ issue }}</li>
          </ul>
        </template>

        <button type="button" class="link" :disabled="loading" @click="load">
          刷新
        </button>
      </template>
    </template>
  </section>
</template>
