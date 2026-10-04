import { beforeEach, describe, expect, it } from "vitest";

import { FakeGroupSettingsRepository } from "./helpers/fakeGroupConfigRepositories.js";
import { FakeAnnouncementSender } from "./helpers/fakeAnnouncementSender.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DisplayNameService } from "../src/services/displayNames.js";
import { GroupConfigStore } from "../src/services/groupConfig.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { JoinRequestSyncService } from "../src/services/joinAuditSync.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import { PermissionService } from "../src/services/permissions.js";
import {
  ScheduledAnnouncementService,
  ScheduledAnnouncementStore,
} from "../src/services/scheduledAnnouncements.js";
import { ShortCodeService } from "../src/services/shortCodes.js";
import { loadSettings } from "../src/config.js";
import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";

/**
 * `/announce`（机器人定时发言）的指令层行为：
 * 门槛（本群 130）· 新增/改/启停/删除 · 每次回「后五次执行时间」· 试发真的发出去。
 */
describe("/announce 指令", () => {
  let service: AdminCommandService;
  let sender: FakeAnnouncementSender;

  beforeEach(() => {
    const api = new FakeQQOfficialAPI();
    const auditLog = new AuditLogStore();
    const permissions = new PermissionService({
      superAdminIds: new Set(["root"]),
      groupAdminIds: new Map([
        ["g1", new Set(["admin"])],
        ["g2", new Set(["admin2"])],
      ]),
    });
    const configStore = new GroupConfigStore({ groupId: "__default__" });
    const joinAudit = new JoinAuditService(auditLog);
    const identityMap = new IdentityMapService();
    for (const [userId, qq] of [
      ["root", "10004"],
      ["admin", "10003"],
      ["member", "10001"],
      ["mod", "10005"],
    ] as const) {
      identityMap.bindUser(userId, qq);
    }
    identityMap.bindUser("admin2", "10006");
    identityMap.bindGroup("g1", "654321");
    identityMap.bindGroup("g2", "654322");
    const queue = new WriteQueue();
    sender = new FakeAnnouncementSender();
    const platform = new PlatformSettingsStore(
      loadSettings({ SCHEDULED_ANNOUNCE_ENABLED: "1" }),
    );
    const announcements = new ScheduledAnnouncementService({
      store: new ScheduledAnnouncementStore(new FakeGroupSettingsRepository(), queue),
      sender,
      audit: auditLog,
      now: () => new Date(2026, 9, 3, 8, 0, 0),
      hourlyLimit: () => 1,
      groupLabel: (groupId) => groupId,
    });
    service = new AdminCommandService({
      permissions,
      joinAudit,
      configStore,
      joinApproval: new JoinApprovalService(api, joinAudit, configStore),
      joinSync: new JoinRequestSyncService(api, joinAudit, { minIntervalMs: 0 }),
      auditLog,
      identityMap,
      display: new DisplayNameService(identityMap, new ShortCodeService()),
      scheduledAnnouncements: announcements,
      platform,
    });
  });

  it("只有本群群管理员能用；审核员与别的群的群管都不行", async () => {
    const member = await service.handle("g1", "member", "/announce");
    expect(member.ok).toBe(false);
    expect(member.text).toContain("权限不足");

    const moderator = await service.handle("g1", "mod", "/announce add 0 9 * * * 早");
    expect(moderator.ok).toBe(false);
    expect(moderator.text).toContain("权限不足");

    const otherGroupAdmin = await service.handle("g1", "admin2", "/announce");
    expect(otherGroupAdmin.ok).toBe(false);
    expect(otherGroupAdmin.text).toContain("权限不足");

    const ours = await service.handle("g1", "admin", "/announce");
    expect(ours.ok).toBe(true);
    expect(ours.text).toContain("还没有定时发言");
  });

  it("私聊里如实说明这是分群功能", async () => {
    const result = await service.handle(undefined, "admin", "/announce");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("分群");
  });

  it("新增：默认停用，回执带后五次执行时间（本地时区）", async () => {
    const created = await service.handle(
      "g1",
      "admin",
      "/announce add 0 9 * * * 该交作业了",
    );
    expect(created.ok).toBe(true);
    expect(created.text).toContain("定时发言 #1");
    expect(created.text).toContain("已停用");
    expect(created.text).toContain("0 9 * * *");
    expect(created.text).toContain("后五次执行时间");
    for (const day of ["10-03", "10-04", "10-05", "10-06", "10-07"]) {
      expect(created.text).toContain(`· 2026-${day} 09:00`);
    }
    // 卡片带常用动作按钮
    const ids =
      created.rich?.keyboard?.content.rows.flatMap((row) =>
        row.buttons.map((button) => button.id),
      ) ?? [];
    expect(ids).toContain("announce-on");
    expect(ids).toContain("announce-del");
  });

  it("cron 写错（段数不对）时给原话，不落库", async () => {
    const bad = await service.handle("g1", "admin", "/announce add 0 9 * *");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("正好 5 段");
    const list = await service.handle("g1", "admin", "/announce");
    expect(list.text).toContain("还没有定时发言");
  });

  it("set：改 cron / 形态 / 标题 / 引用块 / 按钮；每次回执都带后五次", async () => {
    await service.handle("g1", "admin", "/announce add 0 9 * * * 该交作业了");
    const cron = await service.handle("g1", "admin", "/announce set 1 cron=*/30 * * * *");
    expect(cron.ok).toBe(true);
    expect(cron.text).toContain("`*/30 * * * *`");
    expect(cron.text).toContain("后五次执行时间");

    const shape = await service.handle("g1", "admin", "/announce set 1 mode=card");
    expect(shape.ok).toBe(true);
    expect(shape.text).toContain("**形态**：卡片");

    await service.handle("g1", "admin", "/announce set 1 title=作业提醒");
    const quoted = await service.handle(
      "g1",
      "admin",
      "/announce set 1 quote=原文第一行 原文第二行",
    );
    expect(quoted.ok).toBe(true);
    expect(quoted.text).toContain("**引用块**：原文第一行 原文第二行");
    expect(quoted.text).toContain("> 原文第一行 原文第二行");

    const button = await service.handle(
      "g1",
      "admin",
      "/announce set 1 btn=查看 /activity",
    );
    expect(button.ok).toBe(true);
    // 预览里能看到「要发出去的按钮」是什么（含点击后发送的指令）
    expect(button.text).toContain("**按钮**：查看（`/activity`）");
    const labels =
      button.rich?.keyboard?.content.rows.flatMap((row) =>
        row.buttons.map((item) => item.label),
      ) ?? [];
    expect(labels).toContain("试发");

    const cleared = await service.handle("g1", "admin", "/announce set 1 btn=clear");
    expect(cleared.ok).toBe(true);
    expect(cleared.text).toContain("**形态**：卡片");
  });

  it("纯文本形态不许带按钮 / 引用块（如实说明原因）", async () => {
    await service.handle("g1", "admin", "/announce add 0 9 * * * 早");
    const bad = await service.handle("g1", "admin", "/announce set 1 btn=查看 /activity");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("卡片形态");
  });

  it("不认识的字段 / 缺等号时提示可用字段", async () => {
    await service.handle("g1", "admin", "/announce add 0 9 * * * 早");
    const unknown = await service.handle("g1", "admin", "/announce set 1 nope=1");
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("不认识的字段");
    const noEq = await service.handle("g1", "admin", "/announce set 1 cron");
    expect(noEq.ok).toBe(false);
    expect(noEq.text).toContain("字段=值");
  });

  it("启停：幂等如实回执；删除后列表变空", async () => {
    await service.handle("g1", "admin", "/announce add 0 9 * * * 早");
    const on = await service.handle("g1", "admin", "/announce on 1");
    expect(on.ok).toBe(true);
    expect(on.text).toContain("已启用");
    const again = await service.handle("g1", "admin", "/announce on 1");
    expect(again.ok).toBe(true);
    expect(again.text).toContain("本来就是启用状态");

    const off = await service.handle("g1", "admin", "/announce off 1");
    expect(off.ok).toBe(true);
    expect(off.text).toContain("已停用");

    const removed = await service.handle("g1", "admin", "/announce del 1");
    expect(removed.ok).toBe(true);
    expect(removed.text).toContain("已删除");
    const list = await service.handle("g1", "admin", "/announce");
    expect(list.text).toContain("还没有定时发言");
  });

  it("编号越界 / 空列表给得出人话", async () => {
    const empty = await service.handle("g1", "admin", "/announce show 1");
    expect(empty.ok).toBe(false);
    expect(empty.text).toContain("还没有定时发言");

    await service.handle("g1", "admin", "/announce add 0 9 * * * 早");
    const outOfRange = await service.handle("g1", "admin", "/announce show 5");
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.text).toContain("编号要填 1");
  });

  it("试发：真的发一条群消息（计入每小时上限）", async () => {
    await service.handle("g1", "admin", "/announce add 0 9 * * * 早");
    const sent = await service.handle("g1", "admin", "/announce send 1");
    expect(sent.ok).toBe(true);
    expect(sender.plainMessages).toHaveLength(1);
    expect(sender.plainMessages[0]?.content).toBe("早");
    const disabled = await service.handle("g1", "admin", "/announce send 1");
    expect(disabled.ok).toBe(false);
    expect(disabled.text).toContain("上限");
  });

  it("列表按任务给「下次」两次并提示 show 看后五次", async () => {
    await service.handle("g1", "admin", "/announce add 0 9 * * * 第一条");
    await service.handle("g1", "admin", "/announce add 0 20 * * * 第二条");
    const list = await service.handle("g1", "admin", "/announce");
    expect(list.ok).toBe(true);
    expect(list.text).toContain("#1");
    expect(list.text).toContain("#2");
    expect(list.text).toContain("下次：10-03 09:00 · 10-04 09:00");
    expect(list.text).toContain("下次：10-03 20:00 · 10-04 20:00");
    expect(list.text).toContain("show <编号> 看后 5 次执行时间");
  });

  it("别名「定时发言」与未知子命令的兜底用法", async () => {
    const alias = await service.handle("g1", "admin", "定时发言");
    expect(alias.ok).toBe(true);
    const unknown = await service.handle("g1", "admin", "/announce whatever");
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("用法");
  });
});
