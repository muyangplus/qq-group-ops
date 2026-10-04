import { describe, expect, it } from "vitest";

import { FakeGroupSettingsRepository } from "./helpers/fakeGroupConfigRepositories.js";
import { FakeAnnouncementSender } from "./helpers/fakeAnnouncementSender.js";
import { AuditStatus } from "../src/core/enums.js";
import { AuditLogStore } from "../src/services/audit.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import {
  ANNOUNCEMENT_SETTING_KEY,
  cronMatches,
  minuteKeyOf,
  nextFireTimes,
  nextTimesOfCron,
  normalizeAnnouncementContent,
  packButtonRows,
  parseCronExpression,
  renderAnnouncementMessage,
  ScheduledAnnouncementService,
  ScheduledAnnouncementStore,
} from "../src/services/scheduledAnnouncements.js";

interface Harness {
  repository: FakeGroupSettingsRepository;
  queue: WriteQueue;
  store: ScheduledAnnouncementStore;
  service: ScheduledAnnouncementService;
  sender: FakeAnnouncementSender;
  audit: AuditLogStore;
  setNow(at: Date): void;
  now(): Date;
}

async function createHarness(hourlyLimit = 6): Promise<Harness> {
  const repository = new FakeGroupSettingsRepository();
  const queue = new WriteQueue();
  const store = new ScheduledAnnouncementStore(repository, queue);
  await store.load();
  let current = new Date(2026, 9, 3, 8, 0, 0, 0);
  const sender = new FakeAnnouncementSender();
  const audit = new AuditLogStore();
  const service = new ScheduledAnnouncementService({
    store,
    sender,
    audit,
    now: () => current,
    hourlyLimit: () => hourlyLimit,
    groupLabel: (groupId) => `群${groupId}`,
  });
  return {
    repository,
    queue,
    store,
    service,
    sender,
    audit,
    setNow: (at) => {
      current = at;
    },
    now: () => current,
  };
}

describe("cron 解析", () => {
  it("解析正例并给出字段取值", () => {
    const step = parseCronExpression("*/5 * * * *");
    expect(step.ok).toBe(true);
    if (!step.ok) {
      return;
    }
    expect(step.spec.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(step.spec.hours).toHaveLength(24);
    expect(step.spec.domRestricted).toBe(false);

    const workdays = parseCronExpression("0 9 * * 1-5");
    expect(workdays.ok).toBe(true);
    if (workdays.ok) {
      expect(workdays.spec.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
      expect(workdays.spec.dowRestricted).toBe(true);
    }

    const list = parseCronExpression("30 8,20 * * *");
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.spec.minutes).toEqual([30]);
      expect(list.spec.hours).toEqual([8, 20]);
    }
  });

  it("星期 7 归一到周日，区间步长也认", () => {
    const parsed = parseCronExpression("0 0 * * 7");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec.daysOfWeek).toEqual([0]);
    }
    const ranged = parseCronExpression("0 0-6/2 * * *");
    expect(ranged.ok).toBe(true);
    if (ranged.ok) {
      expect(ranged.spec.hours).toEqual([0, 2, 4, 6]);
    }
  });

  it("坏值都给得出人话（段数 / 越界 / 宏 / 空 / 反向区间 / 步长 0）", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /不能为空/u],
      ["0 9 * *", /正好 5 段/u],
      ["0 9 * * * *", /正好 5 段/u],
      ["@daily", /不支持 @daily/u],
      ["61 * * * *", /分钟字段要写 0–59/u],
      ["0 25 * * *", /小时字段要写 0–23/u],
      ["0 0 32 * *", /日字段要写 1–31/u],
      ["0 0 * 13 *", /月字段要写 1–12/u],
      ["0 0 * * 8", /星期字段要写 0–7/u],
      ["10-5 * * * *", /区间要从小到大/u],
      ["*/0 * * * *", /步长要 ≥1/u],
      ["MON * * * *", /分钟字段要写 0–59/u],
      ["0 0 1,,2 * *", /空的项/u],
    ];
    for (const [expression, pattern] of cases) {
      const result = parseCronExpression(expression);
      expect(result.ok, expression).toBe(false);
      if (!result.ok) {
        expect(result.error, expression).toMatch(pattern);
      }
    }
  });
});

describe("下次执行时间", () => {
  it("同一天往后排，且严格晚于当前这一分钟", () => {
    const times = nextTimesOfCron("0 9 * * *", new Date(2026, 9, 3, 8, 30, 0), 3);
    expect(times.map(minuteKeyOf)).toEqual([
      "2026-10-03 09:00",
      "2026-10-04 09:00",
      "2026-10-05 09:00",
    ]);
  });

  it("每 5 分钟的那种给的是最近的 5 个", () => {
    const times = nextTimesOfCron("*/5 * * * *", new Date(2026, 9, 3, 9, 2, 30), 5);
    expect(times.map(minuteKeyOf)).toEqual([
      "2026-10-03 09:05",
      "2026-10-03 09:10",
      "2026-10-03 09:15",
      "2026-10-03 09:20",
      "2026-10-03 09:25",
    ]);
  });

  it("闰年 2 月 29 日能跨年算出来", () => {
    const parsed = parseCronExpression("0 0 29 2 *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const times = nextFireTimes(parsed.spec, new Date(2026, 9, 3, 0, 0, 0), 3);
    expect(times.map(minuteKeyOf)).toEqual([
      "2028-02-29 00:00",
      "2032-02-29 00:00",
      "2036-02-29 00:00",
    ]);
  });

  it("永远不存在的日期（2 月 30 日）快速返回空数组，不挂住", () => {
    const parsed = parseCronExpression("0 0 30 2 *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const started = Date.now();
    expect(nextFireTimes(parsed.spec, new Date(2026, 9, 3, 0, 0, 0), 5)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("日与周都限定时按标准 cron 的「满足任一」", () => {
    const parsed = parseCronExpression("0 0 1 * 1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // 2026-10-03 是周六 → 下一个「周一」是 10-05，而 11-01 是「每月 1 日」
    const times = nextFireTimes(parsed.spec, new Date(2026, 9, 3, 0, 0, 0), 5);
    expect(times.map(minuteKeyOf)).toEqual([
      "2026-10-05 00:00",
      "2026-10-12 00:00",
      "2026-10-19 00:00",
      "2026-10-26 00:00",
      "2026-11-01 00:00",
    ]);
  });

  it("非法表达式给空数组（不抛错）", () => {
    expect(nextTimesOfCron("nonsense", new Date(2026, 9, 3, 0, 0, 0), 5)).toEqual([]);
  });
});

describe("cronMatches", () => {
  it("按分钟粒度判断是否到点", () => {
    const parsed = parseCronExpression("30 8,20 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(cronMatches(parsed.spec, new Date(2026, 9, 3, 8, 30, 0))).toBe(true);
    expect(cronMatches(parsed.spec, new Date(2026, 9, 3, 8, 31, 0))).toBe(false);
    expect(cronMatches(parsed.spec, new Date(2026, 9, 3, 20, 30, 0))).toBe(true);
  });
});

describe("内容校验与渲染", () => {
  const validCard = {
    mode: "card" as const,
    title: "通知",
    text: "该交作业了",
    quote: "原文第一行\n原文第二行",
    buttons: [
      { label: "查看", command: "/activity" },
      { label: "报名", command: "/activity join a1", reply: true },
    ],
    reference: false,
  };

  it("归一化：纯文本模式不许带按钮 / 引用块 / 引用回复", () => {
    const result = normalizeAnnouncementContent({
      mode: "text",
      text: "hello",
      buttons: [{ label: "去", command: "/menu" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("只能用在卡片形态");
    }
  });

  it("归一化：正文空 / 超长 / 按钮过多 / 按钮文字过长都拒绝", () => {
    expect(normalizeAnnouncementContent({ mode: "text", text: "   " }).ok).toBe(false);
    expect(
      normalizeAnnouncementContent({ mode: "text", text: "x".repeat(301) }).ok,
    ).toBe(false);
    const tooMany = normalizeAnnouncementContent({
      mode: "card",
      text: "x",
      buttons: Array.from({ length: 6 }, (_item, index) => ({
        label: `按${index}`,
        command: "/menu",
      })),
    });
    expect(tooMany.ok).toBe(false);
    const longLabel = normalizeAnnouncementContent({
      mode: "card",
      text: "x",
      buttons: [{ label: "这个按钮文字太长了超过十个字", command: "/menu" }],
    });
    expect(longLabel.ok).toBe(false);
  });

  it("渲染卡片：正文 + 引用块 + 按钮，纯文本降级也在", () => {
    const normalized = normalizeAnnouncementContent(validCard);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      return;
    }
    const message = renderAnnouncementMessage(normalized.content);
    expect(message.markdown).toContain("## 通知");
    expect(message.markdown).toContain("该交作业了");
    expect(message.markdown).toContain("> 原文第一行");
    expect(message.markdown).toContain("> 原文第二行");
    const buttons = message.keyboard?.content.rows.flatMap((row) => row.buttons) ?? [];
    expect(buttons.map((button) => button.label)).toEqual(["查看", "报名"]);
    // 第二个按钮开了「点击后带引用回复」
    expect(buttons[1]?.action.reply).toBe(true);
    expect(buttons[0]?.action.reply).toBe(false);
    expect(message.text).toContain("【通知】");
  });

  it("纯文本模式渲染成 content 通道能用的纯文本", () => {
    const normalized = normalizeAnnouncementContent({
      mode: "text",
      text: "该交作业了 <@!u1>",
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      return;
    }
    const message = renderAnnouncementMessage(normalized.content);
    expect(message.text).toBe("该交作业了 <@!u1>");
    expect(message.keyboard).toBeUndefined();
  });

  it("按钮按卡片标准打包：一行文字总长不超过 12 字", () => {
    const rows = packButtonRows([
      { label: "一二三四五六", command: "/a" },
      { label: "一二三四五六", command: "/b" },
      { label: "七", command: "/c" },
    ]);
    expect(rows.map((row) => row.length)).toEqual([2, 1]);
  });
});

describe("存储与增删改", () => {
  it("新建默认停用、写进群配置 KV、重载后还在", async () => {
    const harness = await createHarness();
    const created = harness.service.create({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "早上好" },
      actorId: "u1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.announcement.enabled).toBe(false);
    await harness.queue.flush();
    const row = harness.repository.rows.get(`g1\u0000${ANNOUNCEMENT_SETTING_KEY}`);
    expect(row?.value).toContain("早上好");

    const reloaded = new ScheduledAnnouncementStore(harness.repository, new WriteQueue());
    await reloaded.load();
    expect(reloaded.list("g1")).toHaveLength(1);
    expect(reloaded.list("g1")[0]?.cron).toBe("0 9 * * *");
  });

  it("非法 cron / 空正文 / 超过每群上限都拒绝，且不落库", async () => {
    const harness = await createHarness();
    expect(
      harness.service.create({
        groupId: "g1",
        cron: "@daily",
        content: { mode: "text", text: "x" },
        actorId: "u1",
      }).ok,
    ).toBe(false);
    expect(
      harness.service.create({
        groupId: "g1",
        cron: "0 9 * * *",
        content: { mode: "text", text: "  " },
        actorId: "u1",
      }).ok,
    ).toBe(false);
    for (let index = 0; index < 10; index += 1) {
      expect(
        harness.service.create({
          groupId: "g1",
          cron: "0 9 * * *",
          content: { mode: "text", text: `第 ${index} 条` },
          actorId: "u1",
        }).ok,
      ).toBe(true);
    }
    const overflow = harness.service.create({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "第 11 条" },
      actorId: "u1",
    });
    expect(overflow.ok).toBe(false);
    await harness.queue.flush();
    expect(harness.repository.rows.size).toBe(1);
  });

  it("改 / 启停 / 删都写审计，操作人落在审计 actor 上", async () => {
    const harness = await createHarness();
    const created = harness.service.create({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "x" },
      actorId: "u1",
    });
    if (!created.ok) {
      return;
    }
    const id = created.announcement.id;
    const enabled = harness.service.setEnabled(id, true, "u2");
    expect(enabled.ok && enabled.changed).toBe(true);
    // 再按一次「启用」：如实回 changed: false，不重复写审计
    const again = harness.service.setEnabled(id, true, "u2");
    expect(again.ok && again.changed).toBe(false);

    const updated = harness.service.update(
      id,
      { content: { mode: "card", title: "提醒", text: "该交作业了" } },
      "u2",
    );
    expect(updated.ok).toBe(true);
    expect(harness.service.remove(id, "u3").ok).toBe(true);
    expect(harness.service.find(id)).toBeUndefined();

    const actions = harness.audit.all().map((record) => record.action);
    expect(actions).toEqual([
      "announce_create",
      "announce_update",
      "announce_update",
      "announce_remove",
    ]);
    expect(harness.audit.all()[0]?.actorId).toBe("u1");
    expect(harness.audit.all()[0]?.groupId).toBe("g1");
  });
});

describe("触发（runOnce）", () => {
  async function withTask(
    content: Parameters<ScheduledAnnouncementService["create"]>[0]["content"],
    cron = "0 9 * * *",
  ): Promise<Harness & { id: string }> {
    const harness = await createHarness();
    const created = harness.service.create({
      groupId: "g1",
      cron,
      content,
      actorId: "u1",
    });
    if (!created.ok) {
      throw new Error(created.error);
    }
    harness.service.setEnabled(created.announcement.id, true, "u1");
    return { ...harness, id: created.announcement.id };
  }

  it("到点发一条；同一分钟再跑一次不重发", async () => {
    const harness = await withTask({ mode: "text", text: "早上好" });
    harness.setNow(new Date(2026, 9, 3, 9, 0, 0));
    const first = await harness.service.runOnce();
    expect(first.fired).toBe(1);
    expect(first.sent).toBe(1);
    expect(harness.sender.plainMessages).toHaveLength(1);
    expect(harness.sender.plainMessages[0]).toMatchObject({
      groupId: "g1",
      content: "早上好",
    });

    const second = await harness.service.runOnce();
    expect(second.fired).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(harness.sender.plainMessages).toHaveLength(1);
  });

  it("没到点不发；停用的不发", async () => {
    const harness = await withTask({ mode: "text", text: "早上好" });
    harness.setNow(new Date(2026, 9, 3, 8, 59, 0));
    const notDue = await harness.service.runOnce();
    expect(notDue.skippedNotDue).toBe(1);
    expect(harness.sender.plainMessages).toHaveLength(0);

    harness.service.setEnabled(harness.id, false, "u1");
    harness.setNow(new Date(2026, 9, 3, 9, 0, 0));
    const disabled = await harness.service.runOnce();
    expect(disabled.skippedDisabled).toBe(1);
    expect(harness.sender.plainMessages).toHaveLength(0);
  });

  it("重启后不重发（lastFiredAt 落库），错过的时间点也不补发", async () => {
    const harness = await withTask({ mode: "text", text: "早上好" });
    harness.setNow(new Date(2026, 9, 3, 9, 0, 0));
    await harness.service.runOnce();
    await harness.queue.flush();

    // 模拟重启：从同一份 KV 重新装配
    const store = new ScheduledAnnouncementStore(harness.repository, new WriteQueue());
    await store.load();
    const sender = new FakeAnnouncementSender();
    const service = new ScheduledAnnouncementService({
      store,
      sender,
      now: () => new Date(2026, 9, 3, 9, 0, 30),
    });
    const afterRestart = await service.runOnce();
    expect(afterRestart.fired).toBe(0);
    expect(afterRestart.skippedDuplicate).toBe(1);
    expect(sender.plainMessages).toHaveLength(0);

    // 隔了一天才起来：只按「当前这一分钟」判断，不倒回来补
    const later = new ScheduledAnnouncementService({
      store,
      sender,
      now: () => new Date(2026, 9, 4, 12, 0, 0),
    });
    const missed = await later.runOnce();
    expect(missed.fired).toBe(0);
    expect(missed.skippedNotDue).toBe(1);
    expect(sender.plainMessages).toHaveLength(0);
  });

  it("卡片形态走 sendToGroup，失败只私信配置者并写 rejected 审计", async () => {
    const harness = await withTask({
      mode: "card",
      title: "提醒",
      text: "该交作业了",
      buttons: [{ label: "查看", command: "/activity" }],
    });
    harness.setNow(new Date(2026, 9, 3, 9, 0, 0));
    await harness.service.runOnce();
    expect(harness.sender.groupMessages).toHaveLength(1);
    expect(harness.sender.groupMessages[0]?.message.markdown).toContain("该交作业了");
    const sent = harness.audit
      .all()
      .find((record) => record.action === "announce_fire");
    expect(sent?.status).toBe(AuditStatus.Executed);
    expect(sent?.actorId).toBe("u1");
    expect(harness.sender.directMessages).toHaveLength(0);

    harness.sender.failGroup = true;
    harness.setNow(new Date(2026, 9, 4, 9, 0, 0));
    const failed = await harness.service.runOnce();
    expect(failed.failed).toBe(1);
    const rejected = harness.audit
      .all()
      .filter((record) => record.action === "announce_fire")
      .at(-1);
    expect(rejected?.status).toBe(AuditStatus.Rejected);
    // 群里不留失败痕迹，只私信配置者
    expect(harness.sender.directMessages).toHaveLength(1);
    expect(harness.sender.directMessages[0]?.userId).toBe("u1");
    expect(harness.sender.directMessages[0]?.message.markdown).toContain("没有发出去");
  });

  it("每小时上限到了就不再发，并私信配置者", async () => {
    const harness = await createHarness(2);
    const created = harness.service.create({
      groupId: "g1",
      cron: "* * * * *",
      content: { mode: "text", text: "滴答" },
      actorId: "u1",
    });
    if (!created.ok) {
      return;
    }
    harness.service.setEnabled(created.announcement.id, true, "u1");
    for (const minute of [0, 1, 2]) {
      harness.setNow(new Date(2026, 9, 3, 9, minute, 0));
      await harness.service.runOnce();
    }
    expect(harness.sender.plainMessages.map((item) => item.content)).toEqual([
      "滴答",
      "滴答",
    ]);
    expect(harness.sender.directMessages).toHaveLength(1);
    expect(harness.sender.directMessages[0]?.message.text).toContain("上限");
  });

  it("开启「引用回复」时，5 分钟内的上一条机器人消息被用来带引用", async () => {
    const harness = await createHarness();
    const first = harness.service.create({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "card", title: "提醒", text: "该交作业了", reference: true },
      actorId: "u1",
    });
    const second = harness.service.create({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "card", title: "第二条", text: "第二条正文", reference: true },
      actorId: "u1",
    });
    const third = harness.service.create({
      groupId: "g1",
      cron: "6 9 * * *",
      content: { mode: "card", title: "第三条", text: "第三条正文", reference: true },
      actorId: "u1",
    });
    if (!first.ok || !second.ok || !third.ok) {
      return;
    }
    for (const id of [
      first.announcement.id,
      second.announcement.id,
      third.announcement.id,
    ]) {
      harness.service.setEnabled(id, true, "u1");
    }

    harness.setNow(new Date(2026, 9, 3, 9, 0, 0));
    await harness.service.runOnce();
    // 同一分钟里的两条：第一条没有可引用的目标 → 普通发送；第二条引用它
    expect(harness.sender.groupMessages).toHaveLength(2);
    expect(harness.sender.groupMessages[0]?.msgId).toBeUndefined();
    expect(harness.sender.groupMessages[1]?.msgId).toBe("mid-1");

    // 6 分钟后：上一条已经出了 5 分钟被动窗口 → 不带引用，也不报错
    harness.setNow(new Date(2026, 9, 3, 9, 6, 0));
    await harness.service.runOnce();
    expect(harness.sender.groupMessages).toHaveLength(3);
    expect(harness.sender.groupMessages[2]?.msgId).toBeUndefined();
  });

  it("按钮被降级掉时计数为 degraded（消息本身算成功）", async () => {
    const harness = await withTask({
      mode: "card",
      title: "提醒",
      text: "带按钮的卡",
      buttons: [{ label: "查看", command: "/activity" }],
    });
    harness.sender.groupMode = "markdown";
    harness.setNow(new Date(2026, 9, 3, 9, 0, 0));
    const summary = await harness.service.runOnce();
    expect(summary.sent).toBe(1);
    expect(summary.degraded).toBe(1);
  });

  it("「立即发送」也能发，且同样计入每小时上限", async () => {
    const harness = await createHarness(1);
    const created = harness.service.create({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "手动一条" },
      actorId: "u1",
    });
    if (!created.ok) {
      return;
    }
    const first = await harness.service.sendNow(created.announcement.id, "u1");
    expect(first.ok).toBe(true);
    expect(harness.sender.plainMessages).toHaveLength(1);
    const second = await harness.service.sendNow(created.announcement.id, "u1");
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("上限");
  });
});
