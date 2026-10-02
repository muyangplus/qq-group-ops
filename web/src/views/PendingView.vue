<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi, type AdminApiPendingItem } from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { entityLabel } from "@/lib/entity";
import { GROUP_ADMIN_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 待审批入群申请（E2-c）。
 *
 * 口径与指令层一致（docs/ADMIN-API.md）：
 * - **列表**：服务端按「本群审核员 120 起」裁剪，前端再按群过滤；平台超管拿全量；
 * - **通过 / 拒绝**：要本群**群管理员 130**，前端据此禁用按钮（服务端仍会 403）；
 * - 两个动作都**二次确认**；拒绝可以在弹窗里写自定义理由，留空 = 指令层同一份默认文案。
 */
const session = useSessionStore();

const items = ref<AdminApiPendingItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const groupFilter = ref("");
const loading = ref(false);
const error = ref("");
const notice = ref("");

/** 两个独立的弹窗目标：通过 / 拒绝各自一次确认，不共用状态。 */
const approveTarget = ref<AdminApiPendingItem | null>(null);
const rejectTarget = ref<AdminApiPendingItem | null>(null);
const rejectReason = ref("");
const busy = ref(false);

const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);
const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);

/** 群展示文本（群号 → 短码 → 完整 id），`groupId` 仍是发给后端的内部 id。 */
function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

/** 操作回执里也别再露 openid：优先绑定号 / 短码，退回 `userId`。 */
function applicantLabel(item: AdminApiPendingItem): string {
  return entityLabel(item.applicant, item.userId);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await adminApi.pending({
      page: page.value,
      pageSize: pageSize.value,
      group: groupFilter.value,
    });
    items.value = result.items;
    total.value = result.total;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function canDecide(groupId: string): boolean {
  return session.levelIn(groupId) >= GROUP_ADMIN_LEVEL;
}

function openApprove(item: AdminApiPendingItem): void {
  approveTarget.value = item;
}

function openReject(item: AdminApiPendingItem): void {
  rejectTarget.value = item;
  rejectReason.value = "";
  busy.value = false;
}

async function confirmApprove(): Promise<void> {
  const item = approveTarget.value;
  if (!item) {
    return;
  }
  busy.value = true;
  try {
    const result = await adminApi.approveJoin(item.requestId);
    notice.value = `${result.message}（${applicantLabel(item)}）`;
    approveTarget.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function confirmReject(): Promise<void> {
  const item = rejectTarget.value;
  if (!item) {
    return;
  }
  busy.value = true;
  try {
    const result = await adminApi.rejectJoin(item.requestId, rejectReason.value);
    notice.value = `${result.message}（${applicantLabel(item)}）`;
    rejectTarget.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function goto(next: number): Promise<void> {
  page.value = Math.min(Math.max(1, next), totalPages.value);
  await load();
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <section class="card">
    <h1>待审批入群申请</h1>

    <div class="toolbar">
      <label for="group-filter">群</label>
      <select id="group-filter" v-model="groupFilter" @change="goto(1)">
        <option value="">（我够权限的全部群）</option>
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>

    <p v-if="!loading && items.length === 0" class="hint">
      没有待审批的申请。
    </p>

    <ul class="list">
      <li v-for="item in items" :key="item.requestId">
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
              <EntityLabel :entity="item.group" :fallback="item.groupId" />
              <span class="hint">{{ formatTime(item.createdAt) }}</span>
            </div>
            <div class="hint">
              申请人 <EntityLabel :entity="item.applicant" :fallback="item.userId" />
              <span v-if="item.reason"> · 理由：{{ item.reason }}</span>
              <span v-else> · 未填写理由</span>
            </div>
            <div class="hint">
              申请 <EntityLabel :entity="item.request" :fallback="item.requestId" />
            </div>
          </div>
          <div class="row-actions">
            <button
              type="button"
              :disabled="!canDecide(item.groupId)"
              :title="canDecide(item.groupId) ? '通过' : '需要该群的群管理员（130）'"
              @click="openApprove(item)"
            >
              通过
            </button>
            <button
              type="button"
              class="danger"
              :disabled="!canDecide(item.groupId)"
              :title="canDecide(item.groupId) ? '拒绝' : '需要该群的群管理员（130）'"
              @click="openReject(item)"
            >
              拒绝
            </button>
          </div>
        </div>
      </li>
    </ul>

    <div class="pager">
      <button type="button" class="link" :disabled="page <= 1" @click="goto(page - 1)">
        上一页
      </button>
      <span class="hint">第 {{ page }} / {{ totalPages }} 页</span>
      <button
        type="button"
        class="link"
        :disabled="page >= totalPages"
        @click="goto(page + 1)"
      >
        下一页
      </button>
    </div>

    <ModalDialog
      :open="approveTarget !== null"
      title="通过入群申请？"
      :busy="busy"
      confirm-text="确认通过"
      @close="approveTarget = null"
      @confirm="confirmApprove"
    >
      <p v-if="approveTarget" class="hint">
        申请人 <EntityLabel :entity="approveTarget.applicant" :fallback="approveTarget.userId" /> · 群
        <EntityLabel :entity="approveTarget.group" :fallback="approveTarget.groupId" />
      </p>
      <p class="hint">
        会先调官方审批接口，成功后才改本地状态；群里没有任何回执。
      </p>
    </ModalDialog>

    <ModalDialog
      :open="rejectTarget !== null"
      title="拒绝入群申请？"
      :busy="busy"
      confirm-text="确认拒绝"
      danger
      @close="rejectTarget = null"
      @confirm="confirmReject"
    >
      <p v-if="rejectTarget" class="hint">
        申请人 <EntityLabel :entity="rejectTarget.applicant" :fallback="rejectTarget.userId" /> · 群
        <EntityLabel :entity="rejectTarget.group" :fallback="rejectTarget.groupId" />
      </p>
      <label for="reject-reason">拒绝理由（留空 = 用默认文案）</label>
      <input
        id="reject-reason"
        v-model="rejectReason"
        type="text"
        maxlength="120"
        placeholder="例如：资料不完整，请补齐后重新申请"
      />
      <p class="hint">
        理由会发给申请人（官方 `reject_reason` 是单行字段：换行会被压成一行、超过 120 字截断）。
      </p>
    </ModalDialog>
  </section>
</template>
