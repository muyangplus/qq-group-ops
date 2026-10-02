<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiPunishmentAction,
  type AdminApiPunishmentItem,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { MODERATOR_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 处罚记录（列表只读 + 行内动作）。
 *
 * 口径与 `/punish list` 一致：平台超管 240 可以不选群看全量，
 * 其余人**必须选一个自己够审核员（120）的群**，否则服务端直接 400 / 403。
 * 所以这里跟审计页用同一套「默认选中第一个够 120 的群」的写法，省得用户先撞一次错。
 *
 * 写操作（解除 / 改禁言 / 移出群 / 拉黑）与机器人里的 `/punish …` **完全同源**：
 * 同一个领域服务、同一套通知话术，成功后还会把该处罚下「待处理」的申诉判定为已通过。
 * 每个动作都先过 `ModalDialog` 二次确认；界面只按本群 120 禁用按钮，服务端仍会再判一次。
 *
 * 展示口径：正文只出「群号 / QQ号 → 短码」，完整官方长码与执行结果收进每行末尾的「详情」。
 */
const session = useSessionStore();

const items = ref<AdminApiPunishmentItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(30);
const groupFilter = ref("");
const statusFilter = ref("");
const loading = ref(false);
const error = ref("");
/** 成功回执：动作结果 + 连带判定的申诉条数。 */
const notice = ref("");

/** 正在二次确认的动作（`null` = 没有弹窗）；`scope` 只有拉黑用得到。 */
interface PunishTarget {
  record: AdminApiPunishmentItem;
  action: AdminApiPunishmentAction;
  scope: "group" | "global";
}

const target = ref<PunishTarget | null>(null);
const busy = ref(false);
/** 解除说明 / 拉黑理由：同一个输入框，按动作决定塞进 `note` 还是 `reason`。 */
const note = ref("");
/** 禁言时长用**字符串**存：非数字 / 负数要在弹窗里就拦住，不能等到服务端回 400。 */
const secondsInput = ref("");
/** 弹窗内的输入错误；页面级 `error` 留给服务端错误，两者不混。 */
const inputError = ref("");

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);

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
 * 详情折叠区里的一行：标签 + 值。
 *
 * `mono` 给短码 / 内部 id 这类要等宽显示的值用（长 id 才看得清）。
 */
interface PunishmentDetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * 一行处罚的全部细节。
 *
 * 触发原文（`messageExcerpt`）只在这里出现：正文列放不下，而且它可能是整段聊天内容；
 * 后端没保留时是空串，明确写「未保留原文」而不是留白（免得看着像前端丢了数据）。
 */
function detailRows(record: AdminApiPunishmentItem): PunishmentDetailRow[] {
  const rows: PunishmentDetailRow[] = [
    { label: "处罚短码", value: record.code, mono: true },
    { label: "执行结果", value: orDash(record.detail) },
    { label: "记录 ID", value: record.recordId, mono: true },
    { label: "来源", value: orDash(record.source) },
  ];
  rows.push({
    label: "触发原文",
    value:
      record.messageExcerpt.length > 0 ? record.messageExcerpt : "未保留原文",
  });
  return rows;
}

/**
 * 界面的启用口径：本群审核员 120（平台超管按生效档折算，`isSuperAdmin` 只在画像缺群时兜底）。
 *
 * 这只是省下注定 403 的一次点击，真正的判定在服务端。
 */
function canPunish(groupId: string): boolean {
  return session.isSuperAdmin || session.levelIn(groupId) >= MODERATOR_LEVEL;
}

/** 按钮 `title`：先把「为什么点不了」说清，再说动作本身。 */
function actionTitle(record: AdminApiPunishmentItem, text: string): string {
  return canPunish(record.groupId) ? text : "需要本群审核员（120）";
}

/** 弹窗标题按动作（+ 拉黑范围）给不同的问法，别让「全局」藏在正文里。 */
function dialogTitle(): string {
  const current = target.value;
  if (current === null) {
    return "";
  }
  switch (current.action) {
    case "release":
      return "解除处罚？";
    case "mute":
      return "改禁言时长？";
    case "kick":
      return "移出群？";
    default:
      return current.scope === "global" ? "拉黑（全局）？" : "拉黑（本群）？";
  }
}

function dialogConfirmText(): string {
  const current = target.value;
  if (current === null) {
    return "确认";
  }
  switch (current.action) {
    case "release":
      return "确认解除";
    case "mute":
      return "确认修改";
    case "kick":
      return "确认移出";
    default:
      return current.scope === "global" ? "确认全局拉黑" : "确认拉黑";
  }
}

/** 移出群 / 拉黑**不可逆**：确认按钮用危险色，跟「解除」「改时长」区分开。 */
const dialogDanger = computed(
  (): boolean =>
    target.value !== null &&
    (target.value.action === "kick" || target.value.action === "blacklist"),
);

/** 打开二次确认：清掉上一次的输入与回执，防止误提交旧值。 */
function openAction(
  record: AdminApiPunishmentItem,
  action: AdminApiPunishmentAction,
  scope: "group" | "global" = "group",
): void {
  target.value = { record, action, scope };
  note.value = "";
  // 禁言默认 0：最常用的顺手操作是「解除禁言」，要加时长自己改
  secondsInput.value = action === "mute" ? "0" : "";
  inputError.value = "";
  notice.value = "";
}

async function confirmAction(): Promise<void> {
  const current = target.value;
  if (current === null) {
    return;
  }
  const body: {
    note?: string;
    seconds?: number;
    scope?: "group" | "global";
    reason?: string;
  } = {};
  if (current.action === "mute") {
    const text = secondsInput.value.trim();
    // 只收整数秒：小数 / 负数 / 空 / 带单位都算非法，先在弹窗里拦住，别让服务端回 400
    if (!/^\d+$/.test(text)) {
      inputError.value = "请填整数秒（例如 600；0 = 解除禁言）。";
      return;
    }
    body.seconds = Number.parseInt(text, 10);
  } else if (current.action === "release") {
    if (note.value.trim().length > 0) {
      body.note = note.value.trim();
    }
  } else if (current.action === "blacklist") {
    body.scope = current.scope;
    if (note.value.trim().length > 0) {
      body.reason = note.value.trim();
    }
  }
  inputError.value = "";
  busy.value = true;
  try {
    const response = await adminApi.punish(
      current.record.code,
      current.action,
      body,
    );
    const result = response.result;
    // `acceptedAppeals` 是「处置即回应申诉」的连带结果：要把条数照实说给操作者
    notice.value =
      result.acceptedAppeals > 0
        ? `${result.message}，并已把 ${result.acceptedAppeals} 条待处理申诉判定为已通过。`
        : result.message;
    error.value = "";
    target.value = null;
    // 重新拉列表：`load()` 用的就是当前 refs，所以筛选与页码都保留
    await load();
  } catch (err) {
    // 失败不自动关弹窗：错误留在页面上，弹窗里的输入也还在，用户可改可退
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function load(): Promise<void> {
  // 非超管不选群会被服务端 400：先默认挑一个自己够 120 的群（跟审计页同一套）。
  if (!session.isSuperAdmin && groupFilter.value === "") {
    const first = groupOptions.value.find(
      (groupId) => session.levelIn(groupId) >= MODERATOR_LEVEL,
    );
    if (first === undefined) {
      error.value = "你在任何群里都没有审核员（120）权限，看不到处罚记录。";
      items.value = [];
      total.value = 0;
      return;
    }
    groupFilter.value = first;
  }
  loading.value = true;
  try {
    const result = await adminApi.punishments({
      page: page.value,
      pageSize: pageSize.value,
      group: groupFilter.value || undefined,
      status: statusFilter.value || undefined,
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

async function search(): Promise<void> {
  page.value = 1;
  await load();
}

async function goto(next: number): Promise<void> {
  page.value = Math.min(Math.max(1, next), totalPages.value);
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
    <h1>处罚</h1>

    <div class="toolbar">
      <label for="punish-group">群</label>
      <select id="punish-group" v-model="groupFilter" @change="search">
        <option v-if="session.isSuperAdmin" value="">（全部群）</option>
        <!-- 文本是展示名，value 仍是内部 groupId：过滤器要用它发给后端 -->
        <option v-for="groupId in groupOptions" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="punish-status">状态</label>
      <select id="punish-status" v-model="statusFilter" @change="search">
        <option value="">（全部）</option>
        <option value="active">生效中</option>
        <option value="released">已解除</option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
      <span class="hint">共 {{ total }} 条</span>
    </div>

    <p class="hint">
      处罚是<b>群维度</b>的：解除后仍留记录（状态变「已解除」），所以列表按时间倒序当台账看。
      行内动作与机器人里的 <code>/punish …</code> 完全同源（同一个领域服务、同一套通知话术），
      成功后还会把该处罚下「待处理」的申诉判定为已通过。
    </p>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>
    <p v-if="!loading && items.length === 0 && !error" class="hint">
      没有符合条件的处罚记录。
    </p>

    <table v-if="items.length > 0" class="table">
      <thead>
        <tr>
          <th>时间</th>
          <th>群</th>
          <th>被处罚人</th>
          <th>执行者</th>
          <th>动作</th>
          <th>原因</th>
          <th>状态</th>
          <th>详情</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in items" :key="record.recordId">
          <td class="nowrap">{{ formatTime(record.createdAt) }}</td>
          <td>
            <!-- `EntityLabel` 的实体属性名叫 `entity`：Vue 3 把 `ref` 当保留属性，`:ref` 传不进去 -->
            <EntityLabel
              :entity="record.group"
              :fallback="record.groupId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              :entity="record.target"
              :fallback="record.userId"
              :details="false"
            />
          </td>
          <td>
            <EntityLabel
              :entity="record.actor"
              :fallback="record.actorId"
              :details="false"
            />
          </td>
          <td class="reason">{{ orDash(record.actions) }}</td>
          <!-- 原因列只出规则侧的说法；触发原文收进详情，避免正文被聊天记录撑爆 -->
          <td class="reason">{{ orDash(record.ruleReason) }}</td>
          <td>
            <span v-if="record.status === 'active'" class="badge">生效中</span>
            <span v-else class="badge">已解除</span>
          </td>
          <!-- 详情：完整官方 id / 原文 / 执行结果只在这里出现 -->
          <td>
            <details>
              <summary>详情</summary>
              <dl class="detail-list">
                <template v-for="row in detailRows(record)" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
                </template>
              </dl>
            </details>
          </td>
          <!-- 操作：每个动作都要二次确认，这里只负责把「能不能点」摆出来 -->
          <td>
            <div class="row-actions">
              <button
                type="button"
                :disabled="!canPunish(record.groupId) || record.status === 'released'"
                :title="
                  record.status === 'released'
                    ? '已经解除过了'
                    : actionTitle(record, '逐项撤销这项处罚（解除禁言 / 解除拉黑等）')
                "
                @click="openAction(record, 'release')"
              >
                解除处罚
              </button>
              <button
                type="button"
                :disabled="!canPunish(record.groupId)"
                :title="actionTitle(record, '改禁言时长（0 = 解除禁言）')"
                @click="openAction(record, 'mute')"
              >
                改禁言时长
              </button>
              <button
                type="button"
                class="danger"
                :disabled="!canPunish(record.groupId)"
                :title="actionTitle(record, '移出群（不可逆）')"
                @click="openAction(record, 'kick')"
              >
                移出群
              </button>
              <button
                type="button"
                class="danger"
                :disabled="!canPunish(record.groupId)"
                :title="actionTitle(record, '拉黑（默认同时把人移出本群，不可逆）')"
                @click="openAction(record, 'blacklist', 'group')"
              >
                拉黑
              </button>
              <!-- 全局拉黑要平台超管 240：非超管连按钮都不出现（服务端仍会 403） -->
              <button
                v-if="session.isSuperAdmin"
                type="button"
                class="danger"
                :disabled="!canPunish(record.groupId)"
                :title="actionTitle(record, '全局拉黑（所有已绑定群，不可逆）')"
                @click="openAction(record, 'blacklist', 'global')"
              >
                拉黑（全局）
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

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

    <!-- 一个弹窗承载四种动作：动作不同、后果不同，但确认流程一样 -->
    <ModalDialog
      :open="target !== null"
      :title="dialogTitle()"
      :busy="busy"
      :danger="dialogDanger"
      :confirm-text="dialogConfirmText()"
      @close="target = null"
      @confirm="confirmAction"
    >
      <template v-if="target">
        <p class="hint">
          被处罚人
          <EntityLabel
            :entity="target.record.target"
            :fallback="target.record.userId"
            :details="false"
          />
          · 群
          <EntityLabel
            :entity="target.record.group"
            :fallback="target.record.groupId"
            :details="false"
          />
          · 处罚短码 <code>{{ target.record.code }}</code>
        </p>
        <p class="hint">当前记录动作：{{ orDash(target.record.actions) }}</p>

        <template v-if="target.action === 'release'">
          <p class="hint">
            会<b>逐项撤销</b>这项处罚（解除禁言 / 解除拉黑等）。
            <b>撤回消息与移出群不可逆</b>，不会恢复。
          </p>
          <label for="punish-note">解除说明（可选，写进记录）</label>
          <input id="punish-note" v-model="note" type="text" maxlength="120" />
        </template>

        <template v-else-if="target.action === 'mute'">
          <p class="hint">
            填整数秒，<b>0 = 解除禁言</b>；填了就是新的禁言时长（与机器人
            <code>/punish mute</code> 同一套）。
          </p>
          <label for="punish-seconds">禁言时长（秒）</label>
          <input
            id="punish-seconds"
            v-model="secondsInput"
            type="text"
            inputmode="numeric"
            placeholder="例如 600；0 = 解除禁言"
          />
        </template>

        <template v-else-if="target.action === 'kick'">
          <p class="hint">
            <b>不可逆</b>：会把当事人移出本群，移出后不会自动拉回来。
          </p>
        </template>

        <template v-else>
          <p v-if="target.scope === 'global'" class="hint">
            会影响<b>所有已绑定群</b>，并把人从这些群移出；<b>不可逆</b>。
            只有平台超管能操作。
          </p>
          <p v-else class="hint">
            默认会同时把人移出本群并加入本群黑名单（<b>不可逆</b>）；
            本群黑名单只影响本群。
          </p>
          <label for="punish-reason">拉黑理由（可选）</label>
          <input id="punish-reason" v-model="note" type="text" maxlength="120" />
        </template>

        <p v-if="inputError" class="error">{{ inputError }}</p>
        <p class="hint">
          成功后会自动把该处罚下「待处理」的申诉判定为已通过，并连同通知一起走指令层同一条通道。
        </p>
      </template>
    </ModalDialog>
  </section>
</template>

<style scoped>
/* 详情折叠区的排版：标签靠左、长 id / 原文允许折行（否则 32 位十六进制会撑破列宽） */
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
