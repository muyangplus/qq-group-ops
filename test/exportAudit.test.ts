import { describe, expect, it } from "vitest";

import { AuditStatus } from "../src/core/enums.js";
import { AdminCommandService } from "../src/services/adminCommands.js";
import { ExportService } from "../src/services/export.js";
import { RichMessageSender } from "../src/services/richMessages.js";
import {
  api,
  auditLog,
  configStore,
  identityMap,
  joinApproval,
  joinAudit,
  joinSync,
  permissions,
} from "./helpers/adminCommandsHarness.js";

/** §B6：审核日志导出（脱敏 + 权限 + 只私信）。 */
function buildService(): AdminCommandService {
  return new AdminCommandService({
    permissions,
    joinAudit,
    configStore,
    joinApproval,
    joinSync,
    auditLog,
    identityMap,
    exportService: new ExportService(permissions, auditLog),
    richMessages: new RichMessageSender(api),
  });
}

describe("§B6 审核日志导出", () => {
  it("exports a masked CSV privately and stays silent in the group", async () => {
    auditLog.append({
      recordId: "r1",
      groupId: "g1",
      actorId: "admin",
      targetUserId: "member",
      action: "moderation:warn",
      status: AuditStatus.Executed,
      reason: "命中关键词：广告",
      createdAt: new Date("2026-09-26T00:00:00.000Z"),
    });
    const service = buildService();

    const result = await service.handle("g1", "admin", "/export audit 10");

    expect(result.ok).toBe(true);
    // 群内完全静默：CSV 只私信
    expect(result.silent).toBe(true);
    const content = String(api.sentPrivateMessages.at(-1)?.content ?? "");
    expect(content).toContain("record_id");
    expect(content).toContain("r1");
    expect(content).toContain("moderation:warn");
    // 脱敏：actor / target 不出现完整 openid
    expect(content).not.toContain("admin");
    expect(content).not.toContain("member");
    // 导出动作本身也写审计
    expect(
      auditLog.all().some((record) => record.action === "export_audit_records"),
    ).toBe(true);
  });

  it("denies members and explains the usage", async () => {
    const service = buildService();

    const denied = await service.handle("g1", "member", "/export audit");
    const usage = await service.handle("g1", "admin", "/export");

    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("权限不足");
    expect(usage.ok).toBe(false);
    expect(usage.text).toContain("/export audit");
  });
});
