import type { NotificationDeliveryStatus } from "../core/enums.js";
import type { Queryable } from "./queryable.js";

/**
 * 入群申请推送的两张表：
 * - `notification_subscriptions`：谁订阅了哪个范围的推送（`__all__` 或某个群）；
 * - `notification_deliveries`：某个申请已经推送给谁，用于去重与排查（重启后不重复推送）。
 */

export interface NotificationSubscription {
  userId: string;
  /** `__all__` 表示「我担任审核员的所有群」，否则是 group_openid。 */
  scope: string;
}

export interface NotificationDelivery {
  groupId: string;
  requestId: string;
  userId: string;
  status: NotificationDeliveryStatus;
  /** 降级/失败说明，例如 `text_fallback` 或错误信息。 */
  detail: string;
  createdAt: Date;
}

export interface NotificationSubscriptionRepository {
  findAll(): Promise<NotificationSubscription[]>;
  save(subscription: NotificationSubscription): Promise<void>;
  remove(userId: string, scope: string): Promise<void>;
}

export interface NotificationDeliveryRepository {
  findAll(): Promise<NotificationDelivery[]>;
  save(delivery: NotificationDelivery): Promise<void>;
  /** 删除早于 cutoff 的投递记录，用于数据保留策略。 */
  deleteOlderThan(cutoff: Date): Promise<void>;
}

interface SubscriptionRow {
  user_id: string;
  scope: string;
}

interface DeliveryRow {
  group_id: string;
  request_id: string;
  user_id: string;
  status: string;
  detail: string;
  created_at: string | Date;
}

const SELECT_SUBSCRIPTIONS_SQL = `
SELECT user_id, scope
FROM notification_subscriptions
ORDER BY user_id ASC, scope ASC
`.trim();

const UPSERT_SUBSCRIPTION_SQL = `
INSERT INTO notification_subscriptions (user_id, scope, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (user_id, scope) DO NOTHING
`.trim();

const DELETE_SUBSCRIPTION_SQL = `
DELETE FROM notification_subscriptions
WHERE user_id = $1 AND scope = $2
`.trim();

const SELECT_DELIVERIES_SQL = `
SELECT group_id, request_id, user_id, status, detail, created_at
FROM notification_deliveries
ORDER BY created_at ASC
`.trim();

const UPSERT_DELIVERY_SQL = `
INSERT INTO notification_deliveries (
  group_id, request_id, user_id, status, detail, created_at
) VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (group_id, request_id, user_id) DO UPDATE
SET status = EXCLUDED.status,
    detail = EXCLUDED.detail,
    created_at = EXCLUDED.created_at
`.trim();

const DELETE_DELIVERIES_OLDER_THAN_SQL = `
DELETE FROM notification_deliveries
WHERE created_at < $1
`.trim();

export class SqlNotificationSubscriptionRepository
  implements NotificationSubscriptionRepository
{
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<NotificationSubscription[]> {
    const result = await this.db.query<SubscriptionRow>(
      SELECT_SUBSCRIPTIONS_SQL,
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      scope: row.scope,
    }));
  }

  public async save(subscription: NotificationSubscription): Promise<void> {
    await this.db.query(UPSERT_SUBSCRIPTION_SQL, [
      subscription.userId,
      subscription.scope,
    ]);
  }

  public async remove(userId: string, scope: string): Promise<void> {
    await this.db.query(DELETE_SUBSCRIPTION_SQL, [userId, scope]);
  }
}

export class SqlNotificationDeliveryRepository
  implements NotificationDeliveryRepository
{
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<NotificationDelivery[]> {
    const result = await this.db.query<DeliveryRow>(SELECT_DELIVERIES_SQL);
    return result.rows.map((row) => ({
      groupId: row.group_id,
      requestId: row.request_id,
      userId: row.user_id,
      status: row.status as NotificationDeliveryStatus,
      detail: row.detail,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    }));
  }

  public async save(delivery: NotificationDelivery): Promise<void> {
    await this.db.query(UPSERT_DELIVERY_SQL, [
      delivery.groupId,
      delivery.requestId,
      delivery.userId,
      delivery.status,
      delivery.detail,
      delivery.createdAt.toISOString(),
    ]);
  }

  public async deleteOlderThan(cutoff: Date): Promise<void> {
    await this.db.query(DELETE_DELIVERIES_OLDER_THAN_SQL, [
      cutoff.toISOString(),
    ]);
  }
}
