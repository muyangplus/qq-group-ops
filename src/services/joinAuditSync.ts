import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { getLogger } from "../core/logger.js";
import type { JoinAuditService, JoinRequest } from "./joinAudit.js";

const log = getLogger("join-sync");

/** 两次同步同一群的最小间隔，避免频繁调用官方接口。 */
export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export interface JoinRequestSyncOptions {
  minIntervalMs?: number;
  clock?: () => number;
}

/**
 * 从官方接口拉取待审批入群申请，补齐事件丢失的情况。
 *
 * 事件（GROUP_JOIN_REQUEST）正常情况下会实时推送，但机器人离线期间、
 * 或事件丢失时本地队列会缺失申请；该服务用于按需补齐，并对同一群做节流。
 */
export class JoinRequestSyncService {
  private readonly lastSyncAt = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly clock: () => number;

  public constructor(
    private readonly api: QQOfficialAPI,
    private readonly joinAudit: JoinAuditService,
    options: JoinRequestSyncOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
  }

  /** 距离下次允许同步还剩多少毫秒；0 表示可以立即同步。 */
  public cooldownMs(groupId: string): number {
    const last = this.lastSyncAt.get(groupId);
    if (last === undefined) {
      return 0;
    }
    return Math.max(0, this.minIntervalMs - (this.clock() - last));
  }

  public async syncGroup(groupId: string): Promise<JoinRequest[]> {
    const remaining = this.cooldownMs(groupId);
    if (remaining > 0) {
      throw new Error(
        `同步过于频繁，请 ${Math.ceil(remaining / 1_000)} 秒后再试`,
      );
    }
    this.lastSyncAt.set(groupId, this.clock());

    const rawRequests = await this.api.getJoinRequests(groupId);
    log.debug("sync start", { groupId, remoteCount: rawRequests.length });
    let added = 0;
    const remoteIds = new Set<string>();
    for (const item of rawRequests) {
      const requestId = firstString(
        item,
        "join_request_id",
        "request_id",
        "id",
        "flag",
      );
      const userId = firstString(
        item,
        "member_openid",
        "user_id",
        "user_openid",
      );
      const reason =
        firstString(item, "reason", "comment") ??
        firstString(
          isRecord(item.verify_info) ? item.verify_info : {},
          "verify_message",
        ) ??
        "";
      if (!requestId || !userId) {
        continue;
      }
      remoteIds.add(requestId);
      try {
        this.joinAudit.submit(groupId, userId, reason, requestId);
        added += 1;
      } catch {
        // 已同步过的申请不重复写入。
      }
    }
    // 对账：官方列表已不再返回、且已存在一段时间的本地待审批申请 → 标记过期
    const expired = this.joinAudit.expireMissingFromRemote(groupId, remoteIds);
    const pending = this.joinAudit.pending(groupId);
    log.info("sync done", {
      groupId,
      remoteCount: rawRequests.length,
      added,
      expired,
      pending: pending.length,
    });
    return pending;
  }
}

function firstString(
  item: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
