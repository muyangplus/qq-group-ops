import { getLogger } from "../core/logger.js";
import type { AuditLogStore } from "./audit.js";
import type { JoinAuditService } from "./joinAudit.js";
import type { ActivityNotificationService } from "./activityNotifications.js";
import type { NotificationService } from "./notifications.js";
import type { AppealService } from "./appeals.js";
import type { PunishmentService } from "./punishments.js";

const log = getLogger("retention");

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RETENTION_INTERVAL_MS = DAY_MS;

export interface RetentionOptions {
  /** 审计记录保留天数；<= 0 表示不清理。 */
  auditLogRetentionDays: number;
  /** 已审批入群申请的保留天数；<= 0 表示不清理。 */
  joinRequestRetentionDays: number;
  /**
   * 处罚记录里**消息原文**的保留天数（§B7）；`<= 0` 表示根本不落库。
   *
   * 与审计保留期独立：到期只清原文，处罚记录本身仍按 `auditLogRetentionDays` 保留。
   */
  rawMessageRetentionDays?: number;
  /** 时钟（测试注入）。 */
  clock?: () => number;
}

export interface RetentionRunResult {
  auditRecordsRemoved: number;
  joinRequestsRemoved: number;
  notificationsRemoved: number;
  /** 本次被清理的活动通知去重行数（超过保留期的通知不再需要去重）。 */
  activityNotificationsRemoved: number;
  /** 本次被清理的处罚记录数（§B7）。 */
  punishmentsRemoved: number;
  /** 本次被清空的处罚消息原文数（§B7，只清原文、保留记录）。 */
  messageExcerptsCleared: number;
  /** 本次被清理的已处理申诉数（§B8；待处理申诉永不自动清理）。 */
  appealsRemoved: number;
}

/**
 * 数据保留清理（只做**数据库清理**，不含 TTL 过期）。
 *
 * 由统一扫描周期驱动（`TickScheduler`，注册时声明 24h 的 `minIntervalMs`），启动时先跑一次；
 * 只清理「已过期」的数据：
 * - 审计记录早于 `AUDIT_LOG_RETENTION_DAYS`；
 * - 已审批的入群申请早于 `AUDIT_LOG_RETENTION_DAYS`（待审批的永不清理）；
 * - 入群申请推送的投递记录早于 `AUDIT_LOG_RETENTION_DAYS`（只用于去重与排查）；
 * - 活动通知的去重行早于同一保留期（超过保留期后已无去重意义，避免无限增长）。
 *
 * 注意：处罚**消息原文**默认不落库；只有本群 `rawMessageRetentionDays > 0` 时才写入，
 * 并按 `RAW_MESSAGE_RETENTION_DAYS` 单独清空（只清原文，处罚记录本身照旧保留）。
 *
 * 「待审批申请 TTL 过期」不在这里：它改成每轮扫描检查（`join-pending-ttl` 任务），
 * 免得 `/pending` 里的僵尸申请最坏要等 24 小时才消失。
 */
export class RetentionService {
  private readonly clock: () => number;

  public constructor(
    private readonly auditLog: AuditLogStore,
    private readonly joinAudit: JoinAuditService,
    private readonly options: RetentionOptions,
    private readonly notifications?: NotificationService,
    private readonly activityNotifications?: ActivityNotificationService,
    private readonly punishments?: PunishmentService,
    private readonly appeals?: AppealService,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  public async runOnce(): Promise<RetentionRunResult> {
    const now = this.clock();
    const result: RetentionRunResult = {
      auditRecordsRemoved: 0,
      joinRequestsRemoved: 0,
      notificationsRemoved: 0,
      activityNotificationsRemoved: 0,
      punishmentsRemoved: 0,
      messageExcerptsCleared: 0,
      appealsRemoved: 0,
    };

    if (this.options.auditLogRetentionDays > 0) {
      const cutoff = new Date(
        now - this.options.auditLogRetentionDays * DAY_MS,
      );
      result.auditRecordsRemoved = await this.auditLog.pruneOlderThan(cutoff);
      // 处罚 / 申诉记录与审计同一保留期：处罚记录本身只保留动作与规则说明。
      result.punishmentsRemoved =
        (await this.punishments?.pruneOlderThan(cutoff)) ?? 0;
      result.appealsRemoved = (await this.appeals?.pruneOlderThan(cutoff)) ?? 0;
    }
    // §B7：消息原文有独立的、更短的保留期（`RAW_MESSAGE_RETENTION_DAYS`）；
    // 只在开启（> 0）时才有数据可清 —— 清空原文后处罚记录仍保留。
    if ((this.options.rawMessageRetentionDays ?? 0) > 0) {
      const cutoff = new Date(
        now - this.options.rawMessageRetentionDays! * DAY_MS,
      );
      result.messageExcerptsCleared =
        (await this.punishments?.clearMessageExcerptsBefore(cutoff)) ?? 0;
    }
    if (this.options.joinRequestRetentionDays > 0) {
      const cutoff = new Date(
        now - this.options.joinRequestRetentionDays * DAY_MS,
      );
      result.joinRequestsRemoved =
        await this.joinAudit.pruneReviewedOlderThan(cutoff);
      result.notificationsRemoved =
        (await this.notifications?.pruneDeliveredOlderThan(cutoff)) ?? 0;
      result.activityNotificationsRemoved =
        (await this.activityNotifications?.pruneOlderThan(cutoff)) ?? 0;
    }

    if (
      result.auditRecordsRemoved > 0 ||
      result.joinRequestsRemoved > 0 ||
      result.notificationsRemoved > 0 ||
      result.activityNotificationsRemoved > 0 ||
      result.punishmentsRemoved > 0 ||
      result.messageExcerptsCleared > 0 ||
      result.appealsRemoved > 0
    ) {
      log.info("retention cleanup finished", { ...result });
    } else {
      log.debug("retention cleanup finished", { ...result });
    }
    return result;
  }
}
