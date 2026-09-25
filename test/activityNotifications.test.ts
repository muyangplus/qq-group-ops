import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import type { ActivityNotificationRepository } from "../src/db/activityNotificationRepository.js";
import { ActivityNotificationService } from "../src/services/activityNotifications.js";
import { NotificationService } from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";
import { renderCard } from "../src/services/cardTemplate.js";
import type { RichMessageSender } from "../src/services/richMessages.js";

/**
 * 活动通知（§B2）：按群订阅 + 私信推送，带**去重**与**每人每日封顶**。
 *
 * 用户确认的真机事实：主动私信有额度（单用户每天 1000 条、单关系 20 qpm），
 * 所以同一活动同一类型只发一次，且每人每天最多 N 条（默认 3，0 = 不限制）。
 */

const CARD = renderCard({ title: "新活动", lines: ["测试"] });

function createSpySender() {
  const sent: Array<{ userId: string; markdown: string }> = [];
  const failures = new Set<string>();
  return {
    sent,
    failures,
    service: {
      sendPrivateCard: async (userId: string, message: { markdown: string }) => {
        if (failures.has(userId)) {
          return { ok: false, detail: "blocked" };
        }
        sent.push({ userId, markdown: message.markdown });
        return { ok: true, detail: "" };
      },
    } as unknown as NotificationService,
  };
}

describe("ActivityNotificationService", () => {
  it("subscribes / unsubscribes and lists the subscribed groups", () => {
    const spy = createSpySender();
    const service = new ActivityNotificationService(spy.service);
    expect(service.isSubscribed("g1", "u1")).toBe(false);
    service.subscribe("g1", "u1");
    service.subscribe("g2", "u1");
    service.subscribe("g1", "u2");
    expect(service.isSubscribed("g1", "u1")).toBe(true);
    expect(service.listSubscribedGroups("u1")).toEqual(["g1", "g2"]);
    expect(service.subscribersOf("g1")).toEqual(["u1", "u2"]);
    expect(service.unsubscribe("g1", "u1")).toBe(true);
    expect(service.unsubscribe("g1", "u1")).toBe(false);
    expect(service.listSubscribedGroups("u1")).toEqual(["g2"]);
  });

  it("pushes a new activity to every subscriber of the group only", async () => {
    const spy = createSpySender();
    const service = new ActivityNotificationService(spy.service);
    service.subscribe("g1", "u1");
    service.subscribe("g1", "u2");
    service.subscribe("g2", "u3");

    const result = await service.publishNewActivity({
      activityId: "a1",
      groupId: "g1",
      card: CARD,
    });
    expect(result).toMatchObject({ sent: 2, recipients: 2, skipped: 0, failed: 0 });
    expect(spy.sent.map((item) => item.userId)).toEqual(["u1", "u2"]);
  });

  it("deduplicates the same (activity, user, kind) delivery", async () => {
    const spy = createSpySender();
    const service = new ActivityNotificationService(spy.service);
    service.subscribe("g1", "u1");
    await service.publishNewActivity({ activityId: "a1", groupId: "g1", card: CARD });
    const second = await service.publishNewActivity({
      activityId: "a1",
      groupId: "g1",
      card: CARD,
    });
    expect(spy.sent).toHaveLength(1);
    expect(second).toMatchObject({ sent: 0, skipped: 1 });

    // 换了活动 id 或 kind 都不算重复
    await service.publishNewActivity({ activityId: "a1", groupId: "g1", card: CARD });
    await service.notifyParticipants({
      activityId: "a1",
      userIds: ["u1"],
      kind: "changed",
      text: "变更",
    });
    expect(spy.sent).toHaveLength(2);
  });

  it("caps deliveries per user per day and reports rate limited", async () => {
    const spy = createSpySender();
    const service = new ActivityNotificationService(spy.service, undefined, undefined, {
      dailyLimit: 2,
      now: () => new Date("2026-01-10T10:00:00"),
    });
    for (const activityId of ["a1", "a2", "a3"]) {
      await service.notifyParticipants({
        activityId,
        userIds: ["u1"],
        kind: "changed",
        text: "变更",
      });
    }
    expect(spy.sent).toHaveLength(2);
    const fourth = await service.notifyParticipants({
      activityId: "a4",
      userIds: ["u1"],
      kind: "changed",
      text: "变更",
    });
    expect(fourth).toMatchObject({ sent: 0, skipped: 1, rateLimited: 1 });
    // 另一个人不受影响
    const other = await service.notifyParticipants({
      activityId: "a4",
      userIds: ["u2"],
      kind: "changed",
      text: "变更",
    });
    expect(other.sent).toBe(1);
  });

  it("treats dailyLimit = 0 as unlimited and resets the next day", async () => {
    const spy = createSpySender();
    let now = new Date("2026-01-10T23:00:00");
    const service = new ActivityNotificationService(spy.service, undefined, undefined, {
      dailyLimit: 0,
      now: () => now,
    });
    for (const activityId of ["a1", "a2", "a3", "a4"]) {
      await service.notifyParticipants({
        activityId,
        userIds: ["u1"],
        kind: "changed",
        text: "变更",
      });
    }
    expect(spy.sent).toHaveLength(4);

    // 跨天后计数重置（用同一用户、不同活动）
    now = new Date("2026-01-11T01:00:00");
    const capped = new ActivityNotificationService(spy.service, undefined, undefined, {
      dailyLimit: 0,
      now: () => now,
    });
    const result = await capped.notifyParticipants({
      activityId: "a5",
      userIds: ["u1"],
      kind: "changed",
      text: "变更",
    });
    expect(result.sent).toBe(1);
  });

  it("keeps going when a private message fails and logs it", async () => {
    const spy = createSpySender();
    spy.failures.add("u1");
    const service = new ActivityNotificationService(spy.service);
    service.subscribe("g1", "u1");
    service.subscribe("g1", "u2");
    const result = await service.publishNewActivity({
      activityId: "a1",
      groupId: "g1",
      card: CARD,
    });
    expect(result).toMatchObject({ sent: 1, failed: 1, recipients: 2 });
    expect(spy.sent.map((item) => item.userId)).toEqual(["u2"]);

    // 失败不会写去重行：修好之后可以重试
    const retry = await service.publishNewActivity({
      activityId: "a1",
      groupId: "g1",
      card: CARD,
    });
    expect(retry).toMatchObject({ sent: 0, failed: 1, skipped: 1 });
  });

  it("notifies participants with a generated card by default", async () => {
    const spy = createSpySender();
    const service = new ActivityNotificationService(spy.service);
    await service.notifyParticipants({
      activityId: "a1",
      userIds: ["u1", "u1", "u2"],
      kind: "cancelled",
      text: "活动已取消。",
    });
    expect(spy.sent).toHaveLength(2);
    expect(spy.sent[0]?.markdown).toContain("活动已取消");
    expect(spy.sent[0]?.markdown).toContain("自动发出");
  });

  it("survives a round trip through the repositories", async () => {
    const api = new FakeQQOfficialAPI();
    const notifications = new NotificationService(
      api,
      new PermissionService({ superAdminIds: new Set(["root"]) }),
    );
    const subscriptions = {
      rows: [] as Array<{ groupId: string; userId: string; createdAt: Date }>,
      async findAll() {
        return [...this.rows];
      },
      async save(entry: { groupId: string; userId: string; createdAt: Date }) {
        this.rows.push(entry);
      },
      async remove(groupId: string, userId: string) {
        this.rows = this.rows.filter(
          (row) => row.groupId !== groupId || row.userId !== userId,
        );
      },
    };
    const delivered: Array<{ activityId: string; userId: string; kind: string }> = [];
    const rows = {
      stored: [] as Array<{
        activityId: string;
        userId: string;
        kind: string;
        createdAt: Date;
      }>,
      async findAll() {
        return [...this.stored];
      },
      async save(entry: {
        activityId: string;
        userId: string;
        kind: string;
        createdAt: Date;
      }) {
        delivered.push({
          activityId: entry.activityId,
          userId: entry.userId,
          kind: entry.kind,
        });
        this.stored.push(entry);
      },
      async countSince() {
        return 0;
      },
      async deleteOlderThan() {
        this.stored = [];
      },
    };
    const service = new ActivityNotificationService(
      notifications,
      subscriptions,
      rows,
    );
    service.subscribe("g1", "u1");
    await service.flush();

    const restored = new ActivityNotificationService(
      notifications,
      subscriptions,
      rows,
      { dailyLimit: 3 },
    );
    await restored.load();
    expect(restored.isSubscribed("g1", "u1")).toBe(true);

    // 重启后去重行也在：同一活动不会重复私信
    await restored.publishNewActivity({
      activityId: "a1",
      groupId: "g1",
      card: CARD,
    });
    const again = await restored.publishNewActivity({
      activityId: "a1",
      groupId: "g1",
      card: CARD,
    });
    expect(again.skipped).toBe(1);
    expect(delivered).toEqual([{ activityId: "a1", userId: "u1", kind: "published" }]);
    await restored.flush();
  });

  // ---------------------------------------------------------------- §B4

  it("broadcasts a group card once per group without touching the daily private quota", async () => {
    const spy = createSpySender();
    const groupCards: Array<{ groupId: string; markdown: string }> = [];
    const stored: Array<{
      activityId: string;
      userId: string;
      kind: string;
      createdAt: Date;
    }> = [];
    const service = new ActivityNotificationService(
      spy.service,
      undefined,
      createMemoryNotificationRepository(stored),
      {
        groupSender: createGroupSender({
          onSend: async (groupId, message) => {
            groupCards.push({ groupId, markdown: message.markdown });
            return { ok: true, detail: "", mode: "markdown" };
          },
        }),
      },
    );

    const first = await service.notifyGroupsCard({
      activityId: "a1",
      groupIds: ["g2", "g1", "g2"],
      card: CARD,
    });
    expect(first).toMatchObject({
      available: true,
      sent: 2,
      skipped: 0,
      failed: 0,
      recipients: 2,
      groups: ["g1", "g2"],
    });
    // 每个群各一条去重行，伪接收者 `group:<群ID>`，kind = full
    await service.flush();
    expect(stored.map((row) => row.userId).sort()).toEqual(["group:g1", "group:g2"]);
    expect(stored.every((row) => row.kind === "full")).toBe(true);
    // 群消息不占用户私信额度，也不发私信
    expect(spy.sent).toEqual([]);

    const second = await service.notifyGroupsCard({
      activityId: "a1",
      groupIds: ["g1", "g2"],
      card: CARD,
    });
    expect(second).toMatchObject({ sent: 0, skipped: 2 });
    expect(groupCards.map((item) => item.groupId)).toEqual(["g1", "g2"]);
  });

  it("reports unavailable when no group sender is wired, and never throws", async () => {
    const spy = createSpySender();
    const service = new ActivityNotificationService(spy.service);
    const result = await service.notifyGroupsCard({
      activityId: "a1",
      groupIds: ["g1"],
      card: CARD,
    });
    expect(result).toMatchObject({ available: false, sent: 0, failed: 0 });
  });

  it("only writes a dedup row for group cards that were actually sent", async () => {
    const spy = createSpySender();
    const stored: Array<{
      activityId: string;
      userId: string;
      kind: string;
      createdAt: Date;
    }> = [];
    const service = new ActivityNotificationService(
      spy.service,
      undefined,
      createMemoryNotificationRepository(stored),
      {
        groupSender: createGroupSender({
          onSend: async (groupId) =>
            groupId === "g1"
              ? { ok: true, detail: "", mode: "markdown" }
              : { ok: false, detail: "failed", mode: "none" },
        }),
      },
    );

    const result = await service.notifyGroupsCard({
      activityId: "a1",
      groupIds: ["g1", "g2"],
      card: CARD,
    });
    expect(result).toMatchObject({ sent: 1, failed: 1, groups: ["g1"] });
    // 失败的群不写去重行：下次重试仍会尝试发送
    await service.flush();
    expect(stored.map((row) => row.userId)).toEqual(["group:g1"]);
    expect(service.isGroupCardSent("a1", "g1")).toBe(true);
    expect(service.isGroupCardSent("a1", "g2")).toBe(false);
  });
});

/** 内存去重表替身（`activity_notifications`）。 */
function createMemoryNotificationRepository(
  stored: Array<{
    activityId: string;
    userId: string;
    kind: string;
    createdAt: Date;
  }>,
): ActivityNotificationRepository {
  return {
    async findAll() {
      return [...stored];
    },
    async save(entry) {
      stored.push(entry);
    },
    async countSince() {
      return 0;
    },
    async deleteOlderThan() {
      stored.length = 0;
    },
  };
}

/** 只实现 `sendToGroup` 的群消息发送器替身（`RichMessageSender` 的最小面）。 */
function createGroupSender(input: {
  onSend: (
    groupId: string,
    message: { markdown: string },
  ) => Promise<{ ok: boolean; detail: string; mode: string }>;
}): RichMessageSender {
  return {
    sendToGroup: (groupId: string, message: { markdown: string }) =>
      input.onSend(groupId, message),
  } as unknown as RichMessageSender;
}
