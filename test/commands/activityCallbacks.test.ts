import { stubCanvasModule } from "../helpers/canvasStub.js";
import { FakeActivityNotificationRepository } from "../helpers/fakeActivityNotificationRepository.js";
import { FakeQQOfficialAPI } from "../../src/adapters/fakeQqOfficial.js";
import { ActivityService } from "../../src/services/activity.js";
import { ActivityCardService } from "../../src/services/activityCards.js";
import { ActivityExportService } from "../../src/services/activityExport.js";
import { ActivityNotificationService } from "../../src/services/activityNotifications.js";
import {
  ActivityStatsService,
  SYSTEM_FONT_PATHS,
} from "../../src/services/activityStats.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import { AuditLogStore } from "../../src/services/audit.js";
import { DisplayNameService } from "../../src/services/displayNames.js";
import { GroupConfigStore } from "../../src/services/groupConfig.js";
import { IdentityMapService } from "../../src/services/identityMap.js";
import { JoinApprovalService } from "../../src/services/joinApproval.js";
import { JoinAuditService } from "../../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../../src/services/joinAuditSync.js";
import { MemberRoster } from "../../src/services/memberRoster.js";
import { NotificationService } from "../../src/services/notifications.js";
import { PermissionService } from "../../src/services/permissions.js";
import { RichMessageSender } from "../../src/services/richMessages.js";
import { ShortCodeService } from "../../src/services/shortCodes.js";
import { UserProfileService } from "../../src/services/userProfiles.js";
import {
  describe,
  expect,
  it,
  beforeEach,
} from "vitest";

/**
 * 活动卡回调（§B2/§B4）：报名、候补、满员广播、静默私信
 */

describe("activity card callbacks (§B2)", async () => {
  let activity: ActivityService;
  let activityNotifications: ActivityNotificationService;
  let activityCards: ActivityCardService;
  let codes: string[];
  /** §B4 满员广播的去重行（内存仓储替身，断言 `group:<群ID>` 伪接收者）。 */
  let notificationRepo: FakeActivityNotificationRepository;

  function makeActivityService(): ActivityService {
    codes = ["ACT001", "ACT002", "ACT003"];
    return new ActivityService(undefined, undefined, undefined, {
      generateCode: () => codes.shift() ?? "ACT999",
    });
  }

  let api: FakeQQOfficialAPI;
  let identityMap: IdentityMapService;
  let permissions: PermissionService;
  let configStore: GroupConfigStore;
  let auditLog: AuditLogStore;
  let joinAudit: JoinAuditService;
  let joinApproval: JoinApprovalService;
  let joinSync: JoinRequestSyncService;

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    auditLog = new AuditLogStore();
    permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      moderatorIds: new Map([["g1", new Set(["mod"])]]),
    });
    joinAudit = new JoinAuditService(auditLog);
    configStore = new GroupConfigStore({ groupId: "__default__" });
    identityMap = new IdentityMapService();
    identityMap.bindUser("member", "10001");
    identityMap.bindUser("mod", "10002");
    identityMap.bindUser("admin", "10003");
    identityMap.bindUser("root", "10004");
    identityMap.bindUser("u3", "10005");
    identityMap.bindUser("u4", "10006");
    identityMap.bindGroup("g1", "654321");
    joinApproval = new JoinApprovalService(api, joinAudit, configStore);
    joinSync = new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 });
  });

  /** 装配活动相关服务（个人资料 / 班级库 / 通知）。 */
  function withActivity(): {
    svc: AdminCommandService;
    profiles: UserProfileService;
    sender: RichMessageSender;
  } {
    const shortCodes = new ShortCodeService();
    const notifier = new NotificationService(api, permissions, {
      identityMap,
      configStore,
      sender: new RichMessageSender(api),
    });
    const roster = MemberRoster.fromIndex({
      classes: ["材化2211", "环工2314"],
      majors: ["材料化学", "环境工程"],
      classInfo: {
        材化2211: {
          major: "材料化学",
          college: "化学与生命科学学院",
          year: "2022",
        },
        环工2314: {
          major: "环境工程",
          college: "环境科学与工程学院",
          year: "2023",
        },
      },
    });
    const profiles = new UserProfileService();
    profiles.setRoster(roster);
    activity = makeActivityService();
    notificationRepo = new FakeActivityNotificationRepository();
    const sender = new RichMessageSender(api);
    activityNotifications = new ActivityNotificationService(
      notifier,
      undefined,
      notificationRepo,
      {
        dailyLimit: 0,
        // 满员广播是群消息：复用富消息发送器（不占用户私信额度）
        groupSender: sender,
      },
    );
    activityCards = new ActivityCardService({
      activity,
      display: new DisplayNameService(identityMap, shortCodes),
      profiles,
      roster,
      groupLabel: (groupId) => identityMap.getGroupNumber(groupId) ?? groupId,
      isSubscribed: (groupId, userId) =>
        activityNotifications.isSubscribed(groupId, userId),
    });
    const svc = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval,
      joinSync,
      auditLog,
      identityMap,
      notifications: notifier,
      display: new DisplayNameService(identityMap, shortCodes),
      userProfiles: profiles,
      activity,
      activityCards,
      activityNotifications,
      richMessages: sender,
      cardSender: sender,
    });
    return { svc, profiles, sender };
  }

  async function setupOpenActivity(
    svc: AdminCommandService,
    options: {
      capacity?: number;
      waitlistPromotion?: "auto" | "manual";
      allowYears?: readonly string[];
    } = {},
  ): Promise<Activity> {
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    if (options.capacity !== undefined) {
      await svc.handle("g1", "admin", `/activity set #ACT001 capacity ${options.capacity}`);
    }
    if (options.allowYears !== undefined) {
      await svc.handle(
        "g1",
        "admin",
        `/activity set #ACT001 allowYears ${options.allowYears.join(",")}`,
      );
    }
    if (options.waitlistPromotion === "auto") {
      await svc.handle("g1", "admin", "/activity set #ACT001 waitlistPromotion auto");
    }
    await svc.handle("g1", "admin", "/activity open #ACT001");
    return activity.requireByCode("#ACT001");
  }

  it("renders the config card with callbacks and command buttons", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    const config = await svc.activityCallbackCard("config", ["#ACT001"], "admin", "g1");
    expect(config.ok).toBe(true);
    const buttons = (
      config.rich.keyboard as {
        content: {
          rows: Array<{
            buttons: Array<{
              id: string;
              label: string;
              action: { type: number; data: string; modal?: unknown };
            }>;
          }>;
        };
      }
    ).content.rows.flatMap((row) => row.buttons);
    const capacity = buttons.find((button) => button.id === "capacity-20");
    expect(capacity?.action).toMatchObject({
      type: 1,
      data: "cb:activity:set:#ACT001:capacity:20",
    });
    const custom = buttons.find((button) => button.id === "capacity-custom");
    expect(custom?.action).toMatchObject({
      type: 2,
      data: "/activity set #ACT001 capacity ",
    });
    const customClose = buttons.find((button) => button.id === "closeAt-custom");
    expect(customClose?.action.type).toBe(2);
    expect(buttons.find((button) => button.id === "college")?.action.data).toBe(
      "cb:activity:college:#ACT001:allow:1",
    );
    expect(buttons.find((button) => button.id === "open")?.action.modal).toBeDefined();
    expect(buttons.find((button) => button.id === "cancel")?.action.modal).toBeDefined();

    // 越权：普通成员调用配置回调 → 权限不足卡
    const denied = await svc.activityCallbackCard("config", ["#ACT001"], "member", "g1");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
  });

  it("returns an 'activity not found' card for a bad short code", async () => {
    const { svc } = withActivity();
    const missing = await svc.activityCallbackCard("info", ["#NOPE00"], "admin", "g1");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("活动不存在");
  });

  it("silently DMs the receipt for a group join callback", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 2, waitlistPromotion: "auto" });
    profiles.set("member", "name", "小明");
    profiles.set("member", "studentId", "22123456789");
    profiles.set("member", "className", "材化2211");

    const groupMessagesBeforeJoin = api.sentMessages.length;
    const joined = await svc.activityCallbackCard("join", ["#ACT001"], "member", "g1");
    // §B4：群里不发任何消息（renderer 拿到 undefined → 只回包）
    expect(joined).toBeUndefined();
    expect(api.sentMessages).toHaveLength(groupMessagesBeforeJoin);
    // 结果只私信：可以带姓名 / 学号 / 班级 / 人数
    const privateMessages = api.sentPrivateMessages
      .filter((item) => item.userOpenid === "member")
      .map((item) => String(item.markdown ?? ""));
    expect(privateMessages.join("\n")).toContain("报名成功");
    expect(privateMessages.join("\n")).toContain("当前 1 / 2");
    expect(privateMessages.join("\n")).toContain("小明");
    expect(privateMessages.join("\n")).toContain("22123456789");
    expect(privateMessages.join("\n")).toContain("材化2211");
    expect(privateMessages.join("\n")).not.toContain("<@!member>");

    // 重复报名：群里同样静默，具体原因走私信
    const duplicate = await svc.activityCallbackCard("join", ["#ACT001"], "member", "g1");
    expect(duplicate).toBeUndefined();
    expect(api.sentMessages).toHaveLength(groupMessagesBeforeJoin);
    const dm = api.sentPrivateMessages.at(-1);
    expect(String(dm?.markdown ?? "")).toContain("已经报名");
  });

  it("private-replies the full receipt when joining via DM", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 2 });
    profiles.set("member", "name", "小明");
    profiles.set("member", "studentId", "22123456789");
    profiles.set("member", "className", "材化2211");
    const joined = await svc.activityCallbackCard("join", ["#ACT001"], "member", undefined);
    expect(joined?.ok).toBe(true);
    expect(joined?.text).toContain("小明");
    expect(joined?.text).toContain("22123456789");
    expect(joined?.text).toContain("材化2211");
    expect(joined?.text).not.toContain("<@!");
  });

  it("sends the failure reason as a DM and stays silent in the group", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 2, allowYears: ["22"] });
    profiles.set("other", "name", "小红");
    profiles.set("other", "studentId", "23123456789");
    profiles.set("other", "className", "环工2314");

    const groupMessagesBeforeJoin = api.sentMessages.length;
    const result = await svc.activityCallbackCard("join", ["#ACT001"], "other", "g1");
    // §B4：群里连「原因已私信」都不发
    expect(result).toBeUndefined();
    expect(api.sentMessages).toHaveLength(groupMessagesBeforeJoin);
    const dm = String(api.sentPrivateMessages.at(-1)?.markdown ?? "");
    expect(dm).toContain("仅限");
    expect(dm).not.toContain("<@!other>");
  });

  it("reports a waitlist position when the activity is full", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 1, waitlistPromotion: "auto" });
    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    profiles.set("u4", "name", "同学乙");
    profiles.set("u4", "studentId", "22123456780");
    profiles.set("u4", "className", "材化2211");

    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");
    const waitlisted = await svc.activityCallbackCard("join", ["#ACT001"], "u4", "g1");
    // 群内静默：候补回执只私信
    expect(waitlisted).toBeUndefined();
    const dm = String(
      api.sentPrivateMessages
        .filter((item) => item.userOpenid === "u4")
        .map((item) => String(item.markdown ?? ""))
        .join("\n"),
    );
    expect(dm).toContain("已进入候补 · 第 1 位");
    expect(dm).toContain("同学乙");
  });

  it("freezes the slot on quit, then promotes on release", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 1 });
    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    profiles.set("u4", "name", "同学乙");
    profiles.set("u4", "studentId", "22123456780");
    profiles.set("u4", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");
    await svc.activityCallbackCard("join", ["#ACT001"], "u4", "g1");

    const quit = await svc.activityCallbackCard("quit", ["#ACT001"], "u3", "g1");
    // §B4：取消报名也在群内静默，回执只私信
    expect(quit).toBeUndefined();
    const quitDm = String(
      api.sentPrivateMessages
        .filter((item) => item.userOpenid === "u3")
        .map((item) => String(item.markdown ?? ""))
        .join("\n"),
    );
    expect(quitDm).toContain("待释放名额 1");

    // 管理卡出现「释放名额」按钮
    const manage = await svc.activityCallbackCard("manage", ["#ACT001"], "admin", "g1");
    expect(manage?.text).toContain("**待释放名额**：1");
    const manageButtons = (
      manage?.rich.keyboard as {
        content: { rows: Array<{ buttons: Array<{ id: string }> }> };
      }
    ).content.rows.flatMap((row) => row.buttons);
    expect(manageButtons.some((button) => button.id === "release")).toBe(true);

    const released = await svc.activityCallbackCard("release", ["#ACT001"], "admin", "g1");
    expect(released?.ok).toBe(true);
    expect(released?.text).toContain("递补候补第一位");
    // 被递补者收到私信（不往群里发）
    const dm = String(api.sentPrivateMessages.at(-1)?.markdown ?? "");
    expect(dm).toContain("你已递补成功");

    // 非管理者调用释放回调 → 被拒
    const denied = await svc.activityCallbackCard("release", ["#ACT001"], "member", "g1");
    expect(denied?.ok).toBe(false);
    expect(denied?.text).toContain("权限不足");
  });

  it("automatically promotes the next waitlist entry in auto mode", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 1, waitlistPromotion: "auto" });
    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    profiles.set("u4", "name", "同学乙");
    profiles.set("u4", "studentId", "22123456780");
    profiles.set("u4", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");
    await svc.activityCallbackCard("join", ["#ACT001"], "u4", "g1");

    const quit = await svc.activityCallbackCard("quit", ["#ACT001"], "u3", "g1");
    // 群内静默：quit 只私信，递补通知也走私信
    expect(quit).toBeUndefined();
    const quitDm = String(
      api.sentPrivateMessages
        .filter((item) => item.userOpenid === "u3")
        .map((item) => String(item.markdown ?? ""))
        .join("\n"),
    );
    expect(quitDm).toContain("已取消报名");
    const promotionDm = String(
      api.sentPrivateMessages
        .filter((item) => item.userOpenid === "u4")
        .map((item) => String(item.markdown ?? ""))
        .join("\n"),
    );
    expect(promotionDm).toContain("你已递补成功");
    // auto 模式不会冻结名额
    expect(quitDm).not.toContain("待释放");
  });

  it("paginates the signup list with data redacted by default", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 20 });
    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");

    const page1 = await svc.activityCallbackCard("signups", ["#ACT001", "1"], "admin", "g1");
    expect(page1.ok).toBe(true);
    expect(page1.text).toContain("同学甲（材化2211）");
    expect(page1.text).not.toContain("22123456789");
    expect(page1.text).toContain("默认（不含学号 / 学院）");

    const full = await svc.activityCallbackCard(
      "signups",
      ["#ACT001", "1", "full"],
      "admin",
      "g1",
    );
    expect(full.ok).toBe(true);
    expect(full.text).toContain("22123456789");
    expect(full.text).toContain("完整信息（含学号 / 学院）");

    // 非管理者看到「权限不足」，即使拿到了按钮
    const denied = await svc.activityCallbackCard("signups", ["#ACT001", "1"], "member", "g1");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
  });

  it("toggles the per-group subscription from the callback", async () => {
    const { svc } = withActivity();
    const on = await svc.activityCallbackCard("subscribe", ["g1", "on"], "member", "g1");
    expect(on.ok).toBe(true);
    expect(on.text).toContain("订阅状态");
    expect(activityNotifications.isSubscribed("g1", "member")).toBe(true);
    // 按钮标签只在富消息里（纯文本降级不给回调按钮文案）
    const toggle = (
      on.rich.keyboard as {
        content: { rows: Array<{ buttons: Array<{ id: string; label: string }> }> };
      }
    ).content.rows.flatMap((row) => row.buttons).find((button) => button.id === "toggle");
    expect(toggle?.label).toBe("订阅 开");

    const off = await svc.activityCallbackCard("subscribe", ["g1", "off"], "member", "g1");
    expect(off.ok).toBe(true);
    expect(activityNotifications.isSubscribed("g1", "member")).toBe(false);
  });

  it("pushes the activity card to subscribers when published", async () => {
    const { svc } = withActivity();
    activityNotifications.subscribe("g1", "member");
    const created = await svc.handle("g1", "admin", "/activity create 迎新晚会");
    expect(created.ok).toBe(true);
    const opened = await svc.handle("g1", "admin", "/activity open #ACT001");
    expect(opened.ok).toBe(true);
    // 群里收到成员卡（作为最后一条群消息）
    const groupCard = api.sentMessages.at(-1);
    expect(groupCard?.groupId).toBe("g1");
    expect(String(groupCard?.markdown ?? "")).toContain("迎新晚会");
    // 订阅者收到私信
    const dm = api.sentPrivateMessages.filter((item) => item.userOpenid === "member");
    expect(dm.length).toBeGreaterThanOrEqual(1);
    // 群里也给出发布回执（§B4：发布到所有绑定群）
    expect(opened.text).toContain("活动卡片已发送到 1 个绑定群");
  });

  it("tells the operator that @everyone is impossible when mentionAll is on", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    await svc.handle("g1", "admin", "/activity set #ACT001 mentionAll on");
    const opened = await svc.handle("g1", "admin", "/activity open #ACT001");
    expect(opened.ok).toBe(true);

    const receipt = api.sentPrivateMessages
      .filter((item) => item.userOpenid === "admin")
      .map((item) => String(item.markdown ?? ""))
      .join("\n");
    expect(receipt).toContain("无法 @全体成员");
    expect(receipt).toContain("手动 @ 一条");
    // 不得假装能 @：卡片正文里不会有 @everyone / <@!all>
    const groupCard = String(api.sentMessages.at(-1)?.markdown ?? "");
    expect(groupCard).not.toContain("@everyone");
    expect(groupCard).not.toContain("<@!all>");
  });

  it("notifies participants when the activity changes", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 5 });
    profiles.set("member", "name", "小明");
    profiles.set("member", "studentId", "22123456789");
    profiles.set("member", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "member", "g1");

    const updated = await svc.activityCallbackCard(
      "set",
      ["#ACT001", "capacity", "8"],
      "admin",
      "g1",
    );
    expect(updated.ok).toBe(true);
    const dm = api.sentPrivateMessages.filter((item) => item.userOpenid === "member");
    const changed = dm.filter((item) => String(item.markdown ?? "").includes("有变更"));
    expect(changed.length).toBeGreaterThanOrEqual(1);
  });

  it("cancels the activity and DMs every participant", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 5 });
    profiles.set("member", "name", "小明");
    profiles.set("member", "studentId", "22123456789");
    profiles.set("member", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "member", "g1");

    const cancelled = await svc.activityCallbackCard("cancel", ["#ACT001"], "admin", "g1");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.text).toContain("已取消活动");
    const dm = api.sentPrivateMessages.filter((item) => item.userOpenid === "member");
    expect(
      dm.some((item) => String(item.markdown ?? "").includes("已取消")),
    ).toBe(true);
  });

  it("hides the manage / release / export callbacks from non-managers", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    for (const action of ["manage", "resend", "stats", "export", "release"]) {
      const denied = await svc.activityCallbackCard(action, ["#ACT001"], "member", "g1");
      expect(denied.ok).toBe(false);
      expect(denied.text).toContain("权限不足");
    }
  });

  it("tells the operator to fall back when canvas is missing", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    svc.setActivityExtras({
      stats: new ActivityStatsService({
        hasSystemFont: () => false,
        readFontFile: () => undefined,
        fontUrl: "",
        canvasLoader: async () => {
          throw new Error("optional dependency missing");
        },
      }),
    });

    const denied = await svc.activityCallbackCard("stats", ["#ACT001"], "member", "g1");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    const stats = await svc.activityCallbackCard("stats", ["#ACT001"], "admin", "g1");
    expect(stats.ok).toBe(true);
    expect(stats.text).toContain("文字统计");
    expect(api.uploadedGroupImages).toEqual([]);
  });

  it("sends the stats image when §B3 is wired", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    svc.setActivityExtras({
      stats: new ActivityStatsService({
        api,
        hasSystemFont: (path) => path === SYSTEM_FONT_PATHS[0],
        canvasLoader: async () => stubCanvasModule(),
      }),
    });

    const manage = await svc.activityCallbackCard("manage", ["#ACT001"], "admin", "g1");
    const buttons = (
      manage.rich.keyboard as {
        content: { rows: Array<{ buttons: Array<{ id: string; action: { data: string } }> }> };
      }
    ).content.rows.flatMap((row) => row.buttons);
    expect(buttons.find((button) => button.id === "stats")?.action.data).toBe(
      "cb:activity:stats:#ACT001",
    );

    const stats = await svc.activityCallbackCard("stats", ["#ACT001"], "admin", "g1");
    expect(stats.ok).toBe(true);
    expect(stats.text).toContain("已发送统计图片");
    expect(api.uploadedGroupImages).toHaveLength(1);
    expect(api.uploadedGroupImages[0]?.[0]).toBe("g1");
    expect(api.uploadedGroupImages[0]?.[1]).toBe("activity-ACT001.png");
    expect(api.sentGroupImages).toHaveLength(1);
  });

  it("falls back to the text stats card when the image upload fails", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    svc.setActivityExtras({
      stats: new ActivityStatsService({
        api,
        hasSystemFont: (path) => path === SYSTEM_FONT_PATHS[0],
        canvasLoader: async () => stubCanvasModule(),
      }),
    });
    api.failGroupImages = true;

    const stats = await svc.activityCallbackCard("stats", ["#ACT001"], "admin", "g1");
    expect(stats.ok).toBe(true);
    expect(stats.text).toContain("文字统计");
    expect(api.sentGroupImages).toEqual([]);
  });

  it("DMs the CSV export to the operator with a waitlist flag", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 1 });
    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");
    await svc.activityCallbackCard("join", ["#ACT001"], "member", "g1");

    svc.setActivityExtras({
      exportService: new ActivityExportService({
        sender: new RichMessageSender(api),
        profiles,
      }),
    });

    const signups = await svc.activityCallbackCard("signups", ["#ACT001", "1"], "admin", "g1");
    const buttons = (
      signups.rich.keyboard as {
        content: { rows: Array<{ buttons: Array<{ id: string; action: { data: string } }> }> };
      }
    ).content.rows.flatMap((row) => row.buttons);
    expect(buttons.find((button) => button.id === "export")?.action.data).toBe(
      "cb:activity:export:#ACT001",
    );

    const exported = await svc.activityCallbackCard("export", ["#ACT001"], "admin", "g1");
    expect(exported.ok).toBe(true);
    expect(exported.text).toContain("已私信导出");
    const dm = api.sentPrivateMessages.at(-1);
    expect(dm?.userOpenid).toBe("admin");
    // 学号 / 班级只走私信，且 CSV 列符合规格；候补行带「候补」标记
    const content = String(dm?.content ?? "");
    expect(content).toContain("序号,姓名,学号,班级,学院,备注,候补");
    expect(content).toContain("22123456789");
    expect(content).toContain("材化2211");
    expect(content).toContain(",候补");
    // 拒绝：普通成员调用导出回调
    const denied = await svc.activityCallbackCard("export", ["#ACT001"], "member", "g1");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
  });

  it("asks the operator to use /export when the CSV exceeds one message", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 5 });
    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");

    svc.setActivityExtras({
      exportService: new ActivityExportService({
        sender: new RichMessageSender(api),
        profiles,
        messageLimit: 10,
      }),
    });

    const exported = await svc.activityCallbackCard("export", ["#ACT001"], "admin", "g1");
    expect(exported.ok).toBe(true);
    const content = String(api.sentPrivateMessages.at(-1)?.content ?? "");
    expect(content).toContain("/export #ACT001");
    expect(content).not.toContain("序号,姓名");
  });

  it("degrades the stats callback when §B3 is not wired", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    const manage = await svc.activityCallbackCard("manage", ["#ACT001"], "admin", "g1");
    const buttons = (
      manage.rich.keyboard as {
        content: { rows: Array<{ buttons: Array<{ id: string }> }> };
      }
    ).content.rows.flatMap((row) => row.buttons);
    // 未装配统计服务 → 不生成「统计图片」按钮
    expect(buttons.some((button) => button.id === "stats")).toBe(false);
    const stats = await svc.activityCallbackCard("stats", ["#ACT001"], "admin", "g1");
    expect(stats.ok).toBe(true);
    expect(stats.text).toContain("文字统计");
  });

  it("exposes /activity subscribe|unsubscribe as a command fallback", async () => {
    const { svc } = withActivity();
    const on = await svc.handle("g1", "member", "/activity subscribe");
    expect(on.ok).toBe(true);
    expect(on.text).toContain("订阅状态");
    expect(activityNotifications.isSubscribed("g1", "member")).toBe(true);
    const off = await svc.handle("g1", "member", "/activity unsubscribe");
    expect(off.ok).toBe(true);
    expect(activityNotifications.isSubscribed("g1", "member")).toBe(false);
  });

  // ---------------------------------------------------------------- §B4

  /** 群内手输 `/activity join|quit`：命令结果必须带 silent（gatewayRunner 跳过群回复）。 */
  it("keeps the group silent for /activity join and /activity quit commands", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 2 });
    profiles.set("member", "name", "小明");
    profiles.set("member", "studentId", "22123456789");
    profiles.set("member", "className", "材化2211");

    const before = api.sentMessages.length;
    const joined = await svc.handle("g1", "member", "/activity join #ACT001");
    expect(joined.ok).toBe(true);
    expect(joined.silent).toBe(true);
    expect(api.sentMessages).toHaveLength(before);
    expect(String(api.sentPrivateMessages.at(-1)?.markdown ?? "")).toContain("报名成功");

    const quit = await svc.handle("g1", "member", "/activity quit #ACT001");
    expect(quit.ok).toBe(true);
    expect(quit.silent).toBe(true);
    expect(api.sentMessages).toHaveLength(before);
    expect(String(api.sentPrivateMessages.at(-1)?.markdown ?? "")).toContain("已取消报名");
  });

  /** §B4 唯一例外：私信失败时群里只回「不含结果」的提示。 */
  it("falls back to a result-free group notice when the DM cannot be delivered", async () => {
    const { svc, profiles } = withActivity();
    await setupOpenActivity(svc, { capacity: 2 });
    profiles.set("member", "name", "小明");
    profiles.set("member", "studentId", "22123456789");
    profiles.set("member", "className", "材化2211");
    api.failPrivateRichMessages = true;
    api.failPrivateMessages = true;

    const before = api.sentMessages.length;
    const result = await svc.activityCallbackCard("join", ["#ACT001"], "member", "g1");
    // 私信失败 → 回调返回一条提示卡（renderer 会把它发到群里）；群消息由 renderer 负责，
    // 这里断言回调产物本身不含结果字段。
    expect(result).not.toBeUndefined();
    expect(api.sentMessages).toHaveLength(before);
    const notice = String(result?.rich.markdown ?? "");
    expect(notice).toContain("私信发送失败");
    expect(notice).toContain("<@!member>");
    expect(notice).not.toContain("报名成功");
    expect(notice).not.toContain("小明");
    expect(notice).not.toContain("22123456789");
    expect(notice).not.toContain("材化2211");
  });

  /** 绑定 / 解绑：命令路径 + 解绑回调，且发布打到所有绑定群。 */
  it("binds extra groups and publishes to every bound group", async () => {
    const { svc } = withActivity();
    identityMap.bindGroup("g2", "777777");
    await svc.handle("g1", "admin", "/activity create 迎新晚会");

    // 创建时自动绑定归属群
    const config = await svc.activityCallbackCard("config", ["#ACT001"], "admin", "g1");
    expect(config?.text).toContain("绑定群：654321");

    const bound = await svc.handle("g1", "admin", "/activity bind #ACT001 777777");
    expect(bound.ok).toBe(true);
    expect(bound.text).toContain("已绑定");
    expect(activity.listBoundGroups(activity.requireByCode("#ACT001").activityId)).toEqual([
      "g1",
      "g2",
    ]);

    // 非管理者不能绑定
    const denied = await svc.handle("g1", "member", "/activity bind #ACT001 777777");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    // 发布：两个绑定群各收到一次成员卡
    const groupMessagesBeforeOpen = api.sentMessages.length;
    const opened = await svc.handle("g1", "admin", "/activity open #ACT001");
    expect(opened.ok).toBe(true);
    expect(opened.text).toContain("已发送到 2 个绑定群");
    const publishedGroups = api.sentMessages
      .slice(groupMessagesBeforeOpen)
      .filter((message) => String(message.markdown ?? "").includes("迎新晚会"))
      .map((message) => message.groupId);
    expect(publishedGroups).toEqual(["g1", "g2"]);

    // 解绑回调（固定动作）：点一下就生效
    const unbound = await svc.activityCallbackCard("unbind", ["#ACT001", "g2", "1"], "admin", "g1");
    expect(unbound?.ok).toBe(true);
    expect(unbound?.text).toContain("已解绑");
    expect(activity.listBoundGroups(activity.requireByCode("#ACT001").activityId)).toEqual([
      "g1",
    ]);

    // 绑定子卡：列表 + 「绑定群」指令按钮 + 返回配置
    const bindings = await svc.activityCallbackCard("bindings", ["#ACT001"], "admin", "g1");
    expect(bindings?.ok).toBe(true);
    const buttons = (
      bindings?.rich.keyboard as {
        content: {
          rows: Array<{
            buttons: Array<{ id: string; label: string; action: { type: number; data: string } }>;
          }>;
        };
      }
    ).content.rows.flatMap((row) => row.buttons);
    expect(buttons.find((button) => button.id === "bind")?.action).toMatchObject({
      type: 2,
      data: "/activity bind #ACT001 ",
    });
    expect(bindings?.text).toContain("/activity unbind #ACT001");
    // 非管理者打开绑定子卡 → 权限不足
    const bindDenied = await svc.activityCallbackCard("bindings", ["#ACT001"], "member", "g1");
    expect(bindDenied?.ok).toBe(false);
    expect(bindDenied?.text).toContain("权限不足");
  });

  /** 满员广播：两个绑定群各收到一次「已满」卡，重复触发不重复发。 */
  it("broadcasts the full card once per bound group", async () => {
    const { svc, profiles } = withActivity();
    identityMap.bindGroup("g2", "777777");
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    await svc.handle("g1", "admin", "/activity bind #ACT001 777777");
    await svc.handle("g1", "admin", "/activity set #ACT001 capacity 2");
    await svc.handle("g1", "admin", "/activity open #ACT001");

    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    profiles.set("u4", "name", "同学乙");
    profiles.set("u4", "studentId", "22123456780");
    profiles.set("u4", "className", "材化2211");

    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");
    const before = api.sentMessages.length;
    // 第二次报名恰好满员 → 两个绑定群各收到一次「已满」
    await svc.activityCallbackCard("join", ["#ACT001"], "u4", "g1");
    const fullCards = api.sentMessages
      .slice(before)
      .filter((message) => String(message.markdown ?? "").includes("活动已满"));
    expect(fullCards.map((message) => message.groupId)).toEqual(["g1", "g2"]);
    const fullCard = String(fullCards[0]?.markdown ?? "");
    expect(fullCard).toContain("后续报名将自动进入候补队列");

    // 重复触发（第三次报名进候补）不再重复广播
    profiles.set("u5", "name", "同学丙");
    profiles.set("u5", "studentId", "22123456781");
    profiles.set("u5", "className", "材化2211");
    const afterFirstBroadcast = api.sentMessages.length;
    await svc.activityCallbackCard("join", ["#ACT001"], "u5", "g1");
    expect(
      api.sentMessages
        .slice(afterFirstBroadcast)
        .filter((message) => String(message.markdown ?? "").includes("活动已满")),
    ).toEqual([]);

    // 通知记录里每个群各一条 full（伪接收者 group:<群ID>）
    const stored = await notificationRepo.findAll();
    const fullRows = stored.filter((entry) => entry.kind === "full");
    expect(fullRows.map((entry) => entry.userId).sort()).toEqual([
      "group:g1",
      "group:g2",
    ]);
  });

  /** C5：名额事后调小到「等于已报名数」也要广播一次「已满」，且不重复发。 */
  it("broadcasts when capacity is lowered to the signup count", async () => {
    const { svc, profiles } = withActivity();
    identityMap.bindGroup("g2", "777777");
    await svc.handle("g1", "admin", "/activity create 迎新晚会");
    await svc.handle("g1", "admin", "/activity bind #ACT001 777777");
    await svc.handle("g1", "admin", "/activity set #ACT001 capacity 5");
    await svc.handle("g1", "admin", "/activity open #ACT001");

    profiles.set("u3", "name", "同学甲");
    profiles.set("u3", "studentId", "22123456789");
    profiles.set("u3", "className", "材化2211");
    profiles.set("u4", "name", "同学乙");
    profiles.set("u4", "studentId", "22123456780");
    profiles.set("u4", "className", "材化2211");
    await svc.activityCallbackCard("join", ["#ACT001"], "u3", "g1");
    await svc.activityCallbackCard("join", ["#ACT001"], "u4", "g1");

    // 名额 5 → 2：此时已报名 2 人，等价于满员
    const before = api.sentMessages.length;
    await svc.handle("g1", "admin", "/activity set #ACT001 capacity 2");
    const fullCards = api.sentMessages
      .slice(before)
      .filter((message) => String(message.markdown ?? "").includes("活动已满"));
    expect(fullCards.map((message) => message.groupId)).toEqual(["g1", "g2"]);

    // 再改一次同样的名额：去重表已记过，不重复广播
    const afterFirst = api.sentMessages.length;
    await svc.handle("g1", "admin", "/activity set #ACT001 capacity 2");
    expect(
      api.sentMessages
        .slice(afterFirst)
        .filter((message) => String(message.markdown ?? "").includes("活动已满")),
    ).toEqual([]);

    // 名额大于已报名数时不广播
    const afterReset = api.sentMessages.length;
    await svc.handle("g1", "admin", "/activity set #ACT001 capacity 9");
    await svc.handle("g1", "admin", "/activity set #ACT001 capacity 4");
    expect(
      api.sentMessages
        .slice(afterReset)
        .filter((message) => String(message.markdown ?? "").includes("活动已满")),
    ).toEqual([]);
  });
  /** C3：`/activity set remindAt` 设置/清除定时提醒，配置卡显示当前值。 */
  it("sets and clears the activity reminder time", async () => {
    const { svc } = withActivity();
    await svc.handle("g1", "admin", "/activity create 迎新晚会");

    const set = await svc.handle("g1", "admin", "/activity set #ACT001 remindAt 12-31 20:00");
    expect(set.ok).toBe(true);
    expect(set.text).toContain("定时提醒");
    expect(set.text).toContain("12-31 20:00");

    const cleared = await svc.handle("g1", "admin", "/activity set #ACT001 remindAt clear");
    expect(cleared.ok).toBe(true);
    expect(cleared.text).toContain("定时提醒");
    expect(cleared.text).toContain("未设置");

    // 非法时间：报错且不写入
    const invalid = await svc.handle("g1", "admin", "/activity set #ACT001 remindAt 明天");
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("提醒时间格式");
  });
});
