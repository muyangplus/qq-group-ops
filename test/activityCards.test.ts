import { describe, expect, it } from "vitest";

import { ActivityStatus } from "../src/core/enums.js";
import {
  ActivityCardService,
  COLLEGE_PAGE_SIZE,
  SIGNUP_PAGE_SIZE,
} from "../src/services/activityCards.js";
import type { Activity, ActivityRegistration, ActivityWaitlistEntry } from "../src/services/activity.js";
import type { UserProfile } from "../src/services/userProfiles.js";

/**
 * 活动卡片（§B2）的渲染约束。
 *
 * 重点覆盖用户确认的落点与标准：
 * - 三种视图 + 名单卡的按钮类型与 `data`；
 * - 一行按钮文字总长 ≤12 字 / 单个 ≤10 字 / 整盘 ≤5 行（模板会抛错，这里直接渲染）；
 * - 名单默认**不显示学号 / 学院**，`完整信息` 才显示；
 * - §B3 未装配时「统计图片 / 导出 CSV」按钮不生成（条件渲染）。
 */

const GROUP = "g1";

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: "a1",
    code: "ACT001",
    groupId: GROUP,
    groupNumber: "654321",
    title: "迎新晚会",
    createdBy: "admin",
    description: "欢迎新同学",
    links: [{ label: "报名入口", url: "https://example.com/signup" }],
    capacity: 20,
    allowColleges: ["化学与生命科学学院"],
    denyColleges: [],
    allowYears: ["22"],
    denyYears: [],
    status: ActivityStatus.Open,
    mentionAll: false,
    notifyCreator: false,
    waitlistPromotion: "manual",
    heldSlots: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRegistration(
  index: number,
  overrides: Partial<ActivityRegistration> = {},
): ActivityRegistration {
  return {
    registrationId: `r${index}`,
    activityId: "a1",
    groupId: GROUP,
    userId: `u${index}`,
    displayName: `同学${index}`,
    note: index === 1 ? "想参加" : "",
    createdAt: new Date(`2026-01-0${index}T00:00:00Z`),
    ...overrides,
  };
}

function makeWaitlistEntry(index: number): ActivityWaitlistEntry {
  return {
    activityId: "a1",
    userId: `w${index}`,
    displayName: `候补${index}`,
    note: "",
    createdAt: new Date(`2026-02-0${index}T00:00:00Z`),
  };
}

function buttonsOf(message: { keyboard?: unknown }): Array<{
  id: string;
  label: string;
  action: { type: number; data: string; modal?: unknown };
}> {
  const keyboard = message.keyboard as
    | { content: { rows: Array<{ buttons: Array<{ id: string; label: string; action: { type: number; data: string; modal?: unknown } }> }> } }
    | undefined;
  return (keyboard?.content.rows ?? []).flatMap((row) =>
    row.buttons.map((button) => ({
      id: button.id,
      label: button.label,
      action: button.action,
    })),
  );
}

function rowsOf(message: { keyboard?: unknown }): Array<Array<{ label: string }>> {
  const keyboard = message.keyboard as
    | { content: { rows: Array<{ buttons: Array<{ label: string }> }> } }
    | undefined;
  return (keyboard?.content.rows ?? []).map((row) =>
    row.buttons.map((button) => ({ label: button.label })),
  );
}

describe("ActivityCardService", () => {
  const profiles = new Map<string, UserProfile>([
    [
      "u1",
      {
        userId: "u1",
        name: "小明",
        studentId: "22123456789",
        className: "材化2211",
        college: "化学与生命科学学院",
        year: "22",
      },
    ],
    [
      "u2",
      {
        userId: "u2",
        name: "小红",
        studentId: "23123456789",
        className: "环工2314",
        college: "环境科学与工程学院",
        year: "23",
      },
    ],
  ]);
  const roster = {
    listColleges: () => [
      "化学与生命科学学院",
      "环境科学与工程学院",
      "材料科学与工程学院",
      "计算机科学与技术学院",
      "数学与统计学院",
      "外国语学院",
    ],
  };
  const service = new ActivityCardService({
    display: undefined,
    profiles: { get: (userId) => profiles.get(userId) },
    roster,
    now: () => new Date("2026-01-10T12:00:00"),
  });

  it("renders the member card with callback buttons and privacy-free text", () => {
    const activity = makeActivity();
    const card = service.memberCard({
      activity,
      registrations: [makeRegistration(1)],
      waitlist: [makeWaitlistEntry(1)],
      viewerId: "u1",
      canManage: true,
      groupLabel: "654321",
    });
    expect(card.markdown).toContain("## 迎新晚会");
    expect(card.markdown).toContain("活动群：654321");
    expect(card.markdown).toContain("报名：1 / 20");
    expect(card.markdown).toContain("候补：1 人");
    expect(card.markdown).toContain("报名限制：学院 化学与生命科学学院 · 年级 22");
    expect(card.markdown).toContain("[报名入口](https://example.com/signup)");
    // 纯文本降级保留 /activity join|quit
    expect(card.text).toContain("/activity join #ACT001");
    expect(card.text).toContain("/activity quit #ACT001");

    const buttons = buttonsOf(card);
    for (const button of buttons) {
      expect(button.action.type).toBe(1);
      expect(button.action.data.startsWith("cb:activity:")).toBe(true);
    }
    const join = buttons.find((button) => button.id === "join");
    expect(join?.action).toMatchObject({ data: "cb:activity:join:#ACT001" });
    expect(join?.action.modal).toBeDefined();
    const quit = buttons.find((button) => button.id === "quit");
    expect(quit?.action.modal).toBeDefined();
    // 管理者能看到「报名名单」，订阅开关显示当前状态
    expect(buttons.some((button) => button.id === "signups")).toBe(true);
    expect(buttons.find((button) => button.id === "subscribe")?.label).toBe("订阅 关");
  });

  it("hides the roster button from non-managers", () => {
    const card = service.memberCard({
      activity: makeActivity(),
      registrations: [],
      viewerId: "u1",
      canManage: false,
    });
    expect(buttonsOf(card).some((button) => button.id === "signups")).toBe(false);
  });

  it("shows the subscription state on the member card", () => {
    const subscribed = new ActivityCardService({
      isSubscribed: (groupId, userId) => groupId === GROUP && userId === "u1",
    });
    const card = subscribed.memberCard({
      activity: makeActivity(),
      registrations: [],
      viewerId: "u1",
    });
    const button = buttonsOf(card).find((item) => item.id === "subscribe");
    expect(button?.label).toBe("订阅 开");
    expect(button?.action.data).toBe(`cb:activity:subscribe:${GROUP}:off`);
  });

  it("keeps every card within the button layout limits", () => {
    const activity = makeActivity({ heldSlots: 1, mentionAll: true });
    const registrations = [makeRegistration(1), makeRegistration(2)];
    const input = { activity, registrations, viewerId: "admin", canManage: true };
    for (const card of [
      service.memberCard(input),
      service.configCard(input),
      service.manageCard(input),
      service.signupsCard(input),
      service.rulesCard({ activity, kind: "college", mode: "allow", page: 1 }),
      service.rulesCard({ activity, kind: "year", mode: "deny", page: 1 }),
    ]) {
      const rows = rowsOf(card);
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const row of rows) {
        const labels = row.map((button) => button.label);
        expect(labels.every((label) => label.length <= 10)).toBe(true);
        expect(labels.join("").length).toBeLessThanOrEqual(12);
      }
    }
  });

  it("renders the config card with the required controls", () => {
    const card = service.configCard({
      activity: makeActivity({ waitlistPromotion: "manual" }),
      registrations: [],
      viewerId: "admin",
      canManage: true,
    });
    const buttons = buttonsOf(card);
    expect(buttons.find((button) => button.id === "capacity-10")?.action.data).toBe(
      "cb:activity:set:#ACT001:capacity:10",
    );
    expect(buttons.find((button) => button.id === "capacity-不限")?.action.data).toBe(
      "cb:activity:set:#ACT001:capacity:clear",
    );
    // 自定义名额 / 截止是**指令按钮**（点击预填指令，用户补参数）
    const capacityCustom = buttons.find((button) => button.id === "capacity-custom");
    expect(capacityCustom?.action.type).toBe(2);
    expect(capacityCustom?.action.data).toBe("/activity set #ACT001 capacity ");
    expect(buttons.find((button) => button.id === "college")?.action.data).toBe(
      "cb:activity:college:#ACT001:allow:1",
    );
    expect(buttons.find((button) => button.id === "year")?.action.data).toBe(
      "cb:activity:year:#ACT001:allow:1",
    );
    expect(buttons.find((button) => button.id === "promotion")?.label).toBe("递补 手动");
    expect(buttons.find((button) => button.id === "open")?.action.modal).toBeDefined();
    expect(buttons.find((button) => button.id === "cancel")?.action.modal).toBeDefined();
    expect(card.markdown).toContain("机器人无法 @全体成员");
  });

  it("renders the manage card and only shows release when slots are held", () => {
    const held = service.manageCard({
      activity: makeActivity({ heldSlots: 2 }),
      registrations: [makeRegistration(1)],
      waitlist: [],
      viewerId: "admin",
      canManage: true,
    });
    expect(held.markdown).toContain("**待释放名额**：2");
    expect(held.markdown).toContain("**学院分布**：化学与生命科学学院 1");
    expect(held.markdown).toContain("**年级分布**：22 1");
    expect(buttonsOf(held).find((button) => button.id === "release")?.action.data).toBe(
      "cb:activity:release:#ACT001",
    );

    const none = service.manageCard({
      activity: makeActivity({ heldSlots: 0 }),
      registrations: [],
      viewerId: "admin",
      canManage: true,
    });
    expect(buttonsOf(none).some((button) => button.id === "release")).toBe(false);
  });

  it("omits §B3 buttons when the stats / export services are missing", () => {
    const card = service.manageCard({
      activity: makeActivity(),
      registrations: [],
      viewerId: "admin",
      canManage: true,
    });
    expect(buttonsOf(card).some((button) => button.id === "stats")).toBe(false);
    const signups = service.signupsCard({
      activity: makeActivity(),
      registrations: [],
      viewerId: "admin",
      canManage: true,
    });
    expect(buttonsOf(signups).some((button) => button.id === "export")).toBe(false);
    expect(service.statsAvailable).toBe(false);
    expect(service.exportAvailable).toBe(false);
  });

  it("renders the §B3 buttons when the optional services are wired", () => {
    const wired = new ActivityCardService({
      stats: { render: async () => undefined },
      exportService: {
        exportCsv: async () => ({ ok: true, text: "已私信导出文件。" }),
      },
    });
    expect(wired.statsAvailable).toBe(true);
    expect(wired.exportAvailable).toBe(true);
    const manage = wired.manageCard({
      activity: makeActivity(),
      registrations: [],
      viewerId: "admin",
      canManage: true,
    });
    expect(buttonsOf(manage).find((button) => button.id === "stats")?.action.data).toBe(
      "cb:activity:stats:#ACT001",
    );
    const signups = wired.signupsCard({
      activity: makeActivity(),
      registrations: [],
      viewerId: "admin",
      canManage: true,
    });
    expect(buttonsOf(signups).find((button) => button.id === "export")?.action.data).toBe(
      "cb:activity:export:#ACT001",
    );
  });

  it("paginates the signup list and hides student ids by default", () => {
    const registrations = Array.from({ length: 12 }, (_, index) =>
      makeRegistration(index + 1),
    );
    const first = service.signupsCard({
      activity: makeActivity({ capacity: 20 }),
      registrations,
      viewerId: "admin",
      canManage: true,
    });
    expect(first.markdown).toContain(`第 1 / 3 页`);
    expect(first.markdown).toContain("同学1（材化2211）");
    expect(first.markdown).not.toContain("22123456789");
    if (SIGNUP_PAGE_SIZE !== 5) {
      throw new Error("名单卡每页人数应为 5（§卡片规范 v2）");
    }
    expect(first.markdown).not.toContain("同学6");

    const second = service.signupsCard({
      activity: makeActivity({ capacity: 20 }),
      registrations,
      page: 2,
      viewerId: "admin",
      canManage: true,
    });
    expect(second.markdown).toContain("第 2 / 3 页");
    const buttons = buttonsOf(second);
    expect(buttons.find((button) => button.id === "prev")?.action.data).toBe(
      "cb:activity:signups:#ACT001:1",
    );
    expect(buttons.find((button) => button.id === "next")?.action.data).toBe(
      "cb:activity:signups:#ACT001:3",
    );

    const full = service.signupsCard({
      activity: makeActivity({ capacity: 20 }),
      registrations,
      page: 1,
      full: true,
      viewerId: "admin",
      canManage: true,
    });
    expect(full.markdown).toContain("22123456789");
    expect(buttonsOf(full).find((button) => button.id === "full")?.action.data).toBe(
      "cb:activity:signups:#ACT001:1",
    );
    // §卡片规范 v2：翻页由按钮承担，卡片里不再出现等价指令
    expect(first.text).not.toContain("/activity signups");
  });

  it("lists the waitlist separately with a cap", () => {
    const registrations = Array.from({ length: 3 }, (_, index) =>
      makeRegistration(index + 1),
    );
    const waitlist = Array.from({ length: 12 }, (_, index) =>
      makeWaitlistEntry(index + 1),
    );
    const card = service.signupsCard({
      activity: makeActivity(),
      registrations,
      waitlist,
      viewerId: "admin",
      canManage: true,
    });
    expect(card.markdown).toContain("**候补**：候补1、候补2");
    expect(card.markdown).toContain("（还有 2 人）");
  });

  it("renders the college / year rule sub-card with selection marks", () => {
    const college = service.rulesCard({
      activity: makeActivity({ allowColleges: ["化学与生命科学学院"] }),
      kind: "college",
      mode: "allow",
      page: 1,
    });
    const buttons = buttonsOf(college);
    // 官方硬限制 10 字：长学院名会被截断（`● ` + 9 字 = 11 字 → 截到 10）
    expect(
      buttons.find((button) => button.id === "option-化学与生命科学学院")?.label,
    ).toBe("● 化学与生命科学学");
    expect(
      buttons.find((button) => button.id === "option-环境科学与工程学院")?.label,
    ).toBe("环境科学与工程学院");
    expect(buttons.find((button) => button.id === "mode")?.action.data).toBe(
      "cb:activity:college:#ACT001:deny:1",
    );
    expect(buttons.find((button) => button.id === "clear")?.action.data).toBe(
      "cb:activity:college:#ACT001:allow:1:clear",
    );
    // 学院名一行 1 个 + 标记会超 12 字，因此每页 2 个、翻页取长名单
    expect(COLLEGE_PAGE_SIZE).toBe(2);
    // 第二页
    const page2 = service.rulesCard({
      activity: makeActivity(),
      kind: "college",
      mode: "allow",
      page: 2,
    });
    expect(buttonsOf(college).some((button) => button.id === "next")).toBe(true);
    expect(buttonsOf(page2).find((button) => button.id === "prev")).toBeDefined();

    const year = service.rulesCard({
      activity: makeActivity({ allowYears: ["22"] }),
      kind: "year",
      mode: "allow",
    });
    const yearButtons = buttonsOf(year);
    expect(yearButtons.find((button) => button.id === "option-22")?.label).toBe("● 22");
    expect(yearButtons.find((button) => button.id === "option-26")?.action.data).toBe(
      "cb:activity:year:#ACT001:allow:1:26",
    );
  });

  it("formats closeAt as MM-DD HH:mm and marks expired windows", () => {
    const before = service.memberCard({
      activity: makeActivity({ closeAt: new Date("2026-03-05T09:05:00") }),
      registrations: [],
    });
    expect(before.markdown).toContain("03-05 09:05");
    const after = service.memberCard({
      activity: makeActivity({ closeAt: new Date("2026-01-01T09:05:00") }),
      registrations: [],
    });
    expect(after.markdown).toContain("已截止");
  });
});
