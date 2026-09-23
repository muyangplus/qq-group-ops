import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { NotificationDeliveryStatus } from "../src/core/enums.js";
import type {
  NotificationDelivery,
  NotificationDeliveryRepository,
  NotificationSubscription,
  NotificationSubscriptionRepository,
} from "../src/db/notificationRepository.js";
import { GroupConfigStore, DEFAULT_GROUP_ID } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinRuleEvaluator } from "../src/services/joinRules.js";
import {
  NotificationService,
  NOTIFY_SCOPE_ALL,
} from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";

class FakeSubscriptionRepository implements NotificationSubscriptionRepository {
  public readonly rows = new Map<string, NotificationSubscription>();

  public async findAll(): Promise<NotificationSubscription[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  public async save(subscription: NotificationSubscription): Promise<void> {
    this.rows.set(key(subscription.userId, subscription.scope), {
      ...subscription,
    });
  }

  public async remove(userId: string, scope: string): Promise<void> {
    this.rows.delete(key(userId, scope));
  }
}

class FakeDeliveryRepository implements NotificationDeliveryRepository {
  public readonly rows = new Map<string, NotificationDelivery>();
  public readonly deletedCutoffs: Date[] = [];

  public async findAll(): Promise<NotificationDelivery[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  public async save(delivery: NotificationDelivery): Promise<void> {
    this.rows.set(key(delivery.groupId, delivery.requestId, delivery.userId), {
      ...delivery,
    });
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    this.deletedCutoffs.push(cutoff);
    for (const [rowKey, delivery] of this.rows) {
      if (delivery.createdAt < cutoff) {
        this.rows.delete(rowKey);
      }
    }
  }
}

function key(...parts: string[]): string {
  return parts.join("\u0000");
}

interface Harness {
  api: FakeQQOfficialAPI;
  permissions: PermissionService;
  notifications: NotificationService;
  subscriptions: FakeSubscriptionRepository;
  deliveries: FakeDeliveryRepository;
  identityMap: IdentityMapService;
  configStore: GroupConfigStore;
}

async function createHarness(
  now: () => Date = () => new Date("2026-06-01T00:00:00.000Z"),
): Promise<Harness> {
  const api = new FakeQQOfficialAPI();
  const permissions = new PermissionService({
    superAdminIds: new Set(["root"]),
    groupAdminIds: new Map([["g1", new Set(["admin", "admin2"])]]),
    moderatorIds: new Map([["g1", new Set(["mod"])]]),
  });
  const subscriptions = new FakeSubscriptionRepository();
  const deliveries = new FakeDeliveryRepository();
  const identityMap = new IdentityMapService();
  await identityMap.bindGroup("g1", "654321");
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const notifications = new NotificationService(api, permissions, {
    subscriptions,
    deliveries,
    identityMap,
    configStore,
    joinRules: new JoinRuleEvaluator(),
    now,
  });
  return {
    api,
    permissions,
    notifications,
    subscriptions,
    deliveries,
    identityMap,
    configStore,
  };
}

const PUSH = {
  groupId: "g1",
  requestId: "r1",
  userId: "u1",
  reason: "想加入",
};

describe("NotificationService", () => {
  it("pushes a card with quick approve/reject buttons to subscribers", async () => {
    const { api, notifications, deliveries } = await createHarness();
    notifications.subscribe("admin", "g1");

    const result = await notifications.notifyJoinRequest(PUSH);
    await notifications.flush();

    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0, recipients: 1 });
    expect(api.sentPrivateMessages).toHaveLength(1);
    const message = api.sentPrivateMessages[0]!;
    expect(message.userOpenid).toBe("admin");
    expect(message.markdown).toContain("新的入群申请");
    const buttons = (
      message.keyboard as {
        content: { rows: Array<{ buttons: Array<{ action: { data: string; permission: unknown } }> }> };
      }
    ).content.rows[0]!.buttons;
    expect(buttons[0]!.action.data).toBe("/approve g1 r1");
    expect(buttons[1]!.action.data).toBe("/reject g1 r1 审核未通过");
    expect(buttons[0]!.action.permission).toEqual({
      type: 0,
      specifyUserIds: ["admin"],
    });
    expect(deliveries.rows.size).toBe(1);
    expect([...deliveries.rows.values()][0]?.status).toBe(
      NotificationDeliveryStatus.Sent,
    );
  });

  it("uses the bound group number and the rule-engine opinion in the card", async () => {
    const { api, notifications, configStore } = await createHarness();
    configStore.setOverride({ groupId: "g1", joinRequireClass: true });
    notifications.subscribe("admin", "g1");

    await notifications.notifyJoinRequest({ ...PUSH, reason: "张三" });

    const message = api.sentPrivateMessages[0]!;
    expect(message.markdown).toContain("654321（g1）");
    expect(message.markdown).toContain("配置问题：班级库未加载");
    expect(message.markdown).toContain("建议：人工核实");
  });

  it("filters recipients by approve permission in the target group", async () => {
    const { api, notifications } = await createHarness();
    notifications.subscribe("mod", "g1"); // 审核员没有审批权限
    notifications.subscribe("admin", NOTIFY_SCOPE_ALL);

    const result = await notifications.notifyJoinRequest(PUSH);

    expect(result.recipients).toBe(1);
    expect(api.sentPrivateMessages.map((message) => message.userOpenid)).toEqual([
      "admin",
    ]);
  });

  it("does not leak requests to a subscriber of another group even with scope all", async () => {
    const { notifications } = await createHarness();
    // admin 只有 g1 的权限，g2 的申请不该推给他
    notifications.subscribe("admin", NOTIFY_SCOPE_ALL);
    expect(notifications.subscribersFor("g2")).toEqual([]);
    expect(notifications.subscribersFor("g1")).toEqual(["admin"]);
  });

  it("never pushes the same request to the same user twice", async () => {
    const { api, notifications } = await createHarness();
    notifications.subscribe("admin", "g1");

    const first = await notifications.notifyJoinRequest(PUSH);
    const second = await notifications.notifyJoinRequest(PUSH);

    expect(first.sent).toBe(1);
    expect(second).toEqual({ sent: 0, failed: 0, skipped: 1, recipients: 1 });
    expect(api.sentPrivateMessages).toHaveLength(1);
  });

  it("downgrades to markdown-only when the platform rejects custom buttons", async () => {
    const { api, notifications } = await createHarness();
    api.failPrivateKeyboardMessages = true;
    notifications.subscribe("admin", "g1");

    const result = await notifications.notifyJoinRequest(PUSH);

    expect(result.sent).toBe(1);
    expect(notifications.keyboardAvailable).toBe(false);
    expect(api.sentPrivateMessages[0]?.keyboard).toBeUndefined();
    expect(api.sentPrivateMessages[0]?.markdown).toContain("新的入群申请");

    // 后续推送不再尝试按钮
    await notifications.notifyJoinRequest({ ...PUSH, requestId: "r2" });
    expect(api.sentPrivateMessages).toHaveLength(2);
    expect(api.sentPrivateMessages[1]?.keyboard).toBeUndefined();
  });

  it("falls back to plain text when markdown is rejected", async () => {
    const { api, notifications } = await createHarness();
    api.failPrivateRichMessages = true;
    notifications.subscribe("admin", "g1");

    const result = await notifications.notifyJoinRequest(PUSH);

    expect(result.sent).toBe(1);
    expect(api.sentPrivateMessages[0]?.markdown).toBeUndefined();
    expect(api.sentPrivateMessages[0]?.content).toContain("【新的入群申请】");
    expect(api.sentPrivateMessages[0]?.content).toContain("同意：/approve g1 r1");
  });

  it("records a failed delivery when every attempt fails", async () => {
    const { api, notifications, deliveries } = await createHarness();
    api.failPrivateMessages = true;
    notifications.subscribe("admin", "g1");

    const result = await notifications.notifyJoinRequest(PUSH);

    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0, recipients: 1 });
    expect([...deliveries.rows.values()][0]?.status).toBe(
      NotificationDeliveryStatus.Failed,
    );
  });

  it("restores subscriptions and delivery de-duplication from the database", async () => {
    const subscriptions = new FakeSubscriptionRepository();
    const deliveries = new FakeDeliveryRepository();
    const first = await createHarnessWith(subscriptions, deliveries);
    first.notifications.subscribe("admin", "g1");
    await first.notifications.notifyJoinRequest(PUSH);
    await first.notifications.flush();

    const second = await createHarnessWith(subscriptions, deliveries);
    await second.notifications.load();
    expect(second.notifications.listScopes("admin")).toEqual(["g1"]);

    const result = await second.notifications.notifyJoinRequest(PUSH);
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, recipients: 1 });
    expect(second.api.sentPrivateMessages).toHaveLength(0);
  });

  it("prunes old delivery records so retention can clean them up", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const { notifications, deliveries } = await createHarness(() => now);
    notifications.subscribe("admin", "g1");
    await notifications.notifyJoinRequest(PUSH);
    await notifications.flush();
    expect(deliveries.rows.size).toBe(1);

    now = new Date("2026-08-01T00:00:00.000Z");
    const removed = await notifications.pruneDeliveredOlderThan(
      new Date("2026-07-01T00:00:00.000Z"),
    );
    await notifications.flush();

    expect(removed).toBe(1);
    expect(deliveries.rows.size).toBe(0);
    expect(deliveries.deletedCutoffs).toHaveLength(1);
  });

  it("sends a test card whose button opens /pending", async () => {
    const { api, notifications } = await createHarness();
    notifications.subscribe("admin", "g1");

    const result = await notifications.sendTestCard("admin");

    expect(result.ok).toBe(true);
    expect(api.sentPrivateMessages[0]?.markdown).toContain("推送测试");
    const buttons = (
      api.sentPrivateMessages[0]?.keyboard as {
        content: { rows: Array<{ buttons: Array<{ action: { data: string } }> }> };
      }
    ).content.rows[0]!.buttons;
    expect(buttons[0]!.action.data).toBe("/pending g1");
  });

  it("refuses a test card when the user has no reviewable group", async () => {
    const { notifications } = await createHarness();
    const result = await notifications.sendTestCard("stranger");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有可审批的群");
  });

  it("unsubscribes and remembers the state", async () => {
    const { notifications } = await createHarness();
    notifications.subscribe("admin", "g1");
    expect(notifications.unsubscribe("admin", "g1")).toBe(true);
    expect(notifications.unsubscribe("admin", "g1")).toBe(false);
    expect(notifications.listScopes("admin")).toEqual([]);
  });
});

async function createHarnessWith(
  subscriptions: FakeSubscriptionRepository,
  deliveries: FakeDeliveryRepository,
): Promise<Harness> {
  const api = new FakeQQOfficialAPI();
  const permissions = new PermissionService({
    groupAdminIds: new Map([["g1", new Set(["admin"])]]),
  });
  const identityMap = new IdentityMapService();
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const notifications = new NotificationService(api, permissions, {
    subscriptions,
    deliveries,
    identityMap,
    configStore,
  });
  return {
    api,
    permissions,
    notifications,
    subscriptions,
    deliveries,
    identityMap,
    configStore,
  };
}
