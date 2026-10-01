import { describe, expect, it } from "vitest";

import {
  SqlPrivacyRepository,
  totalPrivacyCounts,
  type PrivacyCounts,
  type PrivacyExportSection,
  type PrivacyRepository,
} from "../src/db/privacyRepository.js";
import { buildCsv, PrivacyService } from "../src/services/privacy.js";
import type { RichMessageSender } from "../src/services/richMessages.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

/**
 * D7：个人数据匿名化与导出。
 *
 * 口径是「全部匿名化、不物理删行」，并且**故意不动** blacklist_entries /
 * permission_grants（删号不等于解封）与 audit_records（合规保留）——这三条各有断言守着。
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

/** 13 张目标表各回一行统计（顺序与仓储里的 STEPS 一致）。 */
function countResponses(values: readonly number[]): unknown[][] {
  return values.map((n) => [{ n }]);
}

function stubRepository(input: {
  counts?: PrivacyCounts | undefined;
  sections?: PrivacyExportSection[] | undefined;
  onAnonymize?: ((userId: string, anonId: string) => void) | undefined;
}): PrivacyRepository & { anonymizeCalls: number } {
  const counts = input.counts ?? EMPTY;
  const stub = {
    anonymizeCalls: 0,
    async scan() {
      return counts;
    },
    async anonymize(userId: string, anonId: string) {
      stub.anonymizeCalls += 1;
      input.onAnonymize?.(userId, anonId);
    },
    async collect() {
      return input.sections ?? [];
    },
  };
  return stub;
}

function spySender(): {
  sender: RichMessageSender;
  sent: Array<{ userId: string; text: string }>;
} {
  const sent: Array<{ userId: string; text: string }> = [];
  const sender = {
    async sendPlainToUser(userId: string, text: string) {
      sent.push({ userId, text });
      return { ok: true, detail: "" };
    },
  } as unknown as RichMessageSender;
  return { sender, sent };
}

describe("SqlPrivacyRepository", () => {
  it("按表统计待匿名化条数", async () => {
    const db = new FakeQueryable(countResponses([...Array(13).keys()]));
    const repository = new SqlPrivacyRepository(db);

    const counts = await repository.scan("u1");

    expect(counts.bindings).toBe(0);
    expect(counts.profiles).toBe(1);
    expect(counts.menuDeliveries).toBe(12);
    expect(totalPrivacyCounts(counts)).toBe(78);
    expect(db.calls).toHaveLength(13);
    expect(db.calls[0]?.text).toContain("FROM identity_bindings");
    expect(db.calls[0]?.values).toEqual(["u1"]);
    // 短码只统计 user 类，不牵连群 / 申请短码
    const codes = db.calls.find((call) => call.text.includes("short_codes"));
    expect(codes?.text).toContain("kind = 'user'");
  });

  it("匿名化：换 user_id、清个人字段，且不碰黑名单 / 授权 / 审计", async () => {
    const db = new FakeQueryable();
    const repository = new SqlPrivacyRepository(db);

    await repository.anonymize("u1", "anon:x");

    expect(db.calls).toHaveLength(13);
    for (const call of db.calls) {
      expect(call.values).toEqual(["anon:x", "u1"]);
    }
    const sql = (table: string): string =>
      db.calls.find((call) => call.text.includes(table))?.text ?? "";

    // 绑定行两边都换成占位值（否则「openid ↔ QQ号」的对应关系还在）
    expect(sql("identity_bindings")).toContain(
      "official_id = $1, external_id = $1",
    );
    // 个人字段清空
    expect(sql("user_profiles")).toContain("name = ''");
    expect(sql("user_profiles")).toContain("student_id = ''");
    expect(sql("activity_registrations")).toContain("note = ''");
    expect(sql("punishment_records")).toContain("message_excerpt = ''");
    expect(sql("appeal_records")).toContain("reason = ''");
    expect(sql("join_requests")).toContain("reason = ''");

    const everything = db.calls.map((call) => call.text).join("\n");
    expect(everything).not.toContain("blacklist_entries");
    expect(everything).not.toContain("permission_grants");
    expect(everything).not.toContain("audit_records");
  });
});

describe("PrivacyService", () => {
  it("预览只读：按表列条数并汇总", async () => {
    const repository = stubRepository({
      counts: { ...EMPTY, profiles: 1, appeals: 2, shortCodes: 1 },
    });
    const service = new PrivacyService({ repository });

    const plan = await service.plan("u1");

    expect(plan.total).toBe(4);
    expect(plan.counts.profiles).toBe(1);
    expect(repository.anonymizeCalls).toBe(0);
  });

  it("执行匿名化：生成占位值、重载内存态", async () => {
    const seen: Array<{ userId: string; anonId: string }> = [];
    const repository = stubRepository({
      counts: { ...EMPTY, profiles: 1 },
      onAnonymize: (userId, anonId) => seen.push({ userId, anonId }),
    });
    let reloads = 0;
    const service = new PrivacyService({
      repository,
      generateAnonId: () => "anon:test",
      reload: async () => {
        reloads += 1;
      },
    });

    const result = await service.anonymize("u1");

    expect(result.anonId).toBe("anon:test");
    expect(result.total).toBe(1);
    expect(seen).toEqual([{ userId: "u1", anonId: "anon:test" }]);
    expect(reloads).toBe(1);
  });

  it("幂等：没有可匿名化的行时不写库、也不重载", async () => {
    const repository = stubRepository({});
    let reloads = 0;
    const service = new PrivacyService({
      repository,
      generateAnonId: () => "anon:test",
      reload: async () => {
        reloads += 1;
      },
    });

    const result = await service.anonymize("u1");

    expect(result.total).toBe(0);
    expect(result.anonId).toBe("");
    expect(repository.anonymizeCalls).toBe(0);
    expect(reloads).toBe(0);
  });

  it("导出：把分节 CSV 私信给操作者", async () => {
    const sections: PrivacyExportSection[] = [
      {
        key: "profiles",
        title: "个人资料",
        columns: ["user_id", "name"],
        rows: [["u1", "张三"], ["u1", '带,逗号"引号']],
      },
    ];
    const repository = stubRepository({ sections });
    const spy = spySender();
    const service = new PrivacyService({ repository, sender: spy.sender });

    const result = await service.exportCsv("u1", "root");

    expect(result.ok).toBe(true);
    expect(result.rows).toBe(2);
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]?.userId).toBe("root");
    expect(spy.sent[0]?.text).toContain("# 个人资料");
    expect(spy.sent[0]?.text).toContain("user_id,name");
    // CSV 里的逗号与引号按 RFC4180 转义
    expect(spy.sent[0]?.text).toContain('"带,逗号""引号"');
  });

  it("导出：没有数据时明确回文案，不发空 CSV", async () => {
    const repository = stubRepository({ sections: [] });
    const spy = spySender();
    const service = new PrivacyService({ repository, sender: spy.sender });

    const result = await service.exportCsv("u1", "root");

    expect(result.rows).toBe(0);
    expect(result.text).toContain("没有查到");
    expect(spy.sent).toHaveLength(0);
  });

  it("导出：超出单条消息上限时只发分节摘要", async () => {
    const sections: PrivacyExportSection[] = [
      {
        key: "registrations",
        title: "活动报名",
        columns: ["activity_id", "note"],
        rows: Array.from({ length: 20 }, (_value, index) => [
          `a${index}`,
          "很长的备注".repeat(5),
        ]),
      },
    ];
    const repository = stubRepository({ sections });
    const spy = spySender();
    const service = new PrivacyService({
      repository,
      sender: spy.sender,
      messageLimit: 50,
    });

    const result = await service.exportCsv("u1", "root");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("超过单条消息长度上限");
    expect(result.text).toContain("活动报名 20 行");
    expect(spy.sent).toHaveLength(0);
  });
});

describe("buildCsv", () => {
  it("分节输出，空节不占位", () => {
    const csv = buildCsv([
      { key: "a", title: "A 节", columns: ["x", "y"], rows: [["1", "2"]] },
      { key: "b", title: "B 节", columns: ["z"], rows: [["3"]] },
    ]);

    expect(csv.split("\n")).toEqual([
      "# A 节",
      "x,y",
      "1,2",
      "",
      "# B 节",
      "z",
      "3",
    ]);
  });
});
