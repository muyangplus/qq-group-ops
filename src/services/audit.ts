import type { AuditRecord } from "../core/models.js";
import type { AuditRepository } from "../db/auditRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

export interface AuditLog {
  append(record: AuditRecord): void;
  findByGroup(groupId: string): AuditRecord[];
  all(): AuditRecord[];
  /** 持久化实现才需要；内存实现可省略。 */
  flush?(): Promise<void>;
}

/**
 * 审计日志存储。
 *
 * 注入仓储后升级为持久化：启动时 `load()` 全量载入，`append()` 同步写入内存缓存、
 * 异步写穿透到数据库；未注入仓储时退化为纯内存实现，便于单元测试。
 */
export class AuditLogStore implements AuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly repository: AuditRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(repository?: AuditRepository, queue?: WriteQueue) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const records = await this.repository.findAll();
    this.records.length = 0;
    this.records.push(...records);
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public append(record: AuditRecord): void {
    this.records.push(record);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("audit.append", () => repository.append(record));
    }
  }

  public findByGroup(groupId: string): AuditRecord[] {
    return this.records.filter((record) => record.groupId === groupId);
  }

  public all(): AuditRecord[] {
    return [...this.records];
  }
}
