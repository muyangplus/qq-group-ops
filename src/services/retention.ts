import { getLogger } from "../core/logger.js";
import {
  SystemScheduler,
  type Scheduler,
} from "../adapters/reconnectingWebSocketGateway.js";
import type { AuditLogStore } from "./audit.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { NotificationService } from "./notifications.js";

const log = getLogger("retention");

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RETENTION_INTERVAL_MS = DAY_MS;

export interface RetentionOptions {
  /** 审计记录保留天数；<= 0 表示不清理。 */
  auditLogRetentionDays: number;
  /** 已审批入群申请的保留天数；<= 0 表示不清理。 */
  joinRequestRetentionDays: number;
  /**
   * 待审批入群申请的有效期（天）；超过即标记为 `expired`（不删除，仍可 /whois 追溯）。
   * `<= 0` 表示不自动过期。
   */
  joinRequestTtlDays?: number;
  /** 清理周期，默认 24 小时。 */
  intervalMs?: number;
  clock?: () => number;
  scheduler?: Scheduler;
}

export interface RetentionRunResult {
  auditRecordsRemoved: number;
  joinRequestsRemoved: number;
  notificationsRemoved: number;
  /** 本次被标记为过期的待审批申请数。 */
  joinRequestsExpired: number;
}

/**
 * 数据保留清理。
 *
 * 启动时执行一次，之后按周期执行；只清理「已过期」的数据：
 * - 审计记录早于 `AUDIT_LOG_RETENTION_DAYS`；
 * - 已审批的入群申请早于 `AUDIT_LOG_RETENTION_DAYS`（待审批的永不清理）；
 * - 入群申请推送的投递记录早于 `AUDIT_LOG_RETENTION_DAYS`（只用于去重与排查）。
 *
 * 注意：项目默认不保存消息原文，因此 `RAW_MESSAGE_RETENTION_DAYS` 目前没有可清理的数据。
 */
export class RetentionService {
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly scheduler: Scheduler;
  private timer: unknown;
  private running = false;

  public constructor(
    private readonly auditLog: AuditLogStore,
    private readonly joinAudit: JoinAuditService,
    private readonly options: RetentionOptions,
    private readonly notifications?: NotificationService,
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.scheduler = options.scheduler ?? new SystemScheduler();
  }

  public async runOnce(): Promise<RetentionRunResult> {
    const now = this.clock();
    const result: RetentionRunResult = {
      auditRecordsRemoved: 0,
      joinRequestsRemoved: 0,
      notificationsRemoved: 0,
      joinRequestsExpired: 0,
    };

    // 先收敛过期申请：过期的待审批申请不再出现在 /pending、推送与统计里
    if ((this.options.joinRequestTtlDays ?? 0) > 0) {
      result.joinRequestsExpired = this.joinAudit.expireStalePending(now);
    }
    if (this.options.auditLogRetentionDays > 0) {
      const cutoff = new Date(
        now - this.options.auditLogRetentionDays * DAY_MS,
      );
      result.auditRecordsRemoved = await this.auditLog.pruneOlderThan(cutoff);
    }
    if (this.options.joinRequestRetentionDays > 0) {
      const cutoff = new Date(
        now - this.options.joinRequestRetentionDays * DAY_MS,
      );
      result.joinRequestsRemoved =
        await this.joinAudit.pruneReviewedOlderThan(cutoff);
      result.notificationsRemoved =
        (await this.notifications?.pruneDeliveredOlderThan(cutoff)) ?? 0;
    }

    if (
      result.auditRecordsRemoved > 0 ||
      result.joinRequestsRemoved > 0 ||
      result.notificationsRemoved > 0 ||
      result.joinRequestsExpired > 0
    ) {
      log.info("retention cleanup finished", { ...result });
    } else {
      log.debug("retention cleanup finished", { ...result });
    }
    return result;
  }

  public start(): void {
    if (this.running || this.intervalMs <= 0) {
      return;
    }
    this.running = true;
    this.scheduleNext();
    log.info("retention scheduled", { intervalMs: this.intervalMs });
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((error: unknown) => {
          log.error("retention cleanup failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNext();
          }
        });
    }, this.intervalMs);
  }
}
