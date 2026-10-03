<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiNotifySubscriptionItem,
  type AdminApiNotifyTopic,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { useSessionStore } from "@/stores/session";

/**
 * 通知（P2 + 收尾批次）：话题门槛 + 测试推送 + **订阅关系只读**。
 *
 * 四条口径（与指令层 `/notify` 一致）：
 * - **门槛是全局一套**（`__default__.notifyTopicLevels`），改一次所有群生效，所以只有平台超管
 *   （240）能改 —— 服务端也会再判一次；
 * - 数值：`-1` = 不限 · `110` 群成员 / `120` 审核员 / `130` 群管理员 / `140` 本群超管 ·
 *   `210`–`240` 平台档（机器人卡片里的说明与这里同一份口径）；合法性由服务端判（同一套错误文案）；
 * - **订阅是个人偏好**（每人订哪些话题、按群还是全部群），仍在机器人里用 `/notify` 改；
 *   后台给「订了多少人」的计数，外加一张**只读**的订阅关系表（谁订了什么、现在够不够门槛）；
 * - 「订阅了却收不到」= 角色掉到门槛以下（活动通知的「全部群」还要求先绑 QQ 号）——
 *   判据与推送**同一份**（`checkTopicReach`），所以这一页能直接回答「我说了怎么没通知」。
 */
const session = useSessionStore();

const topics = ref<AdminApiNotifyTopic[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const testing = ref(false);
const saving = ref(false);
/** 正在编辑的话题与输入值（还没提交）。 */
const editing = ref<{ topic: string; level: string } | null>(null);
/** 待确认的改动（弹窗期间保持，确认后才发请求）。 */
const pendingChange = ref<{ topic: string; level: string } | null>(null);
/** 「恢复默认门槛」的确认弹窗。 */
const confirmingReset = ref(false);

// —— 订阅关系（只读，平台超管 240）：回答「我说了怎么没通知」的另一半
const subscriptions = ref<AdminApiNotifySubscriptionItem[]>([]);
const subsTotal = ref(0);
const subsPage = ref(1);
const subsPageSize = 20;
/** 筛选：话题（空 = 全部）+ 「只看收不到的」。 */
const subsTopic = ref("");
const subsIneligibleOnly = ref(false);
const subsError = ref("");

const allowed = computed(() => session.isSuperAdmin);

/** 门槛数值的人话（与机器人 `/notify level` 的展示一致）。 */
function levelLabel(level: number): string {
  if (level <= 0) {
    return "不限";
  }
  const groupAxis: Record<number, string> = {
    110: "群成员",
    120: "审核员",
    130: "群管理员",
    140: "本群超管",
  };
  const named = groupAxis[level];
  if (named !== undefined) {
    return `${level}（${named}）`;
  }
  if (level >= 210 && level <= 240) {
    return `${level}（平台档）`;
  }
  return String(level);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    topics.value = await adminApi.notifyTopics();
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/**
 * 订阅关系（只读，平台超管 240）：服务端回全量、这里分页。
 *
 * 非超管**连请求都不发**（服务端也会 403）：订阅是别人的个人偏好。
 */
async function loadSubscriptions(page: number): Promise<void> {
  if (!allowed.value) {
    return;
  }
  try {
    const view = await adminApi.notifySubscriptions({
      ...(subsTopic.value.length > 0 ? { topic: subsTopic.value } : {}),
      ...(subsIneligibleOnly.value ? { ineligible: true } : {}),
      page,
      pageSize: subsPageSize,
    });
    subscriptions.value = view.items;
    subsTotal.value = view.total;
    subsPage.value = view.page;
    subsError.value = "";
  } catch (err) {
    subsError.value = err instanceof ApiError ? err.message : String(err);
  }
}

/** 改筛选条件：回第 1 页重查（否则页码可能越界）。 */
async function applySubsFilter(): Promise<void> {
  await loadSubscriptions(1);
}

onMounted(async () => {
  await load();
  await loadSubscriptions(1);
});

function startEdit(topic: AdminApiNotifyTopic): void {
  editing.value = { topic: topic.topic, level: String(topic.level) };
  notice.value = "";
  error.value = "";
}

function cancelEdit(): void {
  editing.value = null;
}

/** 点「保存」先弹二次确认：门槛改完全群立即生效，值得停一下。 */
function askSave(): void {
  if (!editing.value) {
    return;
  }
  pendingChange.value = { ...editing.value };
}

async function save(): Promise<void> {
  const change = pendingChange.value;
  if (!change) {
    return;
  }
  const level = Number.parseInt(change.level.trim(), 10);
  if (Number.isNaN(level)) {
    error.value = "门槛要写整数（-1 = 不限、110–140 群内档、210–240 平台档）。";
    pendingChange.value = null;
    return;
  }
  saving.value = true;
  try {
    const result = await adminApi.setNotifyLevel(change.topic, level);
    topics.value = result.topics;
    notice.value = result.message;
    error.value = "";
    editing.value = null;
    pendingChange.value = null;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
    pendingChange.value = null;
  } finally {
    saving.value = false;
  }
}

async function resetLevels(): Promise<void> {
  saving.value = true;
  try {
    const result = await adminApi.resetNotifyLevels();
    topics.value = result.topics;
    notice.value = result.message;
    error.value = "";
    editing.value = null;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
    confirmingReset.value = false;
  }
}

/** 测试卡只发给自己：测的是私聊通道，不打扰任何人。 */
async function sendTest(): Promise<void> {
  testing.value = true;
  try {
    const response = await adminApi.sendNotifyTest();
    if (response.result.ok) {
      notice.value = response.result.message;
      error.value = "";
    } else {
      error.value = response.result.message;
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h1>通知</h1>

    <p class="hint">
      话题门槛是<b>全局一套</b>（改一次所有群生效），只有平台超管能改；
      <b>订阅</b>是每个人自己的偏好，请在机器人里用 <code>/notify</code> 改 ——
      后台只<b>看</b>订阅关系（下面那张只读表）与「订了多少人」的计数，不替别人改。
      推送为什么没到？先看下面「已订阅但收不到」的人，再看「投递」页的失败原因。
    </p>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>

    <p v-if="!loading && topics.length === 0 && !error" class="hint">
      没有可展示的话题（推送服务可能未启用）。
    </p>

    <table v-if="topics.length > 0" class="table">
      <thead>
        <tr>
          <th>话题</th>
          <th>当前门槛</th>
          <th>默认门槛</th>
          <th>订阅</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="topic in topics" :key="topic.topic">
          <td>
            <div class="row-title">{{ topic.label }}</div>
            <div class="hint">{{ topic.hint }}</div>
          </td>
          <td>
            <input
              v-if="editing?.topic === topic.topic"
              v-model="editing.level"
              type="text"
              size="6"
            />
            <template v-else>{{ levelLabel(topic.level) }}</template>
          </td>
          <td class="hint">{{ levelLabel(topic.defaultLevel) }}</td>
          <td class="hint">
            全部群 {{ topic.allScope }} 人 · 按群 {{ topic.groupScopes }} 条
          </td>
          <td class="row-actions">
            <template v-if="!allowed">
              <span class="hint">需要平台超管（240）</span>
            </template>
            <template v-else-if="editing?.topic === topic.topic">
              <button type="button" :disabled="saving" @click="askSave">
                保存
              </button>
              <button type="button" class="link" @click="cancelEdit">取消</button>
            </template>
            <template v-else>
              <button type="button" class="link" @click="startEdit(topic)">
                改门槛
              </button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="editing" class="hint">
      数值：<code>-1</code> = 不限 · <code>110</code> 群成员 · <code>120</code> 审核员 ·
      <code>130</code> 群管理员 · <code>140</code> 本群超管 · <code>210</code>–<code>240</code> 平台档。
    </p>

    <div class="toolbar">
      <button
        type="button"
        class="link"
        :disabled="testing"
        title="只发给你自己：测私聊推送通道是否通"
        @click="sendTest"
      >
        {{ testing ? "发送中…" : "给我发一张测试卡" }}
      </button>
      <button
        v-if="allowed"
        type="button"
        class="link"
        :disabled="saving || loading"
        title="所有话题门槛恢复默认值"
        @click="confirmingReset = true"
      >
        恢复默认门槛
      </button>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
    </div>

    <!-- 订阅关系（只读）：回答「我说了怎么没通知」的另一半 -->
    <template v-if="allowed">
      <h2 class="section-title">订阅关系（只读）</h2>
      <p class="hint">
        订阅是每个人的偏好，后台<b>只看不改</b>（改仍在机器人里用 <code>/notify</code>）。
        状态「收不到」= 订阅还在，但按<b>现在的门槛</b>他不够格（角色掉了，或活动通知订「全部群」
        却没绑 QQ 号）—— 推送会跳过这些人，这正是「说好要通知我怎么没收到」最常见的原因。
      </p>

      <div class="toolbar">
        <label>
          话题
          <select id="subs-topic" v-model="subsTopic" @change="applySubsFilter">
            <option value="">全部</option>
            <option v-for="topic in topics" :key="topic.topic" :value="topic.topic">
              {{ topic.label }}
            </option>
          </select>
        </label>
        <label>
          <input
            id="subs-ineligible"
            v-model="subsIneligibleOnly"
            type="checkbox"
            @change="applySubsFilter"
          />
          只看收不到的
        </label>
        <span v-if="subsTotal > 0" class="hint">共 {{ subsTotal }} 行</span>
      </div>

      <p v-if="subsError" class="error">{{ subsError }}</p>
      <p v-else-if="subscriptions.length === 0" class="hint">没有符合条件的订阅行。</p>
      <table v-else id="notify-subscriptions" class="table">
        <thead>
          <tr>
            <th>成员</th>
            <th>话题</th>
            <th>订阅范围</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in subscriptions"
            :key="`${row.topic}|${row.userId}|${row.scope}`"
          >
            <td><EntityLabel :entity="row.user" :fallback="row.userId" /></td>
            <td>{{ row.topicLabel }}</td>
            <td>
              <template v-if="row.scope === 'all'">
                全部群（他担任审核员的群）
              </template>
              <EntityLabel
                v-else-if="row.group"
                :entity="row.group"
                :fallback="row.groupId ?? ''"
              />
              <span v-else class="hint">—</span>
            </td>
            <td>
              <span v-if="row.eligible">可收到</span>
              <span v-else class="error">收不到：{{ row.reason }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="subsTotal > subsPageSize" class="toolbar">
        <button
          type="button"
          class="link"
          :disabled="subsPage <= 1"
          @click="loadSubscriptions(subsPage - 1)"
        >
          上一页
        </button>
        <span class="hint">第 {{ subsPage }} 页</span>
        <button
          type="button"
          class="link"
          :disabled="subsPage * subsPageSize >= subsTotal"
          @click="loadSubscriptions(subsPage + 1)"
        >
          下一页
        </button>
      </div>
    </template>

    <!-- 改门槛的二次确认：改完全群立即生效，值得停一下 -->
    <ModalDialog
      :open="pendingChange !== null"
      title="确认改门槛？"
      confirm-text="确认修改"
      :busy="saving"
      @confirm="save"
      @close="pendingChange = null"
    >
      <p>
        话题门槛是<b>全局一套</b>：改完<b>所有群立即生效</b>，从下一条通知起按新门槛决定谁收得到。
      </p>
      <p v-if="pendingChange" class="hint">
        <code>{{ pendingChange.topic }}</code> →
        <code>{{ pendingChange.level }}</code>
      </p>
    </ModalDialog>

    <!-- 恢复默认：一次改回全部话题，同样要确认 -->
    <ModalDialog
      :open="confirmingReset"
      title="恢复默认门槛？"
      confirm-text="确认恢复"
      :busy="saving"
      @confirm="resetLevels"
      @close="confirmingReset = false"
    >
      <p>
        会把<b>所有话题</b>的门槛改回 <code>.env</code> 里的默认值（也就是「默认门槛」那一列），
        同样立即对全局生效。
      </p>
    </ModalDialog>
  </section>
</template>
