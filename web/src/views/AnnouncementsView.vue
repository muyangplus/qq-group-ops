<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiAnnouncementInput,
  type AdminApiAnnouncementItem,
  type AdminApiAnnouncementsView,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { GROUP_ADMIN_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 定时发言（TODO §2 的 P0；口径见 docs/DECISIONS.md 的 ADR-0062）。
 *
 * 三条要点：
 * - **默认关闭**：新建出来的任务是停用状态，要显式「启用」才会发；平台上还有一层总开关；
 * - **时间表是标准 cron 5 段**（本地时区），列表与表单都会回**后五次执行时间**，
 *   写错的话（段数不对 / 越界 / 2 月 30 日这种永不触发）当场就能看出来；
 * - 形态：`text` 走纯文本通道（能 @ 人），`card` 才支持**引用块与按钮**；
 *   按钮点击后等于发送对应指令，与手输走同一条权限路径。
 *
 * 写操作与群里 `/announce` 是**同一个领域服务**：校验、落库、发送、审计都同一份。
 */
const session = useSessionStore();

const view = ref<AdminApiAnnouncementsView | null>(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const busy = ref(false);

const manageableGroups = computed(() =>
  (session.identity?.permissions?.groups ?? [])
    .map((group) => group.groupId)
    .filter((groupId) => session.levelIn(groupId) >= GROUP_ADMIN_LEVEL),
);

const groupFilter = ref(firstManageableGroup());

function firstManageableGroup(): string {
  return (
    (session.identity?.permissions?.groups ?? [])
      .map((group) => group.groupId)
      .find((groupId) => session.levelIn(groupId) >= GROUP_ADMIN_LEVEL) ?? ""
  );
}

/** 表单状态：`editingId` 有值 = 在改这一条（否则是新建）。 */
const editingId = ref("");
const cron = ref("");
const mode = ref<"text" | "card">("text");
const title = ref("");
const text = ref("");
const quote = ref("");
const reference = ref(false);
/** 按钮每行一个：`按钮文字 指令`（最多 5 个）。 */
const buttonsText = ref("");

const deleteTarget = ref<AdminApiAnnouncementItem | null>(null);
const sendTarget = ref<AdminApiAnnouncementItem | null>(null);
/**
 * 详情用**弹窗**而不是行内折叠（`<details>`）：折叠区在表格单元格里展开时，
 * 会把那一列的宽度顶开、整行跟着重排，页面看起来就「错乱」了
 * （真机反馈）。弹窗不参与表格布局，长 id 也不会撑破列宽。
 */
const detailTarget = ref<AdminApiAnnouncementItem | null>(null);

async function load(): Promise<void> {
  if (groupFilter.value.length === 0) {
    view.value = null;
    error.value = "你名下没有达到群管理员（130）的群，配不了定时发言。";
    return;
  }
  loading.value = true;
  try {
    view.value = await adminApi.announcements(groupFilter.value);
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function switchGroup(): void {
  resetForm();
  notice.value = "";
  void load();
}

/** 把一行写成 `文字 指令` 的按钮解析成 API 需要的形状（空行忽略）。 */
function parseButtons(): Array<{ label: string; command: string }> | string {
  const buttons: Array<{ label: string; command: string }> = [];
  for (const raw of buttonsText.value.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const separator = line.search(/\s/u);
    if (separator < 0) {
      return `按钮要写成「按钮文字 指令」，例如：查看 /activity（第 ${buttons.length + 1} 行）`;
    }
    const label = line.slice(0, separator).trim();
    const command = line.slice(separator).trim();
    if (label.length === 0 || command.length === 0) {
      return "按钮的「文字」和「指令」都不能为空。";
    }
    buttons.push({ label, command });
  }
  if (buttons.length > 5) {
    return "按钮最多 5 个（卡片一行放不下更多了）。";
  }
  return buttons;
}

function formInput(): AdminApiAnnouncementInput | string {
  const buttons = parseButtons();
  if (typeof buttons === "string") {
    return buttons;
  }
  return {
    mode: mode.value,
    ...(title.value.trim().length > 0 ? { title: title.value.trim() } : {}),
    text: text.value,
    ...(quote.value.trim().length > 0 ? { quote: quote.value.trim() } : {}),
    reference: reference.value,
    buttons,
  };
}

async function submit(): Promise<void> {
  const content = formInput();
  if (typeof content === "string") {
    notice.value = content;
    return;
  }
  if (cron.value.trim().length === 0) {
    notice.value = "时间表要写标准 cron 5 段，例如：0 9 * * *";
    return;
  }
  busy.value = true;
  try {
    const result =
      editingId.value.length > 0
        ? await adminApi.updateAnnouncement(editingId.value, {
            ...content,
            cron: cron.value.trim(),
          })
        : await adminApi.createAnnouncement(
            groupFilter.value,
            cron.value.trim(),
            content,
          );
    view.value = result.announcements;
    notice.value = result.message;
    resetForm();
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function resetForm(): void {
  editingId.value = "";
  cron.value = "";
  mode.value = "text";
  title.value = "";
  text.value = "";
  quote.value = "";
  reference.value = false;
  buttonsText.value = "";
}

function startEdit(item: AdminApiAnnouncementItem): void {
  editingId.value = item.id;
  cron.value = item.cron;
  mode.value = item.mode;
  title.value = item.title;
  text.value = item.text;
  quote.value = item.quote ?? "";
  reference.value = item.reference;
  buttonsText.value = item.buttons
    .map((button) => `${button.label} ${button.command}`)
    .join("\n");
  notice.value = `正在修改 #${indexOf(item)}：改完点「保存修改」。`;
}

function indexOf(item: AdminApiAnnouncementItem): number {
  return (view.value?.items ?? []).findIndex((row) => row.id === item.id) + 1;
}

async function toggle(item: AdminApiAnnouncementItem): Promise<void> {
  busy.value = true;
  try {
    const result = await adminApi.updateAnnouncement(item.id, {
      enabled: !item.enabled,
    });
    view.value = result.announcements;
    notice.value = result.message;
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function confirmRemove(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) {
    return;
  }
  busy.value = true;
  try {
    const result = await adminApi.removeAnnouncement(target.id);
    view.value = result.announcements;
    notice.value = result.message;
    if (editingId.value === target.id) {
      resetForm();
    }
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
    deleteTarget.value = null;
  }
}

async function confirmSend(): Promise<void> {
  const target = sendTarget.value;
  if (!target) {
    return;
  }
  busy.value = true;
  try {
    const result = await adminApi.sendAnnouncement(target.id);
    notice.value = result.message;
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
    sendTarget.value = null;
  }
}

function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

function nextTimesText(item: AdminApiAnnouncementItem): string {
  if (item.cronError !== undefined) {
    return `cron 有问题：${item.cronError}`;
  }
  return item.nextTimes.length > 0
    ? item.nextTimes.join("、")
    : "算不出来（这个 cron 的日期组合不存在，例如 2 月 30 日）";
}

function shapeOf(item: AdminApiAnnouncementItem): string {
  const parts = [item.mode === "card" ? "卡片" : "纯文本"];
  if (item.quote !== undefined) {
    parts.push("引用块");
  }
  if (item.buttons.length > 0) {
    parts.push(`${item.buttons.length} 个按钮`);
  }
  if (item.reference) {
    parts.push("引用回复");
  }
  return parts.join(" + ");
}
</script>

<template>
  <section class="card">
    <h1>定时发言</h1>
    <p class="hint">
      机器人按 cron 在本群定时发言（<b>默认关闭</b>：新建出来是停用状态，要显式「启用」）。
      时间表是标准 5 段 <code>分 时 日 月 周</code>（本地时区），支持 <code>*</code>、
      区间 <code>1-5</code>、步长 <code>0-59/10</code>、列表 <code>8,20</code>；
      表格里会给<b>后五次执行时间</b>，写错了一眼就能看出来。形态选「卡片」时可以用引用块与按钮，
      按钮点击后等于发送对应指令（与手输同一条权限路径）。同一任务同一分钟只发一次，
      重启不重发、错过的时间点也不补发；发送失败只私信配置者，群里不留痕迹。
    </p>

    <div class="toolbar">
      <label for="announcement-group">群</label>
      <select id="announcement-group" v-model="groupFilter" @change="switchGroup">
        <option v-for="groupId in manageableGroups" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">刷新</button>
      <span v-if="view" class="hint">共 {{ view.total }} 条</span>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" id="announcement-notice" class="hint">{{ notice }}</p>
    <p v-if="view && !view.enabled" id="announcement-switch-off" class="warning">
      平台总开关（配置页「定时发言总开关」，或 <code>.env</code> 的
      <code>SCHEDULED_ANNOUNCE_ENABLED</code>）现在是<b>关</b>的：下面这些任务都不会触发。
    </p>
    <p v-if="view" class="hint">
      每群每小时最多 {{ view.hourlyLimit === 0 ? "不限" : `${view.hourlyLimit} 条` }}
      （防手滑把 cron 写成 <code>* * * * *</code>）。
    </p>

    <template v-if="view">
      <p v-if="view.items.length === 0" class="hint">
        这个群还没有定时发言，用下面的表单新建一条。
      </p>
      <table v-else id="announcement-list" class="table">
        <thead>
          <tr>
            <th>#</th>
            <th>状态</th>
            <th>时间表</th>
            <th>形态</th>
            <th>内容</th>
            <th>后五次执行时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in view.items" :key="item.id">
            <td>{{ index + 1 }}</td>
            <td>
              <span v-if="item.enabled" class="badge">已启用</span>
              <span v-else class="badge muted">已停用</span>
              <div v-if="item.lastFiredAt" class="hint">
                上次：{{ item.lastFiredAt }}
              </div>
            </td>
            <td class="nowrap">
              <code>{{ item.cron }}</code>
              <div v-if="item.cronError" class="error">{{ item.cronError }}</div>
            </td>
            <td>{{ shapeOf(item) }}</td>
            <td>
              <div class="nowrap">
                <b v-if="item.mode === 'card'">{{ item.title }}</b>
              </div>
              <div>{{ item.text }}</div>
               <div v-if="item.quote" class="hint">引用块：{{ item.quote }}</div>
              <div v-if="item.buttons.length > 0" class="hint">
                按钮：{{ item.buttons.map((button) => button.label).join("、") }}
              </div>
              <div class="hint">
                配置者：<EntityLabel :entity="item.createdBy" :fallback="item.createdBy.officialId" />
              </div>
            </td>
            <td>{{ nextTimesText(item) }}</td>
            <td class="nowrap">
              <button type="button" class="link" :disabled="busy" @click="toggle(item)">
                {{ item.enabled ? "停用" : "启用" }}
              </button>
              <button type="button" class="link" :disabled="busy" @click="startEdit(item)">
                编辑
              </button>
              <button type="button" class="link" :disabled="busy" @click="sendTarget = item">
                试发
              </button>
              <button
                type="button"
                class="link danger"
                :disabled="busy"
                @click="deleteTarget = item"
              >
                删除
              </button>
              <button type="button" class="link" @click="detailTarget = item">
                详情
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">
        {{ editingId.length > 0 ? "修改这一条" : "新建一条" }}
      </div>
      <form id="announcement-form" class="form" @submit.prevent="submit">
        <label for="announcement-cron">时间表（cron 5 段）</label>
        <input id="announcement-cron" v-model="cron" placeholder="0 9 * * * " />

        <label for="announcement-mode">形态</label>
        <select id="announcement-mode" v-model="mode">
          <option value="text">纯文本（能 @ 人）</option>
          <option value="card">卡片（可用引用块与按钮）</option>
        </select>

        <label for="announcement-title">卡片标题</label>
        <input id="announcement-title" v-model="title" placeholder="作业提醒" />

        <label for="announcement-text">正文</label>
        <textarea id="announcement-text" v-model="text" rows="3" />

        <label for="announcement-quote">引用块（只对卡片形态有效）</label>
        <textarea id="announcement-quote" v-model="quote" rows="2" />

        <label for="announcement-buttons">按钮（每行一个：<code>文字 指令</code>，最多 5 个）</label>
        <textarea
          id="announcement-buttons"
          v-model="buttonsText"
          rows="2"
          placeholder="查看 /activity"
        />

        <label class="checkbox">
          <input id="announcement-reference" v-model="reference" type="checkbox" />
          发送时引用回复上一条机器人消息（尽力而为：5 分钟内有才带得上）
        </label>

        <div class="actions">
          <button type="submit" :disabled="busy">
            {{ editingId.length > 0 ? "保存修改" : "新建（默认停用）" }}
          </button>
          <button v-if="editingId.length > 0" type="button" class="link" @click="resetForm">
            取消修改
          </button>
        </div>
      </form>
    </template>

    <ModalDialog
      :open="deleteTarget !== null"
      title="确认删除这条定时发言？"
      confirm-text="确认删除"
      danger
      :busy="busy"
      @close="deleteTarget = null"
      @confirm="confirmRemove"
    >
      <p>
        删除后不能再恢复：<code>{{ deleteTarget?.cron }}</code>
        {{ deleteTarget?.text }}
      </p>
    </ModalDialog>

    <ModalDialog
      :open="sendTarget !== null"
      title="确认现在试发一条？"
      confirm-text="确认试发"
      :busy="busy"
      @close="sendTarget = null"
      @confirm="confirmSend"
    >
      <p>
        这会在<b>群里真实发出</b>一条（不是预览），并且同样计入每小时上限。
        <template v-if="sendTarget && !sendTarget.enabled">
          这条任务本身还是停用状态，试发不会把它打开。
        </template>
      </p>
    </ModalDialog>

    <!-- 详情：完整 id / 内部任务 id 只在这里出现（正文只出群号 → 短码） -->
    <ModalDialog
      :open="detailTarget !== null"
      title="定时发言详情"
      confirm-text="关闭"
      @close="detailTarget = null"
      @confirm="detailTarget = null"
    >
      <dl v-if="detailTarget" class="facts">
        <dt>群</dt>
        <dd>{{ groupLabel(detailTarget.groupId) }}</dd>
        <dt>群 ID</dt>
        <dd>{{ detailTarget.groupId }}</dd>
        <dt>任务 ID</dt>
        <dd>{{ detailTarget.id }}</dd>
        <dt>时间表</dt>
        <dd>
          <code>{{ detailTarget.cron }}</code>
          <span v-if="detailTarget.cronError" class="error">
            {{ detailTarget.cronError }}
          </span>
        </dd>
        <dt>配置者</dt>
        <dd>{{ detailTarget.createdBy.officialId }}</dd>
        <dt>最后修改</dt>
        <dd>{{ detailTarget.updatedAt }}</dd>
        <dt>上次触发</dt>
        <dd>{{ detailTarget.lastFiredAt ?? "（还没触发过）" }}</dd>
      </dl>
    </ModalDialog>
  </section>
</template>

<style scoped>
.form {
  display: grid;
  gap: 0.4rem;
  max-width: 42rem;
}

.checkbox {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.badge.muted {
  opacity: 0.6;
}

.warning {
  color: #b45309;
}
</style>
