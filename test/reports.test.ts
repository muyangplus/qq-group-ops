import { describe, expect, it } from "vitest";

import { AuditStatus } from "../src/core/enums.js";
import type { AuditRecord } from "../src/core/models.js";
import type { NotificationDelivery } from "../src/db/notificationRepository.js";
import type { PunishmentRecord } from "../src/db/punishmentRepository.js";
import type {
  Activity,
  ActivityRegistration,
  ActivityWaitlistEntry,
} from "../src/services/activity.js";
import {
  buildAdminApiReports,
  buildReportsCsv,
  localDateKey,
  normalizeReportDays,
  REPORT_DAYS_DEFAULT,
  REPORT_DAYS_MAX,
  type AdminApiReportsInput,
} from "../src/adminApi/reports.js";

/**
 * 统计报表的口径（E5 / ADR-0059）：**只用已有记录做聚合**。
 *
 * 这些用例钉的是：分桶按本地日、0 行要补、群活跃到底由哪几项加出来、
 * 范围过滤（超出窗口的事件不算）、以及 CSV 的两档（默认脱敏 / full 带内部群 ID）。
 */
const NOW = new Date(2026, 9, 2, 12, 0, 0); // 本地时间 2026-10-02 12:00

function audit(
  action: string,
  groupId: string,
  at: Date,
): AuditRecord {
  return {
    recordId: `a-${action}-${groupId}-${at.getTime()}`,
    groupId,
    actorId: "mod",
    action,
    status: AuditStatus.Executed,
    reason: "",
    createdAt: at,
  };
}

function punishment(groupId: string, at: Date): PunishmentRecord {
  return {
    recordId: "PUN001",
    groupId,
    userId: "u1",
    actorId: "bot",
    source: "keyword",
    ruleReason: "广告",
    messageId: "m1",
    messageExcerpt: "",
    actions: {
      recalled: true,
      muted: false,
      muteDurationSeconds: 0,
      kicked: false,
      blacklist: "",
    },
    detail: "recall",
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
}

function activity(input: {
  activityId: string;
  groupId: string;
  code: string;
  title: string;
  status?: string;
  capacity?: number;
  createdAt?: Date;
}): Activity {
  return {
    activityId: input.activityId,
    code: input.code,
    groupId: input.groupId,
    groupNumber: "",
    title: input.title,
    createdBy: "admin",
    description: "",
    links: [],
    ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
    allowColleges: [],
    denyColleges: [],
    allowYears: [],
    denyYears: [],
    status: (input.status ?? "draft") as Activity["status"],
    mentionAll: false,
    notifyCreator: false,
    waitlistPromotion: "manual",
    heldSlots: 0,
    createdAt: input.createdAt ?? new Date(2026, 9, 1, 9, 0, 0),
  };
}

function registration(
  activityId: string,
  groupId: string,
  at: Date,
): ActivityRegistration {
  return {
    registrationId: `r-${activityId}-${at.getTime()}`,
    activityId,
    groupId,
    userId: `u-${at.getTime()}`,
    displayName: "",
    note: "",
    createdAt: at,
  };
}

function waitlist(activityId: string, at: Date): ActivityWaitlistEntry {
  return {
    activityId,
    userId: `w-${at.getTime()}`,
    displayName: "",
    note: "",
    createdAt: at,
  };
}

function delivery(
  groupId: string,
  status: "sent" | "failed",
  at: Date,
): NotificationDelivery {
  return {
    groupId,
    requestId: `req-${at.getTime()}-${status}`,
    userId: "u1",
    status,
    detail: "",
    createdAt: at,
  };
}

function entities(): { group(groupId: string): { kind: "group"; officialId: string; label: string } } {
  return {
    group: (groupId) => ({ kind: "group", officialId: groupId, label: `群${groupId}` }),
  };
}

function baseInput(overrides: Partial<AdminApiReportsInput> = {}): AdminApiReportsInput {
  return {
    now: NOW,
    days: 3,
    audit: [],
    punishments: [],
    activities: [],
    registrations: [],
    waitlist: [],
    deliveries: [],
    entities: entities(),
    ...overrides,
  };
}

describe("报表天数", () => {
  it("默认 7 天，非法值回默认，超出上限夹到 90、小于 1 夹到 1", () => {
    expect(normalizeReportDays(undefined)).toBe(REPORT_DAYS_DEFAULT);
    expect(normalizeReportDays(Number.NaN)).toBe(REPORT_DAYS_DEFAULT);
    expect(normalizeReportDays(30)).toBe(30);
    expect(normalizeReportDays(0)).toBe(1);
    expect(normalizeReportDays(-5)).toBe(1);
    expect(normalizeReportDays(365)).toBe(REPORT_DAYS_MAX);
    expect(normalizeReportDays(2.9)).toBe(2);
  });
});

describe("buildAdminApiReports：分桶与口径", () => {
  it("按本地日补 0 行；群活跃 = 审核动作 + 处罚 + 报名 + 投递", () => {
    const view = buildAdminApiReports(
      baseInput({
        days: 3,
        audit: [
          audit("approve_join_request", "g1", new Date(2026, 9, 2, 9, 0, 0)),
          audit("reject_join_request", "g1", new Date(2026, 9, 1, 9, 0, 0)),
          audit("expire_join_request", "g2", new Date(2026, 9, 2, 10, 0, 0)),
          // 与报表无关的审计动作不进活跃口径
          audit("admin_api:report_export", "g1", new Date(2026, 9, 2, 11, 0, 0)),
          // 窗口之外（9-25）的事件不计
          audit("approve_join_request", "g1", new Date(2026, 8, 25, 9, 0, 0)),
        ],
        punishments: [punishment("g1", new Date(2026, 9, 1, 10, 0, 0))],
        registrations: [registration("a1", "g1", new Date(2026, 9, 0, 8, 0, 0))],
        deliveries: [
          delivery("g1", "sent", new Date(2026, 9, 2, 8, 0, 0)),
          delivery("g1", "failed", new Date(2026, 9, 2, 8, 30, 0)),
        ],
      }),
    );

    expect(view.range.days).toBe(3);
    expect(view.daily.map((point) => point.date)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(view.daily.map((point) => point.events)).toEqual([1, 2, 4]);
    expect(view.daily[0]).toMatchObject({ registrations: 1, events: 1 });
    expect(view.daily[1]).toMatchObject({ rejections: 1, punishments: 1 });
    expect(view.daily[2]).toMatchObject({
      approvals: 1,
      expired: 1,
      deliveries: 2,
      events: 4,
    });
    expect(view.totals).toMatchObject({
      events: 7,
      approvals: 1,
      rejections: 1,
      expired: 1,
      punishments: 1,
      registrations: 1,
      deliveries: 2,
      deliveryFailed: 1,
    });
  });

  it("指定群 = 本群报表：只算这个群，且 groups 只有一行", () => {
    const view = buildAdminApiReports(
      baseInput({
        groupId: "g1",
        audit: [
          audit("approve_join_request", "g1", new Date(2026, 9, 2, 9, 0, 0)),
          audit("approve_join_request", "g2", new Date(2026, 9, 2, 9, 0, 0)),
        ],
        deliveries: [delivery("g2", "sent", new Date(2026, 9, 2, 9, 0, 0))],
      }),
    );

    expect(view.group).toMatchObject({ officialId: "g1" });
    expect(view.totals.events).toBe(1);
    expect(view.groups.map((row) => row.groupId)).toEqual(["g1"]);
  });

  it("全量报表：按群一行、事件数倒序；同分按群 ID 稳定排序", () => {
    const view = buildAdminApiReports(
      baseInput({
        audit: [
          audit("approve_join_request", "g2", new Date(2026, 9, 2, 9, 0, 0)),
          audit("approve_join_request", "g2", new Date(2026, 9, 2, 9, 1, 0)),
          audit("approve_join_request", "g1", new Date(2026, 9, 2, 9, 2, 0)),
          audit("reject_join_request", "g3", new Date(2026, 9, 2, 9, 3, 0)),
        ],
      }),
    );

    expect(view.group).toBeUndefined();
    expect(view.groups.map((row) => row.groupId)).toEqual(["g2", "g1", "g3"]);
    expect(view.totals.events).toBe(4);
    expect(view.groups.find((row) => row.groupId === "g2")).toMatchObject({
      events: 2,
      group: { label: "群g2" },
    });
  });

  it("活动明细：本期新增报名单列、候补与满员标记；按本期新增倒序", () => {
    const activityA = activity({
      activityId: "a1",
      groupId: "g1",
      code: "AAA111",
      title: "春游, 第一天",
      status: "open",
      capacity: 2,
    });
    const activityB = activity({
      activityId: "a2",
      groupId: "g1",
      code: "BBB222",
      title: "秋游",
      status: "draft",
    });
    const view = buildAdminApiReports(
      baseInput({
        activities: [activityA, activityB],
        registrations: [
          // a1：一条在窗口内、一条在窗口外（历史报名）
          registration("a1", "g1", new Date(2026, 9, 2, 9, 0, 0)),
          registration("a1", "g1", new Date(2026, 8, 1, 9, 0, 0)),
          registration("a2", "g1", new Date(2026, 9, 1, 9, 0, 0)),
          registration("a1", "g2", new Date(2026, 9, 1, 9, 0, 0)),
        ],
        waitlist: [waitlist("a1", new Date(2026, 9, 1, 8, 0, 0))],
      }),
    );

    const row = view.activities.find((item) => item.code === "#AAA111");
    expect(row).toMatchObject({
      title: "春游, 第一天",
      // g1 两条（1 条历史 + 1 条本期）+ g2 一条（本期）：全量报表三个群都算
      registered: 3,
      registeredInRange: 2,
      waitlist: 1,
      capacity: 2,
      full: true,
    });
    expect(view.activities.map((item) => item.code)).toEqual([
      "#AAA111",
      "#BBB222",
    ]);
    expect(view.totals.waitlist).toBe(1);
    expect(view.totals.newActivities).toBe(2);
    expect(view.totals.openActivities).toBe(1);
  });

  it("没有任何报名的活动不出现在活动明细里（避免把空活动摊一屏）", () => {
    const view = buildAdminApiReports(
      baseInput({
        activities: [
          activity({ activityId: "a1", groupId: "g1", code: "AAA111", title: "空活动" }),
        ],
      }),
    );
    expect(view.activities).toEqual([]);
  });
});

describe("buildReportsCsv", () => {
  it("默认脱敏：只有展示标签列，含 total / daily / group / activity 四段", () => {
    const view = buildAdminApiReports(
      baseInput({
        activities: [
          activity({
            activityId: "a1",
            groupId: "g1",
            code: "AAA111",
            title: "春游, 第一天",
          }),
        ],
        registrations: [registration("a1", "g1", new Date(2026, 9, 2, 9, 0, 0))],
        audit: [audit("approve_join_request", "g1", new Date(2026, 9, 2, 9, 0, 0))],
      }),
    );

    const csv = buildReportsCsv(view, { full: false });
    const [header, ...lines] = csv.trimEnd().split("\n");
    expect(header).toBe("section,metric,bucket,group,value");
    expect(lines.some((line) => line.startsWith("total,events,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("daily,events,2026-10-02,"))).toBe(
      true,
    );
    expect(
      lines.some((line) => line.startsWith("group,events,,群g1,")),
    ).toBe(true);
    // 活动标题里的逗号要被 CSV 转义（整段加引号）
    expect(csv).toContain('"#AAA111 春游, 第一天"');
    // 默认不含内部群 ID 列
    expect(csv).not.toContain("group_id");
  });

  it("full=1：多一列 group_id，脚本能 join 回库", () => {
    const view = buildAdminApiReports(
      baseInput({
        audit: [audit("approve_join_request", "g1", new Date(2026, 9, 2, 9, 0, 0))],
      }),
    );

    const csv = buildReportsCsv(view, { full: true });
    const [header] = csv.split("\n");
    expect(header).toBe("section,metric,bucket,group,group_id,value");
    expect(csv).toContain("group,events,,群g1,g1,1");
  });

  it("本地日期键：用运行机器的本地时区（不受 ISO/UTC 影响）", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31, 0, 0, 0))).toBe("2026-12-31");
  });
});
