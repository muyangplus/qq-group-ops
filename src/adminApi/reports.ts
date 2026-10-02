import type { AuditRecord } from "../core/models.js";
import type { NotificationDelivery } from "../db/notificationRepository.js";
import type { PunishmentRecord } from "../db/punishmentRepository.js";
import type {
  Activity,
  ActivityRegistration,
  ActivityWaitlistEntry,
} from "../services/activity.js";
import { renderCsv } from "../services/export.js";
import type { AdminApiEntityRef } from "./entityRef.js";

/**
 * 统计报表（E5，非 AI 那半）：**只用已有记录做聚合，不新增埋点**。
 *
 * 四块口径（ADR-0059）：
 * - **群活跃** = 每天的「群内事件」合计：入群审批动作（通过 / 拒绝 / 超时）+ 处罚记录 +
 *   活动报名 + 通知投递。它是**管理事件量**，不是发言量 —— 库里没有消息计数表，
 *   我们不为了报表去加一张只增不减的埋点表；
 * - **审核量** = 入群审批结果（审计里的 `approve_join_request` / `reject_join_request` /
 *   `expire_join_request`）；待处理数看 `/api/pending`，报表不重复统计；
 * - **活动报名** = 期间新增的报名记录（`ActivityRegistration.createdAt`）+ 当前候补数
 *   与活动状态；「报名数」与「期间新增」分开给，避免把历史报名算进本期；
 * - **通知投递** = `notification_deliveries` 行（入群申请推送；`sent` / `failed`），
 *   按天与按群聚合。
 *
 * 分桶按**本地日**（`YYYY-MM-DD`），范围含起点与今天；没有事件的那天也补 0 行，
 * 这样图表与 CSV 都不会断档。
 */

/** 允许的报表天数（查询参数会被夹到这个区间）。 */
export const REPORT_DAYS_MIN = 1;
export const REPORT_DAYS_MAX = 90;
export const REPORT_DAYS_DEFAULT = 7;
/** 活动明细最多给这么多条（按本期新增报名倒序）。 */
export const REPORT_ACTIVITY_LIMIT = 20;

export interface AdminApiReportDailyPoint {
  /** 本地日期 `YYYY-MM-DD`。 */
  date: string;
  /** 群活跃：当天群内事件合计。 */
  events: number;
  approvals: number;
  rejections: number;
  expired: number;
  punishments: number;
  registrations: number;
  deliveries: number;
}

export interface AdminApiReportTotals {
  /** 群活跃（= 下面几项之和）。 */
  events: number;
  approvals: number;
  rejections: number;
  expired: number;
  punishments: number;
  registrations: number;
  /** 当前候补人数（不是期间新增）。 */
  waitlist: number;
  deliveries: number;
  deliveryFailed: number;
  /** 期间新建的活动数。 */
  newActivities: number;
  /** 当前处于「报名中」的活动数。 */
  openActivities: number;
}

export interface AdminApiReportGroupRow {
  groupId: string;
  group: AdminApiEntityRef;
  events: number;
  approvals: number;
  rejections: number;
  punishments: number;
  registrations: number;
  deliveries: number;
}

export interface AdminApiReportActivityRow {
  code: string;
  title: string;
  status: string;
  /** 当前报名数（含本期之前报的）。 */
  registered: number;
  /** 本期新增报名数（报表的核心指标）。 */
  registeredInRange: number;
  /** 当前候补人数。 */
  waitlist: number;
  capacity?: number | undefined;
  /** 有上限且当前报名数 ≥ 上限。 */
  full: boolean;
  createdAt: string;
}

export interface AdminApiReportsView {
  range: { days: number; from: string; to: string };
  /** 选中的群；平台超管不传 `group`（全量报表）时缺省。 */
  group?: AdminApiEntityRef | undefined;
  /** 按群合计；本群报表只有一行，全量报表按事件数倒序（同分按群 ID）。 */
  groups: AdminApiReportGroupRow[];
  /** 每天一行，含 0 行。 */
  daily: AdminApiReportDailyPoint[];
  totals: AdminApiReportTotals;
  /** 活动明细（按本期新增报名倒序，最多 `REPORT_ACTIVITY_LIMIT` 条）。 */
  activities: AdminApiReportActivityRow[];
}

/** 把天数夹到合法区间；非正整数一律回默认值。 */
export function normalizeReportDays(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return REPORT_DAYS_DEFAULT;
  }
  const days = Math.trunc(raw);
  if (days < REPORT_DAYS_MIN) {
    return REPORT_DAYS_MIN;
  }
  return Math.min(days, REPORT_DAYS_MAX);
}

export interface AdminApiReportsInput {
  now: Date;
  days: number;
  /** 指定群 = 本群报表；`undefined` = 全量报表（调用方先判 240）。 */
  groupId?: string | undefined;
  audit: readonly AuditRecord[];
  punishments: readonly PunishmentRecord[];
  activities: readonly Activity[];
  registrations: readonly ActivityRegistration[];
  waitlist: readonly ActivityWaitlistEntry[];
  deliveries: readonly NotificationDelivery[];
  /** 展示层：群 ID → `AdminApiEntityRef`。 */
  entities: { group(groupId: string): AdminApiEntityRef };
}

/** 各类事件的「一天一格」计数器。 */
interface Bucket {
  approvals: number;
  rejections: number;
  expired: number;
  punishments: number;
  registrations: number;
  deliveries: number;
}

function emptyBucket(): Bucket {
  return {
    approvals: 0,
    rejections: 0,
    expired: 0,
    punishments: 0,
    registrations: 0,
    deliveries: 0,
  };
}

function eventsOf(bucket: Bucket): number {
  return (
    bucket.approvals +
    bucket.rejections +
    bucket.expired +
    bucket.punishments +
    bucket.registrations +
    bucket.deliveries
  );
}

/** 本地日 `YYYY-MM-DD`（跨天按运行机器的本地时区算）。 */
export function localDateKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const APPROVE_ACTIONS = new Set(["approve_join_request"]);
const REJECT_ACTIONS = new Set(["reject_join_request"]);
const EXPIRE_ACTIONS = new Set(["expire_join_request"]);

export function buildAdminApiReports(
  input: AdminApiReportsInput,
): AdminApiReportsView {
  const days = normalizeReportDays(input.days);
  const to = input.now;
  const from = startOfLocalDay(
    new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000),
  );
  const scope = input.groupId;
  const inScope = (groupId: string): boolean =>
    scope === undefined || groupId === scope;
  const inRange = (at: Date): boolean => at >= from && at <= to;

  // 先按「日期 → 计数器」与「群 → 计数器」铺两层，事件逐类累加。
  const daily = new Map<string, Bucket>();
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(from.getTime() + offset * 24 * 60 * 60 * 1000);
    daily.set(localDateKey(day), emptyBucket());
  }
  const perGroup = new Map<string, Bucket>();
  const bucketOf = (groupId: string): Bucket => {
    const existing = perGroup.get(groupId);
    if (existing) {
      return existing;
    }
    const created = emptyBucket();
    perGroup.set(groupId, created);
    return created;
  };
  const add = (
    at: Date,
    groupId: string,
    field: keyof Bucket,
  ): void => {
    const day = daily.get(localDateKey(at));
    if (day) {
      day[field] += 1;
    }
    bucketOf(groupId)[field] += 1;
  };

  for (const record of input.audit) {
    if (!inScope(record.groupId) || !inRange(record.createdAt)) {
      continue;
    }
    if (APPROVE_ACTIONS.has(record.action)) {
      add(record.createdAt, record.groupId, "approvals");
    } else if (REJECT_ACTIONS.has(record.action)) {
      add(record.createdAt, record.groupId, "rejections");
    } else if (EXPIRE_ACTIONS.has(record.action)) {
      add(record.createdAt, record.groupId, "expired");
    }
  }
  for (const record of input.punishments) {
    if (inScope(record.groupId) && inRange(record.createdAt)) {
      add(record.createdAt, record.groupId, "punishments");
    }
  }
  for (const registration of input.registrations) {
    if (inScope(registration.groupId) && inRange(registration.createdAt)) {
      add(registration.createdAt, registration.groupId, "registrations");
    }
  }
  for (const delivery of input.deliveries) {
    if (inScope(delivery.groupId) && inRange(delivery.createdAt)) {
      add(delivery.createdAt, delivery.groupId, "deliveries");
    }
  }

  const dailyPoints: AdminApiReportDailyPoint[] = [...daily.entries()].map(
    ([date, bucket]) => ({
      date,
      events: eventsOf(bucket),
      approvals: bucket.approvals,
      rejections: bucket.rejections,
      expired: bucket.expired,
      punishments: bucket.punishments,
      registrations: bucket.registrations,
      deliveries: bucket.deliveries,
    }),
  );
  // 本地日期是 `YYYY-MM-DD`，字典序即时间序
  dailyPoints.sort((left, right) => left.date.localeCompare(right.date));

  const groups: AdminApiReportGroupRow[] = [...perGroup.entries()]
    .map(([groupId, bucket]) => ({
      groupId,
      group: input.entities.group(groupId),
      events: eventsOf(bucket),
      approvals: bucket.approvals,
      rejections: bucket.rejections,
      punishments: bucket.punishments,
      registrations: bucket.registrations,
      deliveries: bucket.deliveries,
    }))
    .sort(
      (left, right) =>
        right.events - left.events || left.groupId.localeCompare(right.groupId),
    );

  const totals: AdminApiReportTotals = {
    events: groups.reduce((sum, row) => sum + row.events, 0),
    approvals: groups.reduce((sum, row) => sum + row.approvals, 0),
    rejections: groups.reduce((sum, row) => sum + row.rejections, 0),
    expired: dailyPoints.reduce((sum, point) => sum + point.expired, 0),
    punishments: groups.reduce((sum, row) => sum + row.punishments, 0),
    registrations: groups.reduce((sum, row) => sum + row.registrations, 0),
    waitlist: input.waitlist.filter((entry) => {
      const activity = input.activities.find(
        (candidate) => candidate.activityId === entry.activityId,
      );
      return activity !== undefined && inScope(activity.groupId);
    }).length,
    deliveries: groups.reduce((sum, row) => sum + row.deliveries, 0),
    deliveryFailed: input.deliveries.filter(
      (delivery) =>
        inScope(delivery.groupId) &&
        inRange(delivery.createdAt) &&
        delivery.status === "failed",
    ).length,
    newActivities: input.activities.filter(
      (activity) => inScope(activity.groupId) && inRange(activity.createdAt),
    ).length,
    openActivities: input.activities.filter(
      (activity) => inScope(activity.groupId) && activity.status === "open",
    ).length,
  };

  const registeredByActivity = new Map<string, number>();
  const registeredInRangeByActivity = new Map<string, number>();
  for (const registration of input.registrations) {
    if (!inScope(registration.groupId)) {
      continue;
    }
    registeredByActivity.set(
      registration.activityId,
      (registeredByActivity.get(registration.activityId) ?? 0) + 1,
    );
    if (inRange(registration.createdAt)) {
      registeredInRangeByActivity.set(
        registration.activityId,
        (registeredInRangeByActivity.get(registration.activityId) ?? 0) + 1,
      );
    }
  }
  const waitlistByActivity = new Map<string, number>();
  for (const entry of input.waitlist) {
    waitlistByActivity.set(
      entry.activityId,
      (waitlistByActivity.get(entry.activityId) ?? 0) + 1,
    );
  }
  const activities: AdminApiReportActivityRow[] = input.activities
    .filter((activity) => inScope(activity.groupId))
    .map((activity) => {
      const registered = registeredByActivity.get(activity.activityId) ?? 0;
      return {
        code: `#${activity.code}`,
        title: activity.title,
        status: activity.status,
        registered,
        registeredInRange:
          registeredInRangeByActivity.get(activity.activityId) ?? 0,
        waitlist: waitlistByActivity.get(activity.activityId) ?? 0,
        ...(activity.capacity !== undefined
          ? { capacity: activity.capacity }
          : {}),
        full: activity.capacity !== undefined && registered >= activity.capacity,
        createdAt: activity.createdAt.toISOString(),
      };
    })
    .filter((row) => row.registered > 0 || row.registeredInRange > 0)
    .sort(
      (left, right) =>
        right.registeredInRange - left.registeredInRange ||
        right.registered - left.registered ||
        left.code.localeCompare(right.code),
    )
    .slice(0, REPORT_ACTIVITY_LIMIT);

  return {
    range: {
      days,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    ...(scope !== undefined ? { group: input.entities.group(scope) } : {}),
    groups,
    daily: dailyPoints,
    totals,
    activities,
  };
}

/**
 * 报表 CSV：**长表**（`section,metric,bucket,group,value`），页面上的四块都能从这里还原。
 *
 * - 默认（脱敏）：群只出展示标签（群号 / 短码），不含内部群 ID；
 * - `full=1`（平台 240）：多一列 `group_id`（内部群 ID），便于脚本 join 回库。
 */
export function buildReportsCsv(
  view: AdminApiReportsView,
  options: { full: boolean },
): string {
  const scopeLabel =
    view.group?.label ?? (options.full ? "all" : "（全量）");
  const headers = options.full
    ? ["section", "metric", "bucket", "group", "group_id", "value"]
    : ["section", "metric", "bucket", "group", "value"];
  const rows: string[][] = [];
  const scopeId = view.group?.officialId ?? "";
  const push = (
    section: string,
    metric: string,
    bucket: string,
    group: string,
    groupId: string,
    value: number | string,
  ): void => {
    rows.push(
      options.full
        ? [section, metric, bucket, group, groupId, String(value)]
        : [section, metric, bucket, group, String(value)],
    );
  };

  push("range", "days", "", scopeLabel, scopeId, view.range.days);
  push("range", "from", "", scopeLabel, scopeId, view.range.from);
  push("range", "to", "", scopeLabel, scopeId, view.range.to);
  for (const [metric, value] of [
    ["events", view.totals.events],
    ["approvals", view.totals.approvals],
    ["rejections", view.totals.rejections],
    ["expired", view.totals.expired],
    ["punishments", view.totals.punishments],
    ["registrations", view.totals.registrations],
    ["waitlist", view.totals.waitlist],
    ["deliveries", view.totals.deliveries],
    ["delivery_failed", view.totals.deliveryFailed],
    ["new_activities", view.totals.newActivities],
    ["open_activities", view.totals.openActivities],
  ] as const) {
    push("total", metric, "", scopeLabel, scopeId, value);
  }
  for (const point of view.daily) {
    for (const [metric, value] of [
      ["events", point.events],
      ["approvals", point.approvals],
      ["rejections", point.rejections],
      ["expired", point.expired],
      ["punishments", point.punishments],
      ["registrations", point.registrations],
      ["deliveries", point.deliveries],
    ] as const) {
      push("daily", metric, point.date, scopeLabel, scopeId, value);
    }
  }
  for (const row of view.groups) {
    for (const [metric, value] of [
      ["events", row.events],
      ["approvals", row.approvals],
      ["rejections", row.rejections],
      ["punishments", row.punishments],
      ["registrations", row.registrations],
      ["deliveries", row.deliveries],
    ] as const) {
      push("group", metric, "", row.group.label, row.groupId, value);
    }
  }
  for (const row of view.activities) {
    for (const [metric, value] of [
      ["registered", row.registered],
      ["registered_in_range", row.registeredInRange],
      ["waitlist", row.waitlist],
      ["capacity", row.capacity ?? ""],
      ["full", row.full ? 1 : 0],
    ] as const) {
      push(
        "activity",
        metric,
        `${row.code} ${row.title}`,
        scopeLabel,
        scopeId,
        value,
      );
    }
  }
  return renderCsv(headers, rows);
}
