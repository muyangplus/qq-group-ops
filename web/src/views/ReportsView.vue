<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiReportDailyPoint,
  type AdminApiReportsView,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import { GROUP_ADMIN_LEVEL, useSessionStore } from "@/stores/session";

/**
 * 统计报表（E5，非 AI 那半）。
 *
 * 四块口径（docs/DECISIONS.md 的 ADR-0059）**只用已有记录做聚合，不新增埋点**：
 * - **群活跃** = 每天「群内事件」合计（入群审批动作 + 处罚 + 活动报名 + 通知投递）——
 *   是**管理事件量**，不是发言量（库里没有消息计数表，也不为此加一张埋点表）；
 * - **审核量** = 入群审批结果（通过 / 拒绝 / 超时）；
 * - **活动报名** = 本期新增报名（与「当前报名数」分开），外加候补与满员；
 * - **通知投递** = 入群申请推送记录（成功 / 失败）。
 *
 * 门槛：平台超管 240 看全量（可不选群），其余人要选自己 ≥130 的群；
 * CSV 默认脱敏（群只出展示标签），带内部群 ID 的那份要 240。
 */
const session = useSessionStore();

const view = ref<AdminApiReportsView | null>(null);
const loading = ref(false);
const error = ref("");
/** 平台超管默认看全量；其他人必须选一个自己够 130 的群。 */
const groupFilter = ref(session.isSuperAdmin ? "" : firstManageableGroup());
const days = ref(7);
const DAY_OPTIONS = [7, 30, 90];

const groupOptions = computed(() =>
  (session.identity?.permissions?.groups ?? []).map((group) => group.groupId),
);
const manageableGroups = computed(() =>
  groupOptions.value.filter(
    (groupId) => session.levelIn(groupId) >= GROUP_ADMIN_LEVEL,
  ),
);

function firstManageableGroup(): string {
  return (
    (session.identity?.permissions?.groups ?? [])
      .map((group) => group.groupId)
      .find((groupId) => session.levelIn(groupId) >= GROUP_ADMIN_LEVEL) ?? ""
  );
}

function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** 数字列统一右对齐显示（`0` 也要出，方便一眼看出「这天没有事件」）。 */
function dayLabel(date: string): string {
  return date.slice(5);
}

async function load(): Promise<void> {
  if (!session.isSuperAdmin && groupFilter.value.length === 0) {
    view.value = null;
    error.value = "你名下没有达到群管理员（130）的群，看不了报表。";
    return;
  }
  loading.value = true;
  try {
    view.value = await adminApi.reports({
      group: groupFilter.value.length > 0 ? groupFilter.value : undefined,
      days: days.value,
    });
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function exportUrl(full: boolean): string {
  return adminApi.reportsExportUrl({
    group: groupFilter.value.length > 0 ? groupFilter.value : undefined,
    days: days.value,
    full,
  });
}

/** 日序列里的最大值：给条形图当分母（没有数据时给 1，避免除 0）。 */
const dailyMax = computed(() =>
  Math.max(1, ...(view.value?.daily ?? []).map((point) => point.events)),
);

function barWidth(point: AdminApiReportDailyPoint): string {
  return `${Math.round((point.events / dailyMax.value) * 100)}%`;
}
</script>

<template>
  <section class="card">
    <h1>报表</h1>
    <p class="hint">
      口径：只用已有记录做聚合，不新增埋点。群活跃 = 入群审批动作 + 处罚 + 活动报名 +
      通知投递的每天合计（是管理事件量，不是发言量）；审核量看通过 / 拒绝 / 超时；
      活动报名把「本期新增」与「当前报名数」分开；投递是入群申请推送的成功 / 失败。
      详细定义见 <code>docs/DECISIONS.md</code> 的 ADR-0059。
    </p>

    <div class="toolbar">
      <label for="report-group">群</label>
      <select id="report-group" v-model="groupFilter" @change="load">
        <option v-if="session.isSuperAdmin" value="">（全部群 / 全量）</option>
        <option v-for="groupId in manageableGroups" :key="groupId" :value="groupId">
          {{ groupLabel(groupId) }}
        </option>
      </select>
      <label for="report-days">范围</label>
      <select id="report-days" v-model.number="days" @change="load">
        <option v-for="option in DAY_OPTIONS" :key="option" :value="option">
          近 {{ option }} 天
        </option>
      </select>
      <button type="button" class="link" :disabled="loading" @click="load">刷新</button>
      <a class="button" :href="exportUrl(false)" title="脱敏长表：群只出展示标签">
        导出 CSV
      </a>
      <a
        v-if="session.isSuperAdmin"
        class="button"
        :href="exportUrl(true)"
        title="含内部群 ID 列（平台超管 240），便于脚本 join 回库"
      >
        导出完整 CSV
      </a>
      <span v-if="view" class="hint">
        {{ formatTime(view.range.from) }} → {{ formatTime(view.range.to) }} ·
        {{ view.range.days }} 天
      </span>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="view">
      <div class="section-title">群活跃</div>
      <div class="facts">
        <dl>
          <dt>事件合计</dt>
          <dd>{{ view.totals.events }}</dd>
          <dt>审批动作</dt>
          <dd>{{ view.totals.approvals + view.totals.rejections + view.totals.expired }}</dd>
          <dt>处罚</dt>
          <dd>{{ view.totals.punishments }}</dd>
          <dt>活动报名</dt>
          <dd>{{ view.totals.registrations }}</dd>
          <dt>通知投递</dt>
          <dd>{{ view.totals.deliveries }}</dd>
        </dl>
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>日期</th>
            <th>合计</th>
            <th>通过</th>
            <th>拒绝</th>
            <th>超时</th>
            <th>处罚</th>
            <th>报名</th>
            <th>投递</th>
            <th>分布</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="point in view.daily" :key="point.date">
            <td class="nowrap">{{ dayLabel(point.date) }}</td>
            <td>{{ point.events }}</td>
            <td>{{ point.approvals }}</td>
            <td>{{ point.rejections }}</td>
            <td>{{ point.expired }}</td>
            <td>{{ point.punishments }}</td>
            <td>{{ point.registrations }}</td>
            <td>{{ point.deliveries }}</td>
            <td>
              <span class="bar" :style="{ width: barWidth(point) }" />
            </td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">审核量</div>
      <div class="facts">
        <dl>
          <dt>通过</dt>
          <dd>{{ view.totals.approvals }}</dd>
          <dt>拒绝</dt>
          <dd>{{ view.totals.rejections }}</dd>
          <dt>超时过期</dt>
          <dd>{{ view.totals.expired }}</dd>
        </dl>
      </div>
      <p class="hint">
        待处理数不在这里：去「待审批」页看实时队列（报表只统计已落地的审批结果）。
      </p>

      <div class="section-title">活动报名</div>
      <div class="facts">
        <dl>
          <dt>本期新增报名</dt>
          <dd>{{ view.totals.registrations }}</dd>
          <dt>当前候补</dt>
          <dd>{{ view.totals.waitlist }}</dd>
          <dt>本期新建活动</dt>
          <dd>{{ view.totals.newActivities }}</dd>
          <dt>报名中活动</dt>
          <dd>{{ view.totals.openActivities }}</dd>
        </dl>
      </div>
      <p v-if="view.activities.length === 0" class="hint">本期没有活动报名。</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>活动</th>
            <th>状态</th>
            <th>本期新增</th>
            <th>当前报名</th>
            <th>候补</th>
            <th>名额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in view.activities" :key="row.code">
            <td>
              <code>{{ row.code }}</code>
              {{ row.title }}
            </td>
            <td>{{ row.status }}</td>
            <td>{{ row.registeredInRange }}</td>
            <td>{{ row.registered }}</td>
            <td>{{ row.waitlist }}</td>
            <td>
              {{ row.capacity ?? "不限" }}
              <span v-if="row.full" class="badge">已满</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">通知投递</div>
      <div class="facts">
        <dl>
          <dt>投递合计</dt>
          <dd>{{ view.totals.deliveries }}</dd>
          <dt>失败</dt>
          <dd>{{ view.totals.deliveryFailed }}</dd>
        </dl>
      </div>
      <p class="hint">
        失败明细（谁没收到、失败原因）在「投递」页；发不出去的降级说明也在那里。
      </p>

      <div class="section-title">按群</div>
      <table class="table">
        <thead>
          <tr>
            <th>群</th>
            <th>事件合计</th>
            <th>通过</th>
            <th>拒绝</th>
            <th>处罚</th>
            <th>报名</th>
            <th>投递</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in view.groups" :key="row.groupId">
            <td>
              <EntityLabel :entity="row.group" :fallback="row.groupId" />
            </td>
            <td>{{ row.events }}</td>
            <td>{{ row.approvals }}</td>
            <td>{{ row.rejections }}</td>
            <td>{{ row.punishments }}</td>
            <td>{{ row.registrations }}</td>
            <td>{{ row.deliveries }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.bar {
  display: inline-block;
  min-width: 2px;
  height: 10px;
  border-radius: 999px;
  background: var(--accent, #3b82f6);
}
</style>
