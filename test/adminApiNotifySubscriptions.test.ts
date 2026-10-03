import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import type { AdminApiBackend } from "../src/adminApi/backend.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { NOTIFY_SCOPE_ALL } from "../src/services/notifyTopics.js";
import { NotificationService } from "../src/services/notifications.js";
import { PermissionService } from "../src/services/permissions.js";

/**
 * 管理后台「订阅关系只读」（`GET /api/notify/subscriptions`，平台超管 240）。
 *
 * 回答「我说了怎么没通知」的另一半：**他到底订没订、订的哪个范围、现在够不够门槛**。
 * 关键口径：
 * - 判据与推送**同一份**（`NotificationService.checkTopicReach`）—— 订阅了但角色掉下来，
 *   这里会如实写「收不到 + 原因」，而不是假装一切正常；
 * - **只读**：不改任何人的订阅（改仍在机器人里用 `/notify`）；
 * - 计数始终按全部订阅行算（不受筛选影响），与 `/api/notify/topics` 那一列同口径。
 */
interface Harness {
  backend: AdminApiBackend;
  notifications: NotificationService;
  permissions: PermissionService;
}

function harness(options: { withNotifications?: boolean } = {}): Harness {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const permissions = new PermissionService({ superAdminIds: new Set(["boss"]) });
  // join 的默认门槛是**群管理员 130**（不是审核员 120）：mod 要给成群管理员才算「收得到」
  permissions.grantGroupAdmin("g1", "mod");
  const notifications = new NotificationService(api, permissions);
  // mod 有 g1 群管理员（join 门槛 130 ✓）；u1 什么角色都没有（两条都收不到）；
  // boss 是全局超管（bot_join 门槛 240 ✓）
  notifications.subscribe("mod", "g1", "join");
  notifications.subscribe("u1", "g1", "join");
  notifications.subscribe("u1", NOTIFY_SCOPE_ALL, "punish");
  notifications.subscribe("boss", NOTIFY_SCOPE_ALL, "bot_join");
  const backend = createAdminApiBackend({
    permissions,
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({
      profiles: { get: () => undefined },
    }),
    ...(options.withNotifications === false ? {} : { notifications }),
    mode: "fake",
  });
  return { backend, notifications, permissions };
}

describe("管理 API 订阅关系只读：谁订了什么 + 现在还够不够门槛", () => {
  it("列出全部订阅行（排序稳定），资格与推送同一份判据", async () => {
    const h = harness();

    const view = await h.backend.notifySubscriptions({});

    expect(view.total).toBe(4);
    // 排序：话题 → 用户 → 范围（分页不会跳）
    expect(
      view.items.map((item) => `${item.topic}:${item.userId}:${item.scope}`),
    ).toEqual([
      "bot_join:boss:all",
      "join:mod:group",
      "join:u1:group",
      "punish:u1:all",
    ]);

    const mod = view.items.find((item) => item.userId === "mod");
    expect(mod).toMatchObject({
      topic: "join",
      topicLabel: "入群申请",
      scope: "group",
      groupId: "g1",
      eligible: true,
      reason: "",
    });
    expect(mod?.user.officialId).toBe("mod");
    expect(mod?.group?.officialId).toBe("g1");

    // 订阅还在、但角色不够 → 明确写「收不到」+ 原因（与推送跳过他的原因同一句）
    const u1Join = view.items.find(
      (item) => item.userId === "u1" && item.topic === "join",
    );
    expect(u1Join?.eligible).toBe(false);
    expect(u1Join?.reason).toContain("入群申请推送只发给群管理员及以上");
    // 「全部群」范围不返回 groupId / group（不是某个群）
    const u1Punish = view.items.find(
      (item) => item.userId === "u1" && item.topic === "punish",
    );
    expect(u1Punish?.scope).toBe("all");
    expect(u1Punish?.groupId).toBeUndefined();
    expect(u1Punish?.eligible).toBe(false);
    expect(u1Punish?.reason).toContain("处罚与申诉推送只发给审核员及以上");

    // 计数与 /api/notify/topics 同一口径（始终按全部行算）
    const join = view.counts.find((topic) => topic.topic === "join");
    expect(join).toMatchObject({ groupScopes: 2, allScope: 0 });
    const botJoin = view.counts.find((topic) => topic.topic === "bot_join");
    expect(botJoin).toMatchObject({ allScope: 1, groupScopes: 0 });
  });

  it("筛选：话题 / 范围 / 成员 / 只看收不到的（计数不受筛选影响）", async () => {
    const h = harness();

    expect((await h.backend.notifySubscriptions({ topic: "join" })).total).toBe(2);
    expect(
      (await h.backend.notifySubscriptions({ group: NOTIFY_SCOPE_ALL })).total,
    ).toBe(2);
    expect((await h.backend.notifySubscriptions({ userId: "u1" })).total).toBe(2);

    const ineligible = await h.backend.notifySubscriptions({
      ineligibleOnly: true,
    });
    expect(ineligible.total).toBe(2);
    expect(ineligible.items.every((item) => !item.eligible)).toBe(true);

    const both = await h.backend.notifySubscriptions({
      topic: "join",
      ineligibleOnly: true,
    });
    expect(both.total).toBe(1);
    expect(both.items[0]?.userId).toBe("u1");
    // 计数按全部行算：筛选后仍是 2 条按群订阅
    expect(
      both.counts.find((topic) => topic.topic === "join")?.groupScopes,
    ).toBe(2);
  });

  it("未知话题 400（列出可用值）、推送服务未装配 503", async () => {
    const h = harness();

    const unknown = await h.backend
      .notifySubscriptions({ topic: "nope" })
      .catch((thrown: unknown) => thrown);
    expect(unknown).toBeInstanceOf(AdminApiRequestError);
    expect((unknown as AdminApiRequestError).statusCode).toBe(400);
    expect((unknown as AdminApiRequestError).message).toContain("未知话题");

    const bare = harness({ withNotifications: false });
    const unavailable = await bare.backend
      .notifySubscriptions({})
      .catch((thrown: unknown) => thrown);
    expect((unavailable as AdminApiRequestError).statusCode).toBe(503);
    expect((unavailable as AdminApiRequestError).errorCode).toBe("unavailable");
  });
});
