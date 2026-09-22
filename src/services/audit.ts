import type { AuditRecord } from "../core/models.js";

export interface AuditLog {
  append(record: AuditRecord): void;
  findByGroup(groupId: string): AuditRecord[];
}

export class InMemoryAuditLog implements AuditLog {
  private readonly records: AuditRecord[] = [];

  public append(record: AuditRecord): void {
    this.records.push(record);
  }

  public findByGroup(groupId: string): AuditRecord[] {
    return this.records.filter((record) => record.groupId === groupId);
  }

  public all(): AuditRecord[] {
    return [...this.records];
  }
}
