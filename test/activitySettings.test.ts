import { describe, expect, it, vi } from "vitest";

import { ActivityService } from "../src/services/activity.js";
import {
  ACTIVITY_SETTING_FIELDS,
  applyActivitySettingValue,
  describeActivitySetting,
  resolveActivitySetting,
} from "../src/services/activitySettings.js";

/**
 * `/activity set` 与管理后台「改活动字段」的**共享解析层**。
 *
 * 这层是为了消除「两边各写一套字段解析」的漂移：同一个字段、同一个值必须解析成
 * 同一个补丁 + 同一组副作用标记。
 */
function seed(): { activities: ActivityService; activityId: string } {
  const activities = new ActivityService();
  const activity = activities.createActivity({
    groupId: "g1",
    title: "周三晚自习",
    createdBy: "admin",
    capacity: 20,
    description: "原简介",
    links: [{ label: "报名表", url: "https://example.com/form" }],
  });
  return { activities, activityId: activity.activityId };
}

describe("活动字段解析：字段表", () => {
  it("字段表覆盖指令层支持的全部字段，且别名唯一", () => {
    const fields = ACTIVITY_SETTING_FIELDS.map((field) => field.field);
    expect(fields).toEqual([
      "title",
      "desc",
      "capacity",
      "group",
      "closeAt",
      "link",
      "links",
      "remindAt",
      "waitlistPromotion",
      "mentionAll",
      "notifyCreator",
      "allowColleges",
      "denyColleges",
      "allowYears",
      "denyYears",
    ]);
    // 别名不重复（否则 `activitySettingField` 会静默按后注册的走）
    const aliases = ACTIVITY_SETTING_FIELDS.flatMap((field) => field.aliases);
    const lowered = aliases.map((alias) => alias.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it("认不出来 → usage（指令层回用法原文）", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const resolved = resolveActivitySetting(activity, "nope", "x");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.kind).toBe("usage");
      expect(resolved.text).toContain("用法：/activity set");
    }
  });

  it("中文别名与大小写都能认（closeAt / closeat / 截止）", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    for (const field of ["closeAt", "closeat", "截止"]) {
      const resolved = resolveActivitySetting(activity, field, "12-31 23:59");
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.field).toBe("closeAt");
        expect(resolved.patch.closeAt?.getMonth()).toBe(11);
      }
    }
  });
});

describe("活动字段解析：各字段补丁", () => {
  it("title：不能清空（refusal），正常值进 patch", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const refused = resolveActivitySetting(activity, "title", "clear");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.kind).toBe("refusal");
      expect(refused.text).toBe("标题不能清空，请填写新的标题。");
    }
    const ok = resolveActivitySetting(activity, "标题", "周四晚自习");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.patch).toEqual({ title: "周四晚自习" });
      expect(ok.notifyParticipants).toBe(true);
    }
  });

  it("capacity：正整数 + 每次改都要标记「满员广播」；clear = 取消上限", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const ok = resolveActivitySetting(activity, "名额", "30");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.patch).toEqual({ capacity: 30 });
      expect(ok.announceFull).toBe(true);
    }
    const bad = resolveActivitySetting(activity, "capacity", "0");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.kind).toBe("invalid");
      expect(bad.text).toContain("需要正整数");
    }
    const cleared = resolveActivitySetting(activity, "capacity", "清空");
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.patch).toEqual({ capacity: undefined });
      // 「capacity in patch」为真 —— ActivityService 据此删除上限（以前这里会静默不生效）
      expect("capacity" in cleared.patch).toBe(true);
    }
  });

  it("link 追加一条 / links 整体替换 / clear 清空", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const appended = resolveActivitySetting(
      activity,
      "link",
      "直播=https://live.example.com",
    );
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.patch.links).toHaveLength(2);
      expect(appended.patch.links?.[1]).toEqual({
        label: "直播",
        url: "https://live.example.com",
      });
    }
    const replaced = resolveActivitySetting(
      activity,
      "links",
      "https://a.example.com https://b.example.com",
    );
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(replaced.patch.links?.map((link) => link.url)).toEqual([
        "https://a.example.com",
        "https://b.example.com",
      ]);
    }
    const cleared = resolveActivitySetting(activity, "links", "clear");
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.patch.links).toEqual([]);
    }
    const bad = resolveActivitySetting(activity, "link", "ftp://x");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.kind).toBe("invalid");
      expect(bad.text).toContain("http");
    }
  });

  it("closeAt / remindAt：解析成 Date；clear = 取消设置", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const close = resolveActivitySetting(activity, "closeAt", "12-31 18:30");
    expect(close.ok).toBe(true);
    if (close.ok) {
      expect(close.patch.closeAt).toBeInstanceOf(Date);
      expect(close.patch.closeAt?.getHours()).toBe(18);
    }
    const remind = resolveActivitySetting(activity, "提醒时间", "2027-01-05 09:00");
    expect(remind.ok).toBe(true);
    if (remind.ok) {
      expect(remind.patch.remindAt?.getFullYear()).toBe(2027);
    }
    const bad = resolveActivitySetting(activity, "closeAt", "明天");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.kind).toBe("invalid");
      expect(bad.text).toContain("格式");
    }
    const cleared = resolveActivitySetting(activity, "closeAt", "clear");
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect("closeAt" in cleared.patch).toBe(true);
      expect(cleared.patch.closeAt).toBeUndefined();
    }
  });

  it("递补：auto 要先释放冻结名额，manual / clear 不用；改递补不私信当事人", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const auto = resolveActivitySetting(activity, "递补", "自动");
    expect(auto.ok).toBe(true);
    if (auto.ok) {
      expect(auto.patch).toEqual({ waitlistPromotion: "auto" });
      // 这个活动还没有冻结名额：不需要先释放（`applyActivitySettingValue` 也只在这时为真才释放）
      expect(auto.releaseHeldSlot).toBe(false);
      expect(auto.notifyParticipants).toBe(false);
      expect(auto.successText).toContain("自动递补");
    }
    const manual = resolveActivitySetting(activity, "waitlistpromotion", "manual");
    expect(manual.ok).toBe(true);
    if (manual.ok) {
      expect(manual.patch).toEqual({ waitlistPromotion: "manual" });
      expect(manual.releaseHeldSlot).toBe(false);
    }
    const cleared = resolveActivitySetting(activity, "递补", "clear");
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.patch).toEqual({ waitlistPromotion: "manual" });
    }
    const bad = resolveActivitySetting(activity, "递补", "随便");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.kind).toBe("invalid");
      expect(bad.text).toContain("auto");
    }
  });

  it("开关 / 列表 / 年级 / 群号", () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const on = resolveActivitySetting(activity, "mentionAll", "开");
    expect(on.ok).toBe(true);
    if (on.ok) {
      expect(on.patch).toEqual({ mentionAll: true });
    }
    const off = resolveActivitySetting(activity, "notifycreator", "关");
    expect(off.ok).toBe(true);
    if (off.ok) {
      expect(off.patch).toEqual({ notifyCreator: false });
    }
    const years = resolveActivitySetting(activity, "允许年级", "22、23");
    expect(years.ok).toBe(true);
    if (years.ok) {
      expect(years.patch.allowYears).toEqual(["22", "23"]);
    }
    // 四位年份被 `normalizeYear` 明确拒绝（与 `/profile set` 同一套口径）
    const badYears = resolveActivitySetting(activity, "允许年级", "2023");
    expect(badYears.ok).toBe(false);
    if (!badYears.ok) {
      expect(badYears.kind).toBe("invalid");
      expect(badYears.text).toContain("四位");
    }
    const colleges = resolveActivitySetting(activity, "禁止学院", "a学院 b学院");
    expect(colleges.ok).toBe(true);
    if (colleges.ok) {
      expect(colleges.patch.denyColleges).toEqual(["a学院", "b学院"]);
    }
    const group = resolveActivitySetting(activity, "群号", "123456");
    expect(group.ok).toBe(true);
    if (group.ok) {
      expect(group.patch).toEqual({ groupNumber: "123456" });
    }
    const clearedGroup = resolveActivitySetting(activity, "群号", "清空");
    expect(clearedGroup.ok).toBe(true);
    if (clearedGroup.ok) {
      expect(clearedGroup.patch).toEqual({ groupNumber: "" });
    }
  });
});

describe("执行一条设置（共享入口）", () => {
  it("落库 + 副作用回调顺序：releaseHeldSlot → update → announceFull → 变更私信", async () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const calls: string[] = [];
    const result = await applyActivitySettingValue(
      activities,
      activity,
      "capacity",
      "1",
      {
        notify: true,
        announceFull: async () => {
          calls.push("announceFull");
        },
        notifyParticipants: (_updated, field) => {
          calls.push(`notify:${field}`);
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      text: `**结果**：已更新 capacity（#${activity.code}）。`,
    });
    expect(calls).toEqual(["announceFull", "notify:capacity"]);
    expect(activities.getActivity(activityId).capacity).toBe(1);
  });

  it("capacity clear 真的取消上限（修复：以前 `{capacity: undefined}` 被静默忽略）", async () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    expect(activity.capacity).toBe(20);
    const result = await applyActivitySettingValue(
      activities,
      activity,
      "capacity",
      "clear",
      { notify: false },
    );
    expect(result.ok).toBe(true);
    expect(activities.getActivity(activityId).capacity).toBeUndefined();
  });

  it("递补改自动：冻结名额会被释放，且不发变更私信", async () => {
    const { activities, activityId } = seed();
    // 先造一个冻结名额：开放 → 报名一人 → 取消（手动模式下变成冻结）
    activities.openActivity(activityId);
    const registration = activities.register({ activityId, userId: "u1" });
    activities.cancelRegistrationWithPromotion(registration.registrationId, "u1");
    expect(activities.getActivity(activityId).heldSlots).toBe(1);
    const announceFull = vi.fn(async () => {});
    const notifyParticipants = vi.fn();
    const result = await applyActivitySettingValue(
      activities,
      activities.getActivity(activityId),
      "waitlistpromotion",
      "auto",
      { notify: true, announceFull, notifyParticipants },
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("自动递补");
    expect(activities.getActivity(activityId).heldSlots).toBe(0);
    expect(notifyParticipants).not.toHaveBeenCalled();
  });

  it("解析失败：不落库、文案与指令层一致", async () => {
    const { activities, activityId } = seed();
    const activity = activities.getActivity(activityId);
    const refused = await applyActivitySettingValue(activities, activity, "title", "clear", {
      notify: true,
    });
    expect(refused).toEqual({
      ok: false,
      text: "标题不能清空，请填写新的标题。",
    });
    const invalid = await applyActivitySettingValue(activities, activity, "capacity", "-1", {
      notify: true,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("设置失败：");
    const usage = await applyActivitySettingValue(activities, activity, "nope", "x", {
      notify: true,
    });
    expect(usage.ok).toBe(false);
    expect(usage.text).toContain("用法：/activity set");
    // 三次都失败：标题与名额都没变
    const after = activities.getActivity(activityId);
    expect(after.title).toBe("周三晚自习");
    expect(after.capacity).toBe(20);
  });
});

describe("当前值的人话描述（审计 diff）", () => {
  it("各字段都能给出可读值", () => {
    const { activities, activityId } = seed();
    activities.openActivity(activityId);
    const activity = activities.getActivity(activityId);
    expect(describeActivitySetting(activity, "title")).toBe("周三晚自习");
    expect(describeActivitySetting(activity, "capacity")).toBe("20");
    expect(describeActivitySetting(activity, "closeAt")).toBe("（未设置）");
    expect(describeActivitySetting(activity, "递补")).toBe("手动释放");
    expect(describeActivitySetting(activity, "links")).toBe(
      "https://example.com/form",
    );
    expect(describeActivitySetting(activity, "允许学院")).toBe("（无）");
    expect(describeActivitySetting(activity, "nope")).toBe("（未知字段）");
  });
});
