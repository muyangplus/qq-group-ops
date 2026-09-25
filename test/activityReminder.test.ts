import { describe, expect, it } from "vitest";

import { ActivityService } from "../src/services/activity.js";
import { ActivityReminderService } from "../src/services/activityReminder.js";
import type { ActivityNotificationService } from "../src/services/activityNotifications.js";

/** 建一个「已开放、绑定 g1+g2」的活动。 */
function makeActivity(): { activity: ActivityService; activityId: string } {
  const activity = new ActivityService(undefined, undefined, undefined, {
    generateCode: () => "ACT001",
  });
  const created = activity.createActivity({
    groupId: "g1",
    title: "迎新晚会",
    createdBy: "admin",
  });
  activity.bindGroup(created.activityId, "g1");
  activity.bindGroup(created.activityId, "g2");
  activity.openActivity(created.activityId);
  return { activity, activityId: created.activityId };
}

function stubNotifications(calls: Array<{ activityId: string; groupIds: readonly string[]; kind?: string }>) {
  return {
    notifyGroupsCard: async (input: {
      activityId: string;
      groupIds: readonly string[];
      kind?: string;
    }) => {
      calls.push(input);
      return {
        available: true,
        sent: input.groupIds.length,
        skipped: 0,
        failed: 0,
        recipients: input.groupIds.length,
        groups: [],
      };
    },
  } as unknown as ActivityNotificationService;
}

describe("ActivityReminderService", () => {
  it("到点在所有绑定群广播一次并清掉提醒，重复扫描不重发", async () => {
    const { activity, activityId } = makeActivity();
    const calls: Array<{ activityId: string; groupIds: readonly string[]; kind?: string }> = [];
    const reminder = new ActivityReminderService({
      activity,
      notifications: stubNotifications(calls),
      now: () => new Date("2026-09-25T10:00:00"),
    });

    activity.updateActivity(activityId, { remindAt: new Date("2026-09-25T09:59:00") });
    expect(await reminder.runOnce()).toEqual({ fired: 1, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.activityId).toBe(activityId);
    expect(calls[0]?.groupIds).toEqual(["g1", "g2"]);
    expect(calls[0]?.kind).toBe("remind");
    expect(activity.getActivity(activityId).remindAt).toBeUndefined();

    // 提醒已清掉：再扫不会重复广播
    expect(await reminder.runOnce()).toEqual({ fired: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
  });

  it("未到点不动；活动已取消时只清提醒不广播", async () => {
    const { activity, activityId } = makeActivity();
    const calls: Array<{ activityId: string; groupIds: readonly string[] }> = [];
    const reminder = new ActivityReminderService({
      activity,
      notifications: stubNotifications(calls),
      now: () => new Date("2026-09-25T10:00:00"),
    });

    activity.updateActivity(activityId, { remindAt: new Date("2026-09-25T11:00:00") });
    expect(await reminder.runOnce()).toEqual({ fired: 0, skipped: 1 });
    expect(activity.getActivity(activityId).remindAt).not.toBeUndefined();

    activity.cancelActivity(activityId);
    activity.updateActivity(activityId, { remindAt: new Date("2026-09-25T09:00:00") });
    expect(await reminder.runOnce()).toEqual({ fired: 1, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(activity.getActivity(activityId).remindAt).toBeUndefined();
  });

  it("已过报名截止的活动也不广播", async () => {
    const { activity, activityId } = makeActivity();
    const calls: Array<unknown> = [];
    const reminder = new ActivityReminderService({
      activity,
      notifications: stubNotifications(calls as never),
      now: () => new Date("2026-09-25T10:00:00"),
    });
    activity.updateActivity(activityId, {
      closeAt: new Date("2026-09-25T09:30:00"),
      remindAt: new Date("2026-09-25T09:00:00"),
    });

    expect(await reminder.runOnce()).toEqual({ fired: 1, skipped: 0 });
    expect(calls).toHaveLength(0);
  });
});
