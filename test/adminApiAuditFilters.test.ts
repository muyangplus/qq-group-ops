import { describe, expect, it } from "vitest";

import {
  filterAuditRecords,
  parseAuditBound,
  type AuditFilterableRecord,
} from "../src/adminApi/auditFilters.js";

/**
 * 审计筛选（收尾批次 B）：时间范围 / 操作人 / 操作对象 / 动作 / 状态。
 *
 * 两条口径钉在这里：
 * - 操作人 / 操作对象按「人念得出来的名字」匹配（内部 id、QQ号、`#短码`（忽略大小写）、展示名）；
 * - 时间参数是 `YYYY-MM-DD`（本地日，`to` 含当天最后一毫秒）或 ISO 时间；坏值**抛错**
 *   （HTTP 层据此回 400），绝不静默忽略。
 */
function record(patch: Partial<AuditFilterableRecord> = {}): AuditFilterableRecord {
  return {
    groupId: "g1",
    actorId: "openid-actor",
    actor: {
      label: "10001",
      externalId: "10001",
      shortCode: "#A1B2C3",
    },
    action: "admin_api:punish",
    status: "executed",
    createdAt: "2026-10-03T12:00:00.000Z",
    ...patch,
  };
}

describe("parseAuditBound", () => {
  it("日期（本地日）：from 取当天零点、to 取当天最后一毫秒", () => {
    const from = parseAuditBound("2026-10-03", "from");
    expect([
      from.getFullYear(),
      from.getMonth(),
      from.getDate(),
      from.getHours(),
      from.getMinutes(),
      from.getSeconds(),
      from.getMilliseconds(),
    ]).toEqual([2026, 9, 3, 0, 0, 0, 0]);

    const to = parseAuditBound("2026-10-03", "to");
    expect([
      to.getFullYear(),
      to.getMonth(),
      to.getDate(),
      to.getHours(),
      to.getMinutes(),
      to.getSeconds(),
      to.getMilliseconds(),
    ]).toEqual([2026, 9, 3, 23, 59, 59, 999]);
  });

  it("ISO 时间原样解析；坏值抛错（不静默忽略）", () => {
    expect(parseAuditBound("2026-10-03T05:00:00.000Z", "from").toISOString()).toBe(
      "2026-10-03T05:00:00.000Z",
    );
    expect(() => parseAuditBound("昨天", "from")).toThrow(/时间格式不认识/u);
    expect(() => parseAuditBound("2026-13-99", "to")).toThrow(/时间格式不认识/u);
  });
});

describe("filterAuditRecords", () => {
  const rows = [
    record(),
    record({
      groupId: "g2",
      actorId: "openid-mod",
      actor: { label: "10002", externalId: "10002" },
      action: "admin_api:blacklist_add",
      status: "rejected",
      targetUserId: "openid-target",
      target: { label: "#D4E5F6", shortCode: "#D4E5F6" },
      createdAt: "2026-10-02T23:30:00.000Z",
    }),
    record({
      actorId: "bot",
      actor: { label: "bot" },
      action: "moderation:release",
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
  ];

  it("不传任何筛选就是全部（含没有操作对象的行）", () => {
    expect(filterAuditRecords(rows, {})).toHaveLength(3);
  });

  it("操作人 / 操作对象按 QQ号 / #短码（忽略大小写）/ 展示名 / 内部 id 都算命中", () => {
    expect(filterAuditRecords(rows, { actor: "10001" })).toHaveLength(1);
    expect(filterAuditRecords(rows, { actor: "#a1b2c3" })).toHaveLength(1);
    expect(filterAuditRecords(rows, { actor: "openid-mod" })).toHaveLength(1);
    expect(filterAuditRecords(rows, { actor: "bot" })).toHaveLength(1);
    // 操作对象：短码 / 内部 id
    expect(filterAuditRecords(rows, { target: "#d4e5f6" })).toHaveLength(1);
    expect(filterAuditRecords(rows, { target: "openid-target" })).toHaveLength(1);
    // 没有操作对象的行不会被「对象筛选」命中
    expect(filterAuditRecords(rows, { target: "10001" })).toHaveLength(0);
  });

  it("群 / 动作 / 状态（只看被拒）逐项生效，且能叠加", () => {
    expect(filterAuditRecords(rows, { group: "g2" })).toHaveLength(1);
    expect(filterAuditRecords(rows, { action: "moderation:release" })).toHaveLength(1);
    expect(filterAuditRecords(rows, { status: "rejected" })).toHaveLength(1);
    expect(
      filterAuditRecords(rows, { status: "rejected", group: "g1" }),
    ).toHaveLength(0);
    expect(
      filterAuditRecords(rows, { status: "rejected", group: "g2" }),
    ).toHaveLength(1);
  });

  it("时间范围：含边界，且按本地日（to 含当天最后一毫秒）", () => {
    const range = {
      from: parseAuditBound("2026-10-03", "from"),
      to: parseAuditBound("2026-10-03", "to"),
    };
    // 本地当天正午 / 零点整 / 前一天最后一毫秒 —— 用本地时间构造，避免测试依赖机器时区
    const at = (local: Date): AuditFilterableRecord[] => [
      record({ createdAt: local.toISOString() }),
    ];
    expect(filterAuditRecords(at(new Date(2026, 9, 3, 12, 0, 0, 0)), range)).toHaveLength(1);
    // 边界就是边界：本地当天 00:00:00.000 与 23:59:59.999 都在范围内
    expect(filterAuditRecords(at(new Date(2026, 9, 3, 0, 0, 0, 0)), range)).toHaveLength(1);
    expect(
      filterAuditRecords(at(new Date(2026, 9, 3, 23, 59, 59, 999)), range),
    ).toHaveLength(1);
    // 前一天最后一毫秒 / 次日零点整都不在
    expect(
      filterAuditRecords(at(new Date(2026, 9, 2, 23, 59, 59, 999)), range),
    ).toHaveLength(0);
    expect(filterAuditRecords(at(new Date(2026, 9, 4, 0, 0, 0, 0)), range)).toHaveLength(0);
  });

  it("时间解析不出来的行在有范围筛选时被排除（有边界才查时间）", () => {
    const broken = record({ createdAt: "not-a-time" });
    expect(filterAuditRecords([broken], {})).toHaveLength(1);
    expect(
      filterAuditRecords([broken], { from: parseAuditBound("2026-10-01", "from") }),
    ).toHaveLength(0);
  });
});
