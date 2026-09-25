import { beforeEach, describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { ActivityService } from "../src/services/activity.js";
import { ActivityCardService } from "../src/services/activityCards.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DisplayNameService } from "../src/services/displayNames.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import { MemberRoster } from "../src/services/memberRoster.js";
import { PermissionService } from "../src/services/permissions.js";
import { RichMessageSender } from "../src/services/richMessages.js";
import { ShortCodeService } from "../src/services/shortCodes.js";
import { UserProfileService } from "../src/services/userProfiles.js";

describe("activity & profile commands", () => {
  let api: FakeQQOfficialAPI;
  let activity: ActivityService;
  let userProfiles: UserProfileService;
  let service: AdminCommandService;
  let codes: string[];

  beforeEach(() => {
    api = new FakeQQOfficialAPI();
    const auditLog = new AuditLogStore();
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([["g1", new Set(["admin"])]]),
    });
    const configStore = new GroupConfigStore({ groupId: "__default__" });
    const joinAudit = new JoinAuditService(auditLog);
    const identityMap = new IdentityMapService();
    identityMap.bindUser("root", "10004");
    identityMap.bindUser("admin", "10003");
    identityMap.bindUser("member", "10001");
    identityMap.bindUser("other", "10002");
    identityMap.bindGroup("g1", "654321");
    const display = new DisplayNameService(identityMap, new ShortCodeService());
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
    userProfiles = new UserProfileService();
    userProfiles.setRoster(roster);
    codes = ["ACT001", "ACT002", "ACT003"];
    activity = new ActivityService(undefined, undefined, undefined, {
      generateCode: () => codes.shift() ?? "ACT999",
    });
    const sender = new RichMessageSender(api);
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval: new JoinApprovalService(api, joinAudit, configStore),
      joinSync: new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 }),
      auditLog,
      identityMap,
      display,
      userProfiles,
      activity,
      activityCards: new ActivityCardService({
        activity,
        display,
        profiles: userProfiles,
        roster,
      }),
      cardSender: sender,
    });
  });

  async function fillProfile(
    userId: string,
    name: string,
    studentId: string,
    className: string,
  ): Promise<void> {
    await service.handle("g1", userId, `/profile set name ${name}`);
    await service.handle("g1", userId, `/profile set id ${studentId}`);
    await service.handle("g1", userId, `/profile set class ${className}`);
  }

  it("lets a user configure and view their profile", async () => {
    const bad = await service.handle("g1", "member", "/profile set id 20221234567");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("前两位");

    await fillProfile("member", "小明", "22123456789", "材化2211");
    const view = await service.handle("g1", "member", "/profile");
    expect(view.ok).toBe(true);
    expect(view.text).toContain("姓名：小明");
    expect(view.text).toContain("学号：22123456789（22 级）");
    expect(view.text).toContain("班级：材化2211");
    // 学院由班级库自动带出
    expect(view.text).toContain("学院：化学与生命科学学院");
  });

  it("runs the full publish / signup / manage flow", async () => {
    const created = await service.handle("g1", "admin", "/activity create 迎新晚会");
    expect(created.ok).toBe(true);
    expect(created.text).toContain("#ACT001");

    const configured = await service.handle(
      "g1",
      "admin",
      "/activity set #ACT001 capacity 2",
    );
    expect(configured.ok).toBe(true);
    await service.handle("g1", "admin", "/activity set #ACT001 allowYears 22");
    await service.handle("g1", "admin", "/activity set #ACT001 allowColleges 化学");
    const linked = await service.handle(
      "g1",
      "admin",
      "/activity set #ACT001 link 报名入口=https://example.com/signup",
    );
    expect(linked.ok).toBe(true);
    expect(linked.text).toContain("https://example.com/signup");

    const opened = await service.handle("g1", "admin", "/activity open #ACT001");
    expect(opened.ok).toBe(true);
    expect(opened.text).toContain("活动卡片已发送到群里");
    const card = api.sentMessages.at(-1);
    expect(card?.groupId).toBe("g1");
    expect(card?.markdown).toContain("迎新晚会");
    expect(card?.markdown).toContain("[报名入口](https://example.com/signup)");
    expect(card?.markdown).toContain("报名限制：学院 化学 · 年级 22");
    const buttons = (
      card?.keyboard as {
        content: {
          rows: Array<{
            buttons: Array<{
              id: string;
              action: { type: number; data: string; modal?: unknown };
            }>;
          }>;
        };
      }
    ).content.rows
      .flatMap((row) => row.buttons);
    // 成员卡的报名 / 取消报名是**回调按钮**（带二次确认），点击即自动完成；
    // 纯文本降级里保留等价的 /activity join|quit 指令（按钮不可用时可用）。
    const joinButton = buttons.find((button) => button.id === "join");
    expect(joinButton?.action).toMatchObject({
      type: 1,
      data: "cb:activity:join:#ACT001",
    });
    expect(joinButton?.action.modal).toBeDefined();
    const quitButton = buttons.find((button) => button.id === "quit");
    expect(quitButton?.action).toMatchObject({
      type: 1,
      data: "cb:activity:quit:#ACT001",
    });
    expect(quitButton?.action.modal).toBeDefined();
    // 纯文本降级（`RichMessage.text`）里保留等价指令
    expect(card?.markdown).toContain("/activity join #ACT001");
    expect(card?.markdown).toContain("/activity quit #ACT001");

    // 资料完整的 22 级同学可以报名
    await fillProfile("member", "小明", "22123456789", "材化2211");
    const joined = await service.handle("g1", "member", "/activity join #ACT001");
    expect(joined.ok).toBe(true);
    expect(joined.text).toContain("报名成功");
    // 群内回执（用户确认的落点）：首行 @ 申请人 + 人数；**不含任何隐私字段**
    expect(joined.text).toContain("当前 1 / 2");
    expect(joined.text).toContain("<@!member>");
    expect(joined.text).not.toContain("小明");
    expect(joined.text).not.toContain("22123456789");
    expect(joined.text).not.toContain("材化2211");
    expect(joined.text).not.toContain("学号");

    const duplicate = await service.handle("g1", "member", "/activity join #ACT001");
    expect(duplicate.ok).toBe(false);
    // 具体原因（「已经报名过」）只走私信，群里只说原因已私信
    expect(duplicate.text).toContain("原因已私信");
    expect(duplicate.text).not.toContain("已经报名");
    expect(String(api.sentPrivateMessages.at(-1)?.markdown ?? "")).toContain(
      "已经报名",
    );

    // 年级不符的同学被拒绝：原因同样只走私信
    await fillProfile("other", "小红", "23123456789", "环工2314");
    const rejected = await service.handle("g1", "other", "/activity join #ACT001");
    expect(rejected.ok).toBe(false);
    expect(rejected.text).toContain("原因已私信");
    expect(rejected.text).not.toContain("仅限");
    expect(String(api.sentPrivateMessages.at(-1)?.markdown ?? "")).toContain("仅限");

    // 名单默认脱敏（不显示学号/学院），「完整信息」才带学号
    const signups = await service.handle("g1", "admin", "/activity signups #ACT001");
    expect(signups.ok).toBe(true);
    expect(signups.text).toContain("小明");
    expect(signups.text).toContain("材化2211");
    expect(signups.text).not.toContain("22123456789");
    const fullSignups = await service.activityCallbackCard(
      "signups",
      ["#ACT001", "1", "full"],
      "admin",
      "g1",
    );
    expect(fullSignups.text).toContain("22123456789");

    // 管理卡正文给出报名进度（详情卡本身不含隐私字段）
    const info = await service.activityCallbackCard(
      "manage",
      ["#ACT001"],
      "admin",
      "g1",
    );
    expect(info.ok).toBe(true);
    expect(info.text).toContain("报名");
    expect(info.text).toContain("1 / 2");
    expect(info.text).not.toContain("22123456789");

    const quit = await service.handle("g1", "member", "/activity quit #ACT001");
    expect(quit.ok).toBe(true);
    expect(
      activity.listRegistrations(activity.requireByCode("#ACT001").activityId),
    ).toEqual([]);
  });

  it("requires a complete profile before signing up", async () => {
    await service.handle("g1", "admin", "/activity create 活动");
    await service.handle("g1", "admin", "/activity open #ACT001");

    const result = await service.handle("g1", "member", "/activity join #ACT001");
    expect(result.ok).toBe(false);
    // 群里只给「原因已私信」，具体原因（含隐私提示）走私信
    const groupText = String(result.rich?.markdown ?? "");
    expect(groupText).toContain("<@!member>");
    expect(groupText).toContain("原因已私信");
    expect(groupText).not.toContain("学号");
    const dmText = String(api.sentPrivateMessages.at(-1)?.markdown ?? "");
    expect(dmText).toContain("补全个人资料");
  });

  it("only lets group admins publish and manage activities", async () => {
    const denied = await service.handle("g1", "member", "/activity create 活动");
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");

    await service.handle("g1", "admin", "/activity create 活动");
    const memberSet = await service.handle(
      "g1",
      "member",
      "/activity set #ACT001 capacity 5",
    );
    expect(memberSet.ok).toBe(false);
    expect(memberSet.text).toContain("权限不足");

    const memberSignups = await service.handle(
      "g1",
      "member",
      "/activity signups #ACT001",
    );
    expect(memberSignups.ok).toBe(false);
  });

  it("lists activities for the group", async () => {
    await service.handle("g1", "admin", "/activity create 活动");
    const list = await service.handle("g1", "member", "/activity");

    expect(list.ok).toBe(true);
    expect(list.text).toContain("#ACT001");
    expect(list.text).toContain("活动");
    // 卡片标准：列表是卡片，并且带操作按钮
    expect(list.rich?.markdown).toContain("#ACT001");
    expect(list.rich?.keyboard?.content.rows.length).toBeGreaterThan(0);
  });

  it("pages the activity list with callbacks and a +page fallback", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await service.handle("g1", "admin", `/activity create 活动${index}`);
    }

    // 每页 3 个 → 4 个活动共 2 页
    const first = await service.handle("g1", "member", "/activity");
    expect(first.rich?.markdown).toContain("第 1 / 2 页");
    const buttons = (first.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(buttons.find((button) => button.id === "next")?.action).toMatchObject({
      type: 1,
      data: "cb:activity:page:g1:2",
    });
    // 每个活动一行操作按钮：详情 / 报名 / 订阅（都是回调，点击即出卡 / 生效）
    expect(buttons.find((button) => button.id === "join-#ACT001")?.action).toMatchObject({
      type: 1,
      data: "cb:activity:join:#ACT001",
    });
    expect(buttons.find((button) => button.id === "info-#ACT001")?.action).toMatchObject({
      type: 1,
      data: "cb:activity:info:#ACT001",
    });
    expect(buttons.find((button) => button.id === "subscribe-#ACT001")?.action).toMatchObject({
      type: 1,
      data: "cb:activity:subscribe:g1:on",
    });
    expect(first.text).toContain("下一页：/activity list +2");

    const second = await service.handle("g1", "member", "/activity list +2");
    expect(second.rich?.markdown).toContain("第 2 / 2 页");
    const secondButtons = (second.rich?.keyboard?.content.rows ?? []).flatMap(
      (row) => row.buttons,
    );
    expect(secondButtons.find((button) => button.id === "prev")?.action).toMatchObject({
      type: 1,
      data: "cb:activity:page:g1:1",
    });
    expect(secondButtons.some((button) => button.id === "next")).toBe(false);
  });
});
