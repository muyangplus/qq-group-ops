import { randomUUID } from "node:crypto";

import { AuditStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditRecord } from "../core/models.js";
import { utcNow } from "../core/models.js";
import type { Activity, ActivityRegistration } from "./activity.js";
import type { AuditLog } from "./audit.js";
import { AuditLogStore } from "./audit.js";
import type { PermissionService } from "./permissions.js";

const log = getLogger("export");

export function maskIdentifier(value: string | undefined, keep = 1): string {
  if (!value) {
    return "";
  }
  if (value.length <= keep * 2) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, keep)}***${value.slice(-keep)}`;
}

export class ExportService {
  private readonly auditLog: AuditLog;

  public constructor(
    private readonly permissions: PermissionService,
    auditLog: AuditLog = new AuditLogStore(),
  ) {
    this.auditLog = auditLog;
  }

  public exportActivityRegistrationsCsv(
    actorId: string,
    activity: Activity,
    registrations: readonly ActivityRegistration[],
    maskUserIds = true,
  ): string {
    this.permissions.ensure(
      this.permissions.canExportData(actorId, activity.groupId),
      "permission denied: export activity registrations",
    );
    const headers = [
      "registration_id",
      "activity_id",
      "group_id",
      "user_id",
      "display_name",
      "note",
      "created_at",
    ];
    const rows = registrations.map((registration) => [
      registration.registrationId,
      registration.activityId,
      registration.groupId,
      maskUserIds ? maskIdentifier(registration.userId) : registration.userId,
      registration.displayName,
      registration.note,
      registration.createdAt.toISOString(),
    ]);
    const content = renderCsv(headers, rows);
    this.writeAudit(
      actorId,
      activity.groupId,
      "export_activity_registrations",
      registrations.length,
    );
    log.info("exported activity registrations", {
      actorId,
      groupId: activity.groupId,
      count: registrations.length,
    });
    return content;
  }

  public exportAuditRecordsCsv(
    actorId: string,
    groupId: string,
    records: readonly AuditRecord[],
    maskUserIds = true,
  ): string {
    this.permissions.ensure(
      this.permissions.canExportData(actorId, groupId),
      "permission denied: export audit records",
    );
    const headers = [
      "record_id",
      "group_id",
      "actor_id",
      "target_user_id",
      "action",
      "status",
      "reason",
      "created_at",
    ];
    const rows = records.map((record) => [
      record.recordId,
      record.groupId,
      maskUserIds ? maskIdentifier(record.actorId) : record.actorId,
      maskUserIds ? maskIdentifier(record.targetUserId) : (record.targetUserId ?? ""),
      record.action,
      record.status,
      record.reason,
      record.createdAt.toISOString(),
    ]);
    const content = renderCsv(headers, rows);
    this.writeAudit(actorId, groupId, "export_audit_records", records.length);
    log.info("exported audit records", { actorId, groupId, count: records.length });
    return content;
  }

  private writeAudit(
    actorId: string,
    groupId: string,
    action: string,
    count: number,
  ): void {
    this.auditLog.append({
      recordId: randomUUID(),
      groupId,
      actorId,
      action,
      status: AuditStatus.Executed,
      reason: `rows=${count}`,
      createdAt: utcNow(),
    });
  }
}

function renderCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n")
    .concat("\n");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
