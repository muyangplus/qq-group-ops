import { describe, expect, it } from "vitest";

import { loadAdminApiConfig } from "../src/adminApi/config.js";
import { AdminApiRequestError } from "../src/adminApi/errors.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import {
  buildAdminApiServer,
  type AdminApiWriters,
} from "../src/adminApi/server.js";
import type { AdminTokenRepository } from "../src/db/adminTokenRepository.js";
import { WriteQueue } from "../src/db/writeQueue.js";
import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { FakeGroupSettingsRepository } from "./helpers/fakeGroupConfigRepositories.js";
import { FakeAnnouncementSender } from "./helpers/fakeAnnouncementSender.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { ActivityService } from "../src/services/activity.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PlatformSettingsStore } from "../src/services/platformSettings.js";
import { PermissionService } from "../src/services/permissions.js";
import {
  ScheduledAnnouncementService,
  ScheduledAnnouncementStore,
} from "../src/services/scheduledAnnouncements.js";
import { loadSettings } from "../src/config.js";

/**
 * 管理 API 的定时发言面（本群群管 130 自治）。
 *
 * 两条边界：
 * - **后端**：与群里 `/announce` 同一个领域服务（校验 / 落库 / 发送 / 审计全都同一份）；
 * - **HTTP 层**：只做形状校验与状态码映射，业务错误由 writer 抛 `badRequest` / `forbidden`。
 */
function harness(options: { withService?: boolean } = {}) {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const permissions = new PermissionService({
    superAdminIds: new Set(["boss"]),
    groupAdminIds: new Map([["g1", new Set(["admin"])]]),
  });
  const repository = new FakeGroupSettingsRepository();
  const queue = new WriteQueue();
  const sender = new FakeAnnouncementSender();
  const platform = new PlatformSettingsStore(
    loadSettings({ SCHEDULED_ANNOUNCE_ENABLED: "1" }),
  );
  const service = new ScheduledAnnouncementService({
    store: new ScheduledAnnouncementStore(repository, queue),
    sender,
    audit: auditLog,
    now: () => new Date(2026, 9, 3, 8, 0, 0),
    groupLabel: (groupId) => `群 ${groupId}`,
  });
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
    platform,
    ...(options.withService === false ? {} : { scheduledAnnouncements: service }),
    mode: "fake",
  });
  return { backend, auditLog, repository, queue, sender, service };
}

function audits(auditLog: AuditLogStore, action: string) {
  return auditLog.all().filter((item) => item.action === action);
}

describe("定时发言：管理 API 后端（本群 130）", () => {
  it("新建：默认停用、回执带后五次执行时间，列表按群过滤", async () => {
    const h = harness();

    const result = await h.backend.createAnnouncement({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "该交作业了" },
      actorId: "admin",
    });

    expect(result.ok).toBe(true);
    expect(result.announcement?.enabled).toBe(false);
    // 后五次执行时间由后端按「现在」算（这里只断言形状：5 条、每天 09:00、严格递增）
    const nextTimes = result.announcement?.nextTimes ?? [];
    expect(nextTimes).toHaveLength(5);
    for (const time of nextTimes) {
      expect(time).toMatch(/^\d{4}-\d{2}-\d{2} 09:00$/u);
    }
    expect([...nextTimes]).toEqual([...nextTimes].sort());
    expect(result.announcements.total).toBe(1);
    expect(result.announcements.enabled).toBe(true);
    expect(result.announcements.hourlyLimit).toBe(6);
    // 审计由领域服务写（与指令层同一条记录），actor 是操作人
    expect(audits(h.auditLog, "announce_create")[0]?.actorId).toBe("admin");
    expect(audits(h.auditLog, "announce_create")[0]?.groupId).toBe("g1");

    // 别的群看不到这一条
    expect((await h.backend.scheduledAnnouncements("g2")).total).toBe(0);
  });

  it("新建：cron 不合法 / 纯文本带按钮都 400（不落库）", async () => {
    const h = harness();

    await expect(
      h.backend.createAnnouncement({
        groupId: "g1",
        cron: "@daily",
        content: { mode: "text", text: "x" },
        actorId: "admin",
      }),
    ).rejects.toThrow(/不支持 @daily/u);

    await expect(
      h.backend.createAnnouncement({
        groupId: "g1",
        cron: "0 9 * * *",
        content: {
          mode: "text",
          text: "x",
          buttons: [{ label: "查看", command: "/activity" }],
        },
        actorId: "admin",
      }),
    ).rejects.toThrow(/卡片形态/u);

    expect((await h.backend.scheduledAnnouncements("g1")).total).toBe(0);
  });

  it("门槛：不是本群群管就 403，并写一条 denied 审计", async () => {
    const h = harness();
    await expect(
      h.backend.createAnnouncement({
        groupId: "g1",
        cron: "0 9 * * *",
        content: { mode: "text", text: "x" },
        actorId: "member",
      }),
    ).rejects.toThrow(/群管理员/u);
    expect(audits(h.auditLog, "admin_api:denied")).toHaveLength(1);
    expect(audits(h.auditLog, "admin_api:denied")[0]?.actorId).toBe("member");
  });

  it("改 / 启停 / 删：门槛按这条任务所属群判，不是客户端传的群", async () => {
    const h = harness();
    const created = await h.backend.createAnnouncement({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "早" },
      actorId: "admin",
    });
    const id = created.announcement!.id;

    // 别的群的群管改不了这条任务
    await expect(
      h.backend.updateAnnouncement({ id, enabled: true, actorId: "other" }),
    ).rejects.toThrow(/群管理员/u);

    const enabled = await h.backend.updateAnnouncement({
      id,
      enabled: true,
      actorId: "admin",
    });
    expect(enabled.message).toContain("已启用");
    expect(enabled.announcement?.enabled).toBe(true);
    expect(audits(h.auditLog, "announce_update")).toHaveLength(1);

    const changed = await h.backend.updateAnnouncement({
      id,
      cron: "30 20 * * *",
      content: { mode: "card", title: "提醒", text: "该交作业了" },
      actorId: "admin",
    });
    expect(changed.announcement?.cron).toBe("30 20 * * *");
    expect(changed.announcement?.mode).toBe("card");
    expect(changed.announcement?.nextTimes[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} 20:30$/u,
    );

    const removed = await h.backend.removeAnnouncement({ id, actorId: "admin" });
    expect(removed.announcement).toBeUndefined();
    expect(removed.announcements.total).toBe(0);
    expect(audits(h.auditLog, "announce_remove")).toHaveLength(1);
  });

  it("改不存在的 id / 试发不存在的 id 都是 400", async () => {
    const h = harness();
    await expect(
      h.backend.updateAnnouncement({ id: "nope", enabled: true, actorId: "admin" }),
    ).rejects.toThrow(/不存在/u);
    await expect(
      h.backend.removeAnnouncement({ id: "nope", actorId: "admin" }),
    ).rejects.toThrow(/不存在/u);
    await expect(
      h.backend.sendAnnouncement({ id: "nope", actorId: "admin" }),
    ).rejects.toThrow(/不存在/u);
  });

  it("试发：真实发送 + 计入每小时上限 + 审计", async () => {
    const h = harness();
    const created = await h.backend.createAnnouncement({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "card", title: "提醒", text: "该交作业了" },
      actorId: "admin",
    });
    const id = created.announcement!.id;

    const sent = await h.backend.sendAnnouncement({ id, actorId: "admin" });
    expect(sent.ok).toBe(true);
    expect(h.sender.groupMessages).toHaveLength(1);
    expect(h.sender.groupMessages[0]?.message.markdown).toContain("该交作业了");
    // 已停用的任务也会收到「注意它还是停用状态」的提示
    expect(sent.message).toContain("停用");
    const fired = audits(h.auditLog, "announce_fire");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe("admin");
  });

  it("未装配领域服务（只读巡检进程）时写操作明确 503", async () => {
    const h = harness({ withService: false });
    await expect(
      h.backend.createAnnouncement({
        groupId: "g1",
        cron: "0 9 * * *",
        content: { mode: "text", text: "x" },
        actorId: "boss",
      }),
    ).rejects.toThrow(/只读巡检/u);
  });

  it("总开关关着时列表照样给出来，但如实标 enabled=false", async () => {
    const h = harness();
    await h.backend.createAnnouncement({
      groupId: "g1",
      cron: "0 9 * * *",
      content: { mode: "text", text: "x" },
      actorId: "admin",
    });
    const off = createAdminApiBackend({
      permissions: new PermissionService({
        superAdminIds: new Set(),
        groupAdminIds: new Map([["g1", new Set(["admin"])]]),
      }),
      auditLog: h.auditLog,
      joinAudit: new JoinAuditService(h.auditLog),
      joinApproval: new JoinApprovalService(
        new FakeQQOfficialAPI(),
        new JoinAuditService(h.auditLog),
        new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      ),
      configStore: new GroupConfigStore({ groupId: DEFAULT_GROUP_ID }),
      activity: new ActivityService(),
      activityExport: new ActivityExportService({
        profiles: { get: () => undefined },
      }),
      platform: new PlatformSettingsStore(loadSettings({})),
      scheduledAnnouncements: h.service,
      mode: "fake",
    });
    const view = await off.scheduledAnnouncements("g1");
    expect(view.total).toBe(1);
    expect(view.enabled).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP 层（桩 writers）                                                       */
/* -------------------------------------------------------------------------- */

const CONFIG = loadAdminApiConfig({
  ADMIN_API_ENABLED: "true",
  ADMIN_API_SESSION_SECRET: "y".repeat(40),
  ADMIN_API_PUBLIC_BASE_URL: "https://ops.example.com",
});

function memoryTokens(): AdminTokenRepository {
  const rows = new Map<
    string,
    { userId: string; expiresAt: number; used: boolean }
  >();
  return {
    async issue({ userId }) {
      const token = `tok-${rows.size + 1}`;
      const expiresAt = new Date(Date.now() + 60_000);
      rows.set(token, { userId, expiresAt: expiresAt.getTime(), used: false });
      return { token, expiresAt };
    },
    async redeem(token) {
      const row = rows.get(token.trim());
      if (!row || row.used || row.expiresAt <= Date.now()) {
        return undefined;
      }
      row.used = true;
      return row.userId;
    },
    async pruneExpired() {},
    async countActive() {
      return [...rows.values()].filter(
        (row) => !row.used && row.expiresAt > Date.now(),
      ).length;
    },
  };
}

const EMPTY_VIEW = { items: [], total: 0, enabled: true, hourlyLimit: 6 };

/**
 * 桩 writers：只桩这一块用到的 4 个方法（其余方法这些用例不会走到）。
 *
 * 与 `test/adminApiWriteEndpoints.test.ts` 同一套写法：测试文件不在 `tsc` 的 include 里，
 * 所以「只桩用到的部分」不会挡住别的用例。
 */
function stubWriters(
  overrides: Partial<AdminApiWriters> = {},
): AdminApiWriters & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return result;
    };
  return {
    calls,
    createAnnouncement:
      overrides.createAnnouncement ??
      record("createAnnouncement", { ok: true, message: "已新建", announcements: EMPTY_VIEW }),
    updateAnnouncement:
      overrides.updateAnnouncement ??
      record("updateAnnouncement", { ok: true, message: "已保存", announcements: EMPTY_VIEW }),
    removeAnnouncement:
      overrides.removeAnnouncement ??
      record("removeAnnouncement", { ok: true, message: "已删除", announcements: EMPTY_VIEW }),
    sendAnnouncement:
      overrides.sendAnnouncement ??
      record("sendAnnouncement", { ok: true, message: "已发送", announcements: EMPTY_VIEW }),
  } as unknown as AdminApiWriters & {
    calls: Array<{ method: string; args: unknown[] }>;
  };
}

async function loggedIn(writers: AdminApiWriters | undefined) {
  const tokens = memoryTokens();
  const server = buildAdminApiServer({
    config: CONFIG,
    tokens,
    version: "test",
    ...(writers !== undefined ? { writers } : {}),
  });
  const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
  const login = await server.app.inject({
    method: "POST",
    url: "/auth/token",
    headers: { "x-admin-request": "1" },
    payload: { token },
  });
  const raw = login.headers["set-cookie"];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return { app: server.app, cookie: header.split(";")[0] ?? "" };
}

describe("定时发言：HTTP 层", () => {
  it("只读巡检模式（没有 writers）时写端点回 503", async () => {
    const { app, cookie } = await loggedIn(undefined);
    const headers = { cookie, "x-admin-request": "1" };

    for (const [method, url] of [
      ["POST", "/api/scheduled-announcements"],
      ["PUT", "/api/scheduled-announcements/id-1"],
      ["DELETE", "/api/scheduled-announcements/id-1"],
      ["POST", "/api/scheduled-announcements/id-1/send"],
    ] as const) {
      const response = await app.inject({ method, url, headers, payload: {} });
      expect(response.statusCode, url).toBe(503);
      expect(response.json()).toMatchObject({ error: "unavailable" });
    }
    await app.close();
  });

  it("列表要 group；没装配 reader 时 503", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);
    const headers = { cookie, "x-admin-request": "1" };

    const missing = await app.inject({
      method: "GET",
      url: "/api/scheduled-announcements",
      headers,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toContain("group");

    const noReader = await app.inject({
      method: "GET",
      url: "/api/scheduled-announcements?group=g1",
      headers,
    });
    expect(noReader.statusCode).toBe(503);
    await app.close();
  });

  it("列表：装配 reader 后按群返回（含后五次执行时间由后端给）", async () => {
    const tokens = memoryTokens();
    const server = buildAdminApiServer({
      config: CONFIG,
      tokens,
      version: "test",
      writers: stubWriters(),
      readers: {
        pending: async () => [],
        rules: async () => ({ groupId: "g1", group: {} as never, override: null }),
        notifyTopics: async () => [],
        activities: async () => [],
        scheduledAnnouncements: async (groupId: string) => ({
          items: [
            {
              id: "a1",
              groupId,
              group: { kind: "group", officialId: groupId, label: "群 g1" },
              cron: "0 9 * * *",
              enabled: true,
              mode: "text",
              title: "定时发言",
              text: "早",
              buttons: [],
              reference: false,
              nextTimes: ["2026-10-03 09:00"],
              createdBy: { kind: "user", officialId: "admin", label: "10003" },
              createdAt: "2026-10-03T00:00:00.000Z",
              updatedAt: "2026-10-03T00:00:00.000Z",
            },
          ],
          total: 1,
          enabled: true,
          hourlyLimit: 6,
        }),
      },
    });
    const { token } = await tokens.issue({ userId: "op1", ttlMs: 60_000 });
    const login = await server.app.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "x-admin-request": "1" },
      payload: { token },
    });
    const raw = login.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(";")[0] ?? "";

    const response = await server.app.inject({
      method: "GET",
      url: "/api/scheduled-announcements?group=g1",
      headers: { cookie, "x-admin-request": "1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      enabled: true,
      hourlyLimit: 6,
      items: [{ id: "a1", nextTimes: ["2026-10-03 09:00"] }],
    });
    await server.app.close();
  });

  it("新建：形状校验（缺 group / 缺 cron / mode 不对 / buttons 形状不对）都 400 且不调 writer", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);
    const headers = { cookie, "x-admin-request": "1" };

    for (const payload of [
      { cron: "0 9 * * *", text: "x" },
      { group: "g1", text: "x" },
      { group: "g1", cron: "0 9 * * *", text: "x", mode: "rich" },
      { group: "g1", cron: "0 9 * * *", text: "x", buttons: [{ label: "查看" }] },
      { group: "g1", cron: "0 9 * * *", text: 3 },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/scheduled-announcements",
        headers,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(writers.calls).toHaveLength(0);

    const ok = await app.inject({
      method: "POST",
      url: "/api/scheduled-announcements",
      headers,
      payload: {
        group: "g1",
        cron: "0 9 * * *",
        mode: "card",
        title: "作业提醒",
        text: "该交作业了",
        quote: "原文",
        reference: true,
        buttons: [{ label: "查看", command: "/activity", reply: true }],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(writers.calls[0]).toEqual({
      method: "createAnnouncement",
      args: [
        {
          groupId: "g1",
          cron: "0 9 * * *",
          content: {
            mode: "card",
            title: "作业提醒",
            text: "该交作业了",
            quote: "原文",
            reference: true,
            buttons: [{ label: "查看", command: "/activity", reply: true }],
          },
          actorId: "op1",
        },
      ],
    });
    await app.close();
  });

  it("改 / 删 / 试发：路径参数与 body 只传要改的部分", async () => {
    const writers = stubWriters();
    const { app, cookie } = await loggedIn(writers);
    const headers = { cookie, "x-admin-request": "1" };

    const enable = await app.inject({
      method: "PUT",
      url: "/api/scheduled-announcements/a1",
      headers,
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    expect(writers.calls[0]).toEqual({
      method: "updateAnnouncement",
      args: [{ id: "a1", enabled: true, actorId: "op1" }],
    });

    const text = await app.inject({
      method: "PUT",
      url: "/api/scheduled-announcements/a1",
      headers,
      payload: { text: "新正文" },
    });
    expect(text.statusCode).toBe(200);
    expect(writers.calls[1]).toEqual({
      method: "updateAnnouncement",
      args: [{ id: "a1", content: { text: "新正文" }, actorId: "op1" }],
    });

    const emptyCron = await app.inject({
      method: "PUT",
      url: "/api/scheduled-announcements/a1",
      headers,
      payload: { cron: "  " },
    });
    expect(emptyCron.statusCode).toBe(400);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/scheduled-announcements/a1",
      headers,
    });
    expect(removed.statusCode).toBe(200);
    expect(writers.calls[2]).toEqual({
      method: "removeAnnouncement",
      args: [{ id: "a1", actorId: "op1" }],
    });

    const sent = await app.inject({
      method: "POST",
      url: "/api/scheduled-announcements/a1/send",
      headers,
    });
    expect(sent.statusCode).toBe(200);
    expect(writers.calls[3]).toEqual({
      method: "sendAnnouncement",
      args: [{ id: "a1", actorId: "op1" }],
    });
    await app.close();
  });

  it("writer 抛的领域错误映射成对应状态码（400 / 403 / 503）", async () => {
    const writers = stubWriters({
      createAnnouncement: async () => {
        throw new AdminApiRequestError(400, "bad_request", "cron 要正好 5 段");
      },
    });
    const { app, cookie } = await loggedIn(writers);
    const response = await app.inject({
      method: "POST",
      url: "/api/scheduled-announcements",
      headers: { cookie, "x-admin-request": "1" },
      payload: { group: "g1", cron: "x", text: "y" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("5 段");
    await app.close();

    const forbiddenWriters = stubWriters({
      removeAnnouncement: async () => {
        throw new AdminApiRequestError(403, "forbidden", "权限不足：需要该群的群管理员或以上权限。");
      },
    });
    const second = await loggedIn(forbiddenWriters);
    const denied = await second.app.inject({
      method: "DELETE",
      url: "/api/scheduled-announcements/a1",
      headers: { cookie: second.cookie, "x-admin-request": "1" },
    });
    expect(denied.statusCode).toBe(403);
    await second.app.close();
  });
});
