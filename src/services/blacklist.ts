import { randomUUID } from "node:crypto";

import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { AuditStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditRecord } from "../core/models.js";
import { utcNow } from "../core/models.js";
import type {
  BlacklistEntry,
  BlacklistRepository,
  BlacklistScope,
} from "../db/blacklistRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import type { AuditLog } from "./audit.js";

const log = getLogger("blacklist");

export interface BlacklistOptions {
  repository?: BlacklistRepository | undefined;
  queue?: WriteQueue | undefined;
  auditLog?: AuditLog | undefined;
  now?: (() => Date) | undefined;
  /**
   * 机器人**已绑定**的全部群（全局黑名单踢人 / 入群审批查询用）。
   * 装配时由 runtime 注入 `identityMap.listGroups()`。
   */
  listBoundGroups?: (() => string[]) | undefined;
}

export interface BlacklistAddInput {
  scope: BlacklistScope;
  /** `scope=global` 时忽略。 */
  groupId?: string | undefined;
  userId: string;
  actorId: string;
  reason?: string | undefined;
  /** 来源：`manual` / `keyword` / `card`。 */
  source?: string | undefined;
  /**
   * 是否同时把人移出群（默认 `true`，与 `/blacklist add` 的既有行为一致）。
   *
   * §B2 关键词「拉黑」动作传 `false`：**不自动踢人**，只落本地黑名单 + 尝试官方拉黑
   * （官方要求目标不在群中，人在群里会失败，只记日志）。
   */
  kick?: boolean | undefined;
}

export interface BlacklistAddResult {
  ok: boolean;
  scope: BlacklistScope;
  /** 落库的群 id；全局为 `""`。 */
  groupId: string;
  entry: BlacklistEntry;
  /** 本次成功踢出的群列表。 */
  kicked: string[];
  /** 官方群拉黑接口是否成功（只有本群黑名单会调用；全局不调）。 */
  officialOk: boolean;
  detail: string;
}

/**
 * 黑名单（§A5）。
 *
 * 两层作用域：
 * - **本群**：只影响该群。落本地表 + 同时调用官方群拉黑接口（`updateMemberBlacklist`），
 *   接口要求目标不在群中，因此顺序是**先踢人、后拉黑**；官方接口失败只记日志，
 *   本地表仍然生效（入群审批会拦）。
 * - **全局**：影响机器人**所有已绑定群**。官方接口是群级的，所以全局只落本地表：
 *   入群审批最高优先级拒绝 + 已在群内则从所有绑定群踢出。
 *
 * 未注入仓储时退化为纯内存实现（单测用）。
 */
export class BlacklistService {
  private readonly entries = new Map<string, BlacklistEntry>();
  private readonly repository: BlacklistRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly auditLog: AuditLog | undefined;
  private readonly now: () => Date;
  private readonly listBoundGroups: () => string[];

  public constructor(
    private readonly api: QQOfficialAPI,
    options: BlacklistOptions = {},
  ) {
    this.repository = options.repository;
    this.queue =
      options.repository !== undefined
        ? (options.queue ?? new WriteQueue())
        : undefined;
    this.auditLog = options.auditLog;
    this.now = options.now ?? (() => utcNow());
    this.listBoundGroups = options.listBoundGroups ?? (() => []);
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    const entries = await this.repository?.findAll();
    this.entries.clear();
    for (const entry of entries ?? []) {
      this.entries.set(keyOf(entry), entry);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public all(): BlacklistEntry[] {
    return [...this.entries.values()].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
  }

  /** 命中判定：全局黑名单先于本群黑名单（返回命中的那条，便于卡片展示原因）。 */
  public hitFor(groupId: string, userId: string): BlacklistEntry | undefined {
    return (
      this.entries.get(keyOf({ scope: "global", groupId: "", userId })) ??
      this.entries.get(keyOf({ scope: "group", groupId, userId }))
    );
  }

  public has(groupId: string, userId: string): boolean {
    return this.hitFor(groupId, userId) !== undefined;
  }

  public hasGlobal(userId: string): boolean {
    return this.entries.has(keyOf({ scope: "global", groupId: "", userId }));
  }

  public hasGroup(groupId: string, userId: string): boolean {
    return this.entries.has(keyOf({ scope: "group", groupId, userId }));
  }

  public entriesForGroup(groupId: string): BlacklistEntry[] {
    return this.all().filter(
      (entry) => entry.scope === "group" && entry.groupId === groupId,
    );
  }

  public globalEntries(): BlacklistEntry[] {
    return this.all().filter((entry) => entry.scope === "global");
  }

  /**
   * 加入黑名单：先落本地表（立即对入群审批生效），再踢人，再调官方群拉黑接口。
   * 任何官方调用失败都只记日志 —— 本地拦截仍然有效。
   */
  public async add(input: BlacklistAddInput): Promise<BlacklistAddResult> {
    const scope = input.scope;
    const groupId = scope === "global" ? "" : (input.groupId ?? "");
    const entry: BlacklistEntry = {
      scope,
      groupId,
      userId: input.userId,
      reason: input.reason?.trim() ?? "",
      actorId: input.actorId,
      source: input.source ?? "manual",
      createdAt: this.now(),
    };
    this.entries.set(keyOf(entry), entry);
    this.persistSave(entry);

    const targets =
      scope === "group"
        ? groupId.length > 0
          ? [groupId]
          : []
        : [...new Set(this.listBoundGroups())].sort();
    const kicked: string[] = [];
    if (input.kick !== false) {
      for (const target of targets) {
        if (await this.removeMember(target, entry.userId)) {
          kicked.push(target);
        }
      }
    }

    let officialOk = false;
    if (scope === "group" && groupId.length > 0) {
      officialOk = await this.updateOfficial(groupId, entry.userId, true);
    }

    this.audit({
      groupId,
      actorId: entry.actorId,
      targetUserId: entry.userId,
      action: `blacklist:add:${scope}`,
      detail: entry.reason,
    });

    const scopeLabel = scope === "global" ? "全局" : `群 ${groupId}`;
    log.info("blacklist entry added", {
      scope,
      groupId,
      userId: entry.userId,
      kicked: kicked.length,
      officialOk,
    });
    return {
      ok: true,
      scope,
      groupId,
      entry,
      kicked,
      officialOk,
      detail:
        `已加入黑名单（${scopeLabel}）：${kicked.length > 0 ? `已踢出 ${kicked.length} 个群` : "当前不在任何绑定群"}` +
        (scope === "group"
          ? officialOk
            ? "；官方群拉黑成功"
            : "；官方群拉黑失败（本地拦截仍生效）"
          : ""),
    };
  }

  /** 解除黑名单：本地删除；本群黑名单额外调官方接口解除。 */
  public async remove(
    scope: BlacklistScope,
    groupId: string | undefined,
    userId: string,
  ): Promise<boolean> {
    const targetGroupId = scope === "global" ? "" : (groupId ?? "");
    const key = keyOf({ scope, groupId: targetGroupId, userId });
    const removed = this.entries.delete(key);
    if (!removed) {
      return false;
    }
    if (this.repository) {
      this.queue?.enqueue("blacklist.remove", () =>
        this.repository!.remove({ scope, groupId: targetGroupId, userId }),
      );
    }
    if (scope === "group" && targetGroupId.length > 0) {
      await this.updateOfficial(targetGroupId, userId, false);
    }
    log.info("blacklist entry removed", { scope, groupId: targetGroupId, userId });
    return true;
  }

  public async pruneOlderThan(cutoff: Date): Promise<number> {
    const stale = this.all().filter((entry) => entry.createdAt < cutoff);
    for (const entry of stale) {
      this.entries.delete(keyOf(entry));
    }
    return stale.length;
  }

  private persistSave(entry: BlacklistEntry): void {
    if (this.repository) {
      this.queue?.enqueue("blacklist.save", () => this.repository!.save(entry));
    }
  }

  /** 踢人：目标可能已经不在群里，失败只记日志。 */
  private async removeMember(groupId: string, userId: string): Promise<boolean> {
    try {
      await this.api.removeGroupMember(groupId, userId);
      return true;
    } catch (error) {
      log.warn("blacklist kick failed", {
        groupId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async updateOfficial(
    groupId: string,
    userId: string,
    add: boolean,
  ): Promise<boolean> {
    try {
      await this.api.updateMemberBlacklist(groupId, userId, add);
      return true;
    } catch (error) {
      log.warn("official member blacklist update failed", {
        groupId,
        userId,
        add,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private audit(input: {
    groupId: string;
    actorId: string;
    targetUserId: string;
    action: string;
    detail: string;
  }): void {
    if (!this.auditLog) {
      return;
    }
    const record: AuditRecord = {
      recordId: randomUUID(),
      groupId: input.groupId,
      actorId: input.actorId,
      targetUserId: input.targetUserId,
      action: input.action,
      status: AuditStatus.Executed,
      reason: input.detail,
      createdAt: this.now(),
    };
    this.auditLog.append(record);
  }
}

function keyOf(input: {
  scope: BlacklistScope;
  groupId: string;
  userId: string;
}): string {
  return `${input.scope}\u0000${input.groupId}\u0000${input.userId}`;
}
