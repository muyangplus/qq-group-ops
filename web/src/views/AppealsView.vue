<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiAppealItem } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 申诉队列（列表 + 复核）。
 *
 * 口径与 `/appeal list` 一致：平台超管 240 可以不选群看全量，
 * 其余人必须带本群审核员（120）的群；所以默认选中第一个够 120 的群。
 *
 * 复核（通过 / 驳回）与机器人里的 `/appeal` **同源**（同一个领域服务）：
 * 通过 = 撤销该处罚（逐项：解除禁言 / 解除拉黑等；撤回与移出群不可逆），
 * 两种结果都会私信申诉人。界面只按本群 120 禁用按钮，服务端仍会再判一次。
 */
const session = useSessionStore();

const items = ref<AdminApiAppealItem[]>([]);
const holdMinutes = ref(0);
const pendingCount = ref(0);
const groupFilter = ref("");
const statusFilter = ref("");
const loading = ref(false);
const error = ref("");
/** 复核成功回执（通过 / 驳回都走这里）。 */
const notice = ref("");

/** 通过 / 驳回各一个确认弹窗：驳回要填理由、通过不用，所以不共用状态。 */
const approveTarget = ref<AdminApiAppealItem | null>(null);
const rejectTarget = ref<AdminApiAppealItem | null>(null);
const rejectNote = ref("");
const busy = ref(false);

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);

/** 申诉状态的中文口径：'—' 只会在后端加了新状态时出现，不做静默兜底。 */
const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  accepted: "已通过",
  rejected: "已驳回",
};

/** 群下拉的**展示文本**；`option` 的 `value` 仍是内部 `groupId`（过滤器要发给后端）。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

/** 正文字段缺省时的兜底：空串给「—」，别让单元格看起来像坏了。 */
function orDash(value: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "—";
}

/**
 * 复核按钮的启用口径：本群审核员 120（平台超管的平台档会折算进 `levelIn`）。
 * 真正能不能干由服务端判（不满足 403），这里只避免点出一个注定失败的请求。
 */
function canReview(item: AdminApiAppealItem): boolean {
  return session.levelIn(item.groupId) >= MODERATOR_LEVEL;
}

async function load(): Promise<void> {
  // 非超管不选群会被服务端 400：先默认挑一个自己够 120 的群（跟审计页同一套）。
  if (!session.isSuperAdmin && groupFilter.value === "") {
    const first = groupOptions.value.find(
      (groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL,
    );
    if (first === undefined) {
      error.value = "你在任何群里都没有审核员（120）权限，看不到申诉队列。";
      items.value = [];
      pendingCount.value = 0;
      return;
    }
    groupFilter.value = first;
  }
  loading.value = true;
  try {
    const result = await adminApi.appeals({
      group: groupFilter.value || undefined,
      status: statusFilter.value || undefined,
    });
    items.value = result.items;
    holdMinutes.value = result.holdMinutes;
    pendingCount.value = result.pendingCount;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function reload(): Promise<void> {
  await load();
}

function openApprove(item: AdminApiAppealItem): void {
  notice.value = "";
  approveTarget.value = item;
}

function openReject(item: AdminApiAppealItem): void {
  notice.value = "";
  rejectNote.value = "";
  rejectTarget.value = item;
}

/** 通过 = 撤销该处罚；`load()` 用的还是当前 `status`，所以「只看待处理」的过滤会保持。 */
async function confirmApprove(): Promise<void> {
  const item = approveTarget.value;
  if (item === null) {
    return;
  }
  busy.value = true;
  try {
    const response = await adminApi.decideAppeal(item.code, "accept");
    notice.value = response.result.message;
    error.value = "";
    approveTarget.value = null;
    await load();
  } catch (err) {
    // 失败不关弹窗：错误留在页面上，用户可以直接重试或取消
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** 驳回理由可空：留空时由后端用「已驳回」，所以这里不拼默认文案。 */
async function confirmReject(): Promise<void> {
  const item = rejectTarget.value;
  if (item === null) {
    return;
  }
  const note = rejectNote.value.trim();
  busy.value = true;
  try {
    const response = await adminApi.decideAppeal(
      item.code,
      "reject",
      note === "" ? {} : { note },
    );
    notice.value = response.result.message;
    error.value = "";
    rejectTarget.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
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

/** 可选时间：没有就「—」（已处理的申诉没有 `reviewedAt` 才会走到这）。 */
function formatOptionalTime(value: string | undefined): string {
  return value === undefined ? "—" : formatTime(value);
}

/**
 * 「时限」列：已处理的走 `—`；`overdue` 是后端算的权威口径（不是前端拿分钟数瞎猜），
 * 没超时就显示还剩几分钟，让人一眼知道轮转什么时候把它转给别人。
 */
function holdText(item: AdminApiAppealItem): string {
  if (item.overdue) {
    return "已超时";
  }
  if (item.status !== "pending") {
    return "—";
  }
  return item.holdRemainingMinutes === undefined
    ? "—"
    : `还剩 ${item.holdRemainingMinutes} 分钟`;
}
</script>

<template>
  <section class="card">
    <h1>申诉</h1>

    <p class="hint">
      复核（通过 / 驳回）与机器人里的 <code>/appeal</code> 同源：通过 = <b>撤销该处罚</b>
      （逐项：解除禁言 / 解除拉黑等），两种结果都会私信申诉人；
      超时未处理的会按 <b>{{ holdMinutes }}</b> 分钟的时限转派给其他审核员。
    </p>

    <div class="toolbar">
      <label for="appeal-group">群</label>
      <select id="appeal-group" v-model="groupFilter" @change="reload">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="appeal-status">状态</label>
      <select id="appeal-status" v-model="statusFilter" @change="reload">
        <option value="">（全部）</option>
        <option value="pending">待处理</option>
        <option value="accepted">已通过</option>
        <option value="rejected">已驳回</option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="reload">
        刷新
      </button>
    </div>

    <p class="hint">
      待处理 <b>{{ pendingCount }}</b> 条 · 超时转派时限 <b>{{ holdMinutes }}</b> 分钟
    </p>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>
    <p v-if="!loading && items.length === 0 && !error" class="hint">
      没有符合条件的申诉。
    </p>

    <table v-if="items.length > 0" class="table">
      <thead>
        <tr>
          <th>提交时间</th>
          <th>群</th>
          <th>申诉人</th>
          <th>关联处罚</th>
          <th>理由</th>
          <th>状态</th>
          <th>处理人</th>
          <th>时限</th>
          <th>详情</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.appealId">
          <td class="nowrap">{{ formatTime(item.createdAt) }}</td>
          <td>
            <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
            <EntityLabel
              :entity="item.group"
              :fallback="item.groupId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              :entity="item.appellant"
              :fallback="item.userId"
              :details="false"
            />
          </td>
          <td class="nowrap"><code>{{ item.punishmentCode }}</code></td>
          <td class="reason">{{ orDash(item.reason) }}</td>
          <td class="nowrap">
            {{ STATUS_LABEL[item.status] ?? item.status }}
          </td>
          <td>
            <EntityLabel
              v-if="item.reviewer"
              :entity="item.reviewer"
              :fallback="item.reviewerId"
              :details="false"
            />
            <span v-else>—</span>
          </td>
          <!-- 超时是「该转派了」的唯一提示，用红色；其余 pending 行给剩余分钟 -->
          <td class="nowrap" :class="{ error: item.overdue }">
            {{ holdText(item) }}
          </td>
          <!-- 详情：内部 id / 处理备注 / 完整官方长码只在这里出现 -->
          <td>
            <details>
              <summary>详情</summary>
              <dl class="detail-list">
                <dt>申诉短码</dt>
                <dd class="mono">{{ item.code }}</dd>
                <dt>申诉 ID</dt>
                <dd class="mono">{{ item.appealId }}</dd>
                <dt>处罚 ID</dt>
                <dd class="mono">{{ item.punishmentId }}</dd>
                <dt>处理备注</dt>
                <dd>{{ orDash(item.note) }}</dd>
                <dt>处理时间</dt>
                <dd>{{ formatOptionalTime(item.reviewedAt) }}</dd>
                <dt>申诉人</dt>
                <dd class="mono">{{ item.userId }}</dd>
                <dt>处理人</dt>
                <dd class="mono">{{ orDash(item.reviewerId) }}</dd>
                <dt>群 ID</dt>
                <dd class="mono">{{ item.groupId }}</dd>
              </dl>
            </details>
          </td>
          <!-- 只有待处理的才有复核按钮：已处理的行不给（后端也会回「已经处理过了」） -->
          <td>
            <div v-if="item.status === 'pending'" class="row-actions">
              <button
                type="button"
                :disabled="!canReview(item)"
                :title="canReview(item) ? '通过 = 撤销该处罚' : '需要本群审核员（120）'"
                @click="openApprove(item)"
              >
                通过（撤销处罚）
              </button>
              <button
                type="button"
                class="danger"
                :disabled="!canReview(item)"
                :title="canReview(item) ? '驳回申诉（理由会私信申诉人）' : '需要本群审核员（120）'"
                @click="openReject(item)"
              >
                驳回
              </button>
            </div>
            <span v-else>—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 通过 = 撤销处罚：撤回与移出群不可逆，必须写进确认弹窗 -->
    <ModalDialog
      :open="approveTarget !== null"
      title="通过申诉（撤销处罚）？"
      :busy="busy"
      confirm-text="确认通过"
      @close="approveTarget = null"
      @confirm="confirmApprove"
    >
      <template v-if="approveTarget">
        <p class="hint">
          申诉人
          <EntityLabel
            :entity="approveTarget.appellant"
            :fallback="approveTarget.userId"
            :details="false"
          />
          · 关联处罚 <code>{{ approveTarget.punishmentCode }}</code>
        </p>
        <p class="hint">
          通过 = <b>撤销该处罚</b>（逐项：解除禁言 / 解除拉黑等；
          <b>撤回消息与移出群不可逆</b>），并会<b>私信申诉人</b>结果。
        </p>
      </template>
    </ModalDialog>

    <!-- 驳回：理由可空（留空后端用「已驳回」），但一定会私信申诉人 -->
    <ModalDialog
      :open="rejectTarget !== null"
      title="驳回申诉？"
      :busy="busy"
      confirm-text="确认驳回"
      danger
      @close="rejectTarget = null"
      @confirm="confirmReject"
    >
      <template v-if="rejectTarget">
        <p class="hint">
          申诉人
          <EntityLabel
            :entity="rejectTarget.appellant"
            :fallback="rejectTarget.userId"
            :details="false"
          />
          · 关联处罚 <code>{{ rejectTarget.punishmentCode }}</code>
        </p>
        <label for="appeal-reject-note">驳回理由（留空 = 后端用「已驳回」）</label>
        <input
          id="appeal-reject-note"
          v-model="rejectNote"
          type="text"
          maxlength="200"
          placeholder="例如：材料不完整，请补充后重新申诉"
        />
        <p class="hint">会<b>私信申诉人</b>这条理由。</p>
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
