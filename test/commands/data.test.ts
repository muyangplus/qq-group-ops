import { describe, expect, it } from "vitest";

import type {
  PrivacyCounts,
  PrivacyExportSection,
  PrivacyRepository,
} from "../../src/db/privacyRepository.js";
import { AdminCommandService } from "../../src/services/adminCommands.js";
import { PrivacyService } from "../../src/services/privacy.js";
import type { RichMessageSender } from "../../src/services/richMessages.js";
import {
  appeals,
  auditLog,
  blacklist,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  moderationNotifier,
  notifications,
  permissions,
  punishments,
} from "../helpers/adminCommandsHarness.js";

/**
 * `/data`：个人数据匿名化 / 导出（D7）。
 *
 * 口径：仅全局超管、只在私信；删除 = 匿名化（行保留、user_id 换占位值）；确认按钮是**指令按钮**
 * （`/data anonymize …`），理由随指令文本走，直接进审计。
 */

const EMPTY: PrivacyCounts = {
  bindings: 0,
  profiles: 0,
  joinRequests: 0,
  registrations: 0,
  waitlist: 0,
  punishments: 0,
  appeals: 0,
  shortCodes: 0,
  notifySubscriptions: 0,
  notifyDeliveries: 0,
  activitySubscriptions: 0,
  activityNotifications: 0,
  menuDeliveries: 0,
};

const SECTIONS: PrivacyExportSection[] = [
  {
    key: "profiles",
    title: "个人资料",
    columns: ["user_id", "name"],
    rows: [["u1", "张三"]],
  },
];

interface StubRepository extends PrivacyRepository {
  anonymizeCalls: Array<{ userId: string; anonId: string }>;
}

function stubRepository(
  counts: Partial<PrivacyCounts> = {},
  sections: PrivacyExportSection[] = [],
): StubRepository {
  const repository: StubRepository = {
    anonymizeCalls: [],
    async scan() {
      return { ...EMPTY, ...counts };
    },
    async anonymize(userId: string, anonId: string) {
      repository.anonymizeCalls.push({ userId, anonId });
    },
    async collect() {
      return sections;
    },
  };
  return repository;
}

function buildService(
  repository: PrivacyRepository,
  sender?: RichMessageSender,
): AdminCommandService {
  return new AdminCommandService({
    permissions,
    joinAudit,
    configStore,
    joinApproval,
    joinSync,
    auditLog,
    identityMap,
    notifications,
    blacklist,
    punishments,
    appeals,
    moderationNotifier,
    privacy: new PrivacyService({
      repository,
      generateAnonId: () => "anon:test",
      ...(sender !== undefined ? { sender } : {}),
    }),
  });
}

function baseButtons(result: {
  rich: { keyboard?: { content: { rows: Array<{ buttons: unknown[] }> } } };
}): Array<{ id: string; label: string; action: { type: number; data: string } }> {
  return (
    result.rich.keyboard?.content.rows.flatMap((row) => row.buttons) ?? []
  ) as Array<{ id: string; label: string; action: { type: number; data: string } }>;
}

describe("/data（个人数据）", () => {
  it("只在私信执行，且只有全局超管能用", async () => {
    const service = buildService(stubRepository({ profiles: 1 }));

    const inGroup = await service.handle("g1", "root", "/data delete u1");
    expect(inGroup.ok).toBe(false);
    expect(inGroup.text).toContain("只在私信执行");

    const notSuper = await service.handle(undefined, "admin", "/data delete u1");
    expect(notSuper.ok).toBe(false);
    expect(notSuper.text).toContain("权限不足");
  });

  it("预览卡：只读列出条数，确认按钮发送 /data anonymize", async () => {
    const repository = stubRepository({ profiles: 1, appeals: 2 });
    const service = buildService(repository);

    const result = await service.handle(undefined, "root", "/data delete u1 资料不实");

    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("待匿名化");
    expect(result.rich.markdown).toContain("个人资料：1 条");
    expect(result.rich.markdown).toContain("申诉记录：2 条");
    expect(result.rich.markdown).toContain("理由");
    const buttons = baseButtons(result);
    const confirm = buttons.find((button) => button.id === "confirm");
    // 指令按钮（type=2），理由随指令文本走——回调 data 承载不了自由文本
    expect(confirm?.action.type).toBe(2);
    expect(confirm?.action.data).toBe("/data anonymize u1 资料不实");
    // 预览不改库
    expect(repository.anonymizeCalls).toEqual([]);
  });

  it("执行匿名化：生成占位值、写审计、卡片给出占位值与条数", async () => {
    const repository = stubRepository({ profiles: 1, shortCodes: 1 });
    const service = buildService(repository);
    const before = auditLog.all().length;

    const result = await service.handle(
      undefined,
      "root",
      "/data anonymize u1 毕业了",
    );

    expect(result.ok).toBe(true);
    expect(repository.anonymizeCalls).toEqual([
      { userId: "u1", anonId: "anon:test" },
    ]);
    expect(result.rich.markdown).toContain("anon:test");
    expect(result.rich.markdown).toContain("已处理");
    const audit = auditLog.all().at(-1);
    expect(auditLog.all().length).toBe(before + 1);
    expect(audit?.action).toBe("data_delete");
    // 平台级动作不挂群
    expect(audit?.groupId).toBe("");
    expect(audit?.reason).toContain("匿名化=2");
    expect(audit?.reason).toContain("理由=毕业了");
  });

  it("幂等：没有可匿名化的数据时不改库、不写审计", async () => {
    const repository = stubRepository();
    const service = buildService(repository);
    const before = auditLog.all().length;

    const result = await service.handle(undefined, "root", "/data anonymize u1");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有可匿名化的数据");
    expect(repository.anonymizeCalls).toEqual([]);
    expect(auditLog.all().length).toBe(before);
  });

  it("导出：CSV 私信给操作者并写审计", async () => {
    const sent: Array<{ userId: string; text: string }> = [];
    const sender = {
      async sendPlainToUser(userId: string, text: string) {
        sent.push({ userId, text });
        return { ok: true, detail: "" };
      },
    } as unknown as RichMessageSender;
    const service = buildService(stubRepository({}, SECTIONS), sender);

    const result = await service.handle(undefined, "root", "/data export u1");

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.userId).toBe("root");
    expect(sent[0]?.text).toContain("# 个人资料");
    expect(auditLog.all().at(-1)?.action).toBe("data_export");
  });

  it("缺目标或没见过的子命令时给用法", async () => {
    const service = buildService(stubRepository());

    const noTarget = await service.handle(undefined, "root", "/data delete");
    expect(noTarget.ok).toBe(false);
    expect(noTarget.text).toContain("/data anonymize");

    const unknown = await service.handle(undefined, "root", "/data 不明 u1");
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("/data delete");
  });
});
