import { getLogger } from "../core/logger.js";

/**
 * 统一推送骨架（R5）。
 *
 * 「入群申请推送」（`notifications.ts`）与「活动通知」（`activityNotifications.ts`）
 * 的投递流程是同一套：**按 key 去重 → 可选每日封顶 → 发送 → 记录 → 汇总**。
 * 这里把这套骨架收敛成 `PushService`，两个业务各自提供：
 *
 * - `PushStore`：自己的去重表 / 落库（内存 Map + WriteQueue + 仓储）；
 * - `send`：自己的发送通道与消息内容；
 * - `entry`：自己的投递记录形状。
 *
 * 业务语义差异通过选项表达（例如入群推送「发送失败也记录、避免重复重试」，
 * 活动通知「只有成功才记录、失败可下次重试」）。
 */

const log = getLogger("push");

/** 一条投递记录的最小面：谁、什么时候。 */
export interface PushDeliveryRecord {
  readonly userId: string;
  readonly createdAt: Date;
}

/** 单次投递结果。 */
export interface PushOutcome {
  readonly status: "sent" | "failed" | "skipped" | "rateLimited";
  readonly detail: string;
}

/** 投递汇总（各业务的结果字段是它的子集）。 */
export interface PushSummary {
  sent: number;
  failed: number;
  skipped: number;
  rateLimited: number;
  recipients: number;
}

export function emptySummary(recipients: number): PushSummary {
  return { sent: 0, failed: 0, skipped: 0, rateLimited: 0, recipients };
}

export function tallySummary(summary: PushSummary, outcome: PushOutcome): void {
  if (outcome.status === "sent") {
    summary.sent += 1;
  } else if (outcome.status === "failed") {
    summary.failed += 1;
  } else {
    summary.skipped += 1;
    if (outcome.status === "rateLimited") {
      summary.rateLimited += 1;
    }
  }
}

/** 本地时区的「今天 0 点」，用于每日封顶统计。 */
export function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 业务侧的投递存储（内存为准，落库由实现自己排队）。 */
export interface PushStore<TRecord extends PushDeliveryRecord> {
  /** 该 key 是否已经投递过（去重）。 */
  has(key: string): boolean;
  /** 该用户在 `since` 之后的投递条数（每日封顶）。 */
  countSince(userId: string, since: Date): number;
  /** 记录一次投递。 */
  record(key: string, entry: TRecord): void;
}

export interface PushServiceOptions<TRecord extends PushDeliveryRecord> {
  store: PushStore<TRecord>;
  now: () => Date;
  /** 日志用的业务名，例如 `notification` / `activity notification`。 */
  label: string;
  /** 每人每日投递上限；`0` / 不传表示不限制。 */
  dailyLimit?: number;
  /** 发送失败是否也记录（入群推送为 true：失败不重试，避免刷屏）。 */
  recordOnFailure?: boolean;
}

export interface PushDeliverInput<TRecord extends PushDeliveryRecord> {
  key: string;
  userId: string;
  /** 日志附加上下文（groupId / requestId / activityId / kind…）。 */
  fields?: Record<string, unknown>;
  send: () => Promise<{ ok: boolean; detail: string }>;
  entry: (now: Date, outcome: { status: "sent" | "failed"; detail: string }) => TRecord;
}

export class PushService<TRecord extends PushDeliveryRecord> {
  public constructor(private readonly options: PushServiceOptions<TRecord>) {}

  public async deliver(input: PushDeliverInput<TRecord>): Promise<PushOutcome> {
    const { store, now, label, dailyLimit = 0, recordOnFailure = false } = this.options;
    const fields = { ...input.fields, userId: input.userId };
    if (store.has(input.key)) {
      log.debug(`${label} deduplicated`, fields);
      return { status: "skipped", detail: "duplicate" };
    }
    if (dailyLimit > 0) {
      const count = store.countSince(input.userId, startOfToday(now()));
      if (count >= dailyLimit) {
        log.warn(`${label} skipped: daily limit reached`, {
          ...fields,
          limit: dailyLimit,
          count,
        });
        return { status: "rateLimited", detail: "daily-limit" };
      }
    }
    const sent = await input.send();
    if (!sent.ok) {
      log.warn(`${label} delivery failed`, { ...fields, error: sent.detail });
      if (recordOnFailure) {
        store.record(input.key, input.entry(now(), { status: "failed", detail: sent.detail }));
      }
      return { status: "failed", detail: sent.detail };
    }
    store.record(input.key, input.entry(now(), { status: "sent", detail: sent.detail }));
    return { status: "sent", detail: sent.detail };
  }
}
