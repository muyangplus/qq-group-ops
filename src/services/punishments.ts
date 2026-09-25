import { randomInt, randomUUID } from "node:crypto";

import type { QQOfficialAPI } from "../adapters/qqOfficial.js";
import { AuditStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditRecord } from "../core/models.js";
import { utcNow } from "../core/models.js";
import type { BlacklistScope } from "../db/blacklistRepository.js";
import type {
  PunishmentActions,
  PunishmentRecord,
  PunishmentRepository,
} from "../db/punishmentRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import type { AuditLog } from "./audit.js";
import type { BlacklistService } from "./blacklist.js";
import type { ModerationNotifier } from "./moderationNotifier.js";
import { randomCode, SHORT_CODE_LENGTH } from "./shortCodes.js";

const log = getLogger("punishments");

/** 短码碰撞时的重试次数（内存表查重，正常一次就成）。 */
const MAX_CODE_ATTEMPTS = 20;

export interface PunishmentOptions {
  repository?: PunishmentRepository | undefined;
  queue?: WriteQueue | undefined;
  auditLog?: AuditLog | undefined;
  /** 处罚通知推送；未装配时只记录不推送。 */
  notifier?: ModerationNotifier | undefined;
  now?: (() => Date) | undefined;
  /** 注入随机源便于测试（默认 `crypto.randomInt`）。 */
  randomInt?: ((max: number) => number) | undefined;
}

export interface PunishmentCreateInput {
  groupId: string;
  userId: string;
  /** 执行者：默认 `bot`（关键词自动处罚）。 */
  actorId?: string | undefined;
  /** 来源：默认 `keyword`。 */
  source?: string | undefined;
  ruleReason?: string | undefined;
  messageId?: string | undefined;
  actions: PunishmentActions;
}

export interface PunishmentActionResult {
  ok: boolean;
  text: string;
  record: PunishmentRecord;
}

/**
 * 处罚记录服务（§B7）。
 *
 * 职责：
 * - 记录一次处罚的**实际动作**（撤回 / 禁言 / 踢出 / 拉黑）与命中消息，供卡片展示与逐项撤销；
 * - 提供卡片上的调整动作：解除处罚 / 修改禁言时长 / 踢出 / 拉黑（本群或全局，走 §A5）；
 * - 每次调整都写审计。
 */
export class PunishmentService {
  private readonly records = new Map<string, PunishmentRecord>();
  private readonly repository: PunishmentRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly auditLog: AuditLog | undefined;
  private readonly notifier: ModerationNotifier | undefined;
  private readonly now: () => Date;
  private readonly random: (max: number) => number;

  public constructor(
    private readonly api: QQOfficialAPI,
    private readonly blacklist: BlacklistService,
    options: PunishmentOptions = {},
  ) {
    this.repository = options.repository;
    this.queue =
      options.repository !== undefined
        ? (options.queue ?? new WriteQueue())
        : undefined;
    this.auditLog = options.auditLog;
    this.notifier = options.notifier;
    this.now = options.now ?? (() => utcNow());
    this.random = options.randomInt ?? ((max) => randomInt(max));
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    const records = await this.repository?.findAll();
    this.records.clear();
    for (const record of records ?? []) {
      this.records.set(record.recordId, record);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  /** 按短码 / `#短码` / 完整 recordId 查找（大小写不敏感）。 */
  public get(code: string | undefined): PunishmentRecord | undefined {
    const normalized = normalizeCode(code);
    return normalized ? this.records.get(normalized) : undefined;
  }

  public listByGroup(groupId: string, limit = 10): PunishmentRecord[] {
    return [...this.records.values()]
      .filter((record) => record.groupId === groupId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  public listForUser(
    groupId: string,
    userId: string,
    limit = 10,
  ): PunishmentRecord[] {
    return this.listByGroup(groupId, Number.MAX_SAFE_INTEGER)
      .filter((record) => record.userId === userId)
      .slice(0, limit);
  }

  /** 建一条处罚记录（由 `MessageGuardService` 在关键词命中后调用）。 */
  public async create(input: PunishmentCreateInput): Promise<PunishmentRecord> {
    const now = this.now();
    const record: PunishmentRecord = {
      recordId: this.generateCode(),
      groupId: input.groupId,
      userId: input.userId,
      actorId: input.actorId ?? "bot",
      source: input.source ?? "keyword",
      ruleReason: input.ruleReason ?? "",
      messageId: input.messageId ?? "",
      actions: { ...input.actions },
      detail: "",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.recordId, record);
    this.persist(record);
    log.info("punishment recorded", {
      groupId: record.groupId,
      recordId: record.recordId,
      actions: record.actions,
    });
    return record;
  }

  /**
   * 执行结果回填：写入 `detail` 并推送「处罚通知」。
   *
   * 推送失败不影响处罚本身（申请/处罚已经生效），只记日志。
   */
  public async markExecuted(
    recordId: string,
    detail: string,
  ): Promise<PunishmentRecord | undefined> {
    const record = this.records.get(recordId);
    if (!record) {
      return undefined;
    }
    const updated: PunishmentRecord = {
      ...record,
      detail,
      updatedAt: this.now(),
    };
    this.records.set(recordId, updated);
    this.persist(updated);
    await this.notify(updated);
    return updated;
  }

  /** 卡片动作：解除处罚（按记录逐项撤销禁言 / 拉黑）。 */
  public async release(input: {
    code: string;
    actorId: string;
    note?: string | undefined;
  }): Promise<PunishmentActionResult | undefined> {
    const record = this.get(input.code);
    if (!record) {
      return undefined;
    }
    if (record.status === "released") {
      return { ok: false, text: `处罚 ${label(record)} 已经解除过了。`, record };
    }
    const undone: string[] = [];
    if (record.actions.muted) {
      if (await this.attempt("unmute", () => this.api.muteGroupMember(record.groupId, record.userId, 0))) {
        undone.push("解除禁言");
      }
    }
    if (record.actions.blacklist === "group") {
      if (await this.blacklist.remove("group", record.groupId, record.userId)) {
        undone.push("解除本群黑名单");
      }
    } else if (record.actions.blacklist === "global") {
      if (await this.blacklist.remove("global", "", record.userId)) {
        undone.push("解除全局黑名单");
      }
    }
    const updated: PunishmentRecord = {
      ...record,
      actions: { ...record.actions, muted: false, blacklist: "" },
      status: "released",
      updatedAt: this.now(),
    };
    this.records.set(updated.recordId, updated);
    this.persist(updated);
    this.audit({
      groupId: updated.groupId,
      actorId: input.actorId,
      targetUserId: updated.userId,
      action: "moderation:release",
      reason: input.note?.trim() ?? "",
    });
    return {
      ok: true,
      text:
        `已解除处罚 ${label(updated)}` +
        (undone.length > 0 ? `：${undone.join("、")}` : "") +
        (record.actions.recalled || record.actions.kicked
          ? "（已撤回的消息与已移出的成员无法恢复）"
          : "。"),
      record: updated,
    };
  }

  /** 卡片动作：修改禁言时长（`seconds<=0` = 解除禁言）。 */
  public async setMute(input: {
    code: string;
    seconds: number;
    actorId: string;
  }): Promise<PunishmentActionResult | undefined> {
    const record = this.get(input.code);
    if (!record) {
      return undefined;
    }
    try {
      await this.api.muteGroupMember(record.groupId, record.userId, input.seconds);
    } catch (error) {
      log.warn("update mute duration failed", {
        recordId: record.recordId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        text: `修改禁言时长失败：${error instanceof Error ? error.message : String(error)}`,
        record,
      };
    }
    const updated: PunishmentRecord = {
      ...record,
      actions: {
        ...record.actions,
        muted: input.seconds > 0,
        muteDurationSeconds: Math.max(0, input.seconds),
      },
      updatedAt: this.now(),
    };
    this.records.set(updated.recordId, updated);
    this.persist(updated);
    this.audit({
      groupId: updated.groupId,
      actorId: input.actorId,
      targetUserId: updated.userId,
      action: "moderation:mute",
      reason: `${input.seconds} 秒`,
    });
    return {
      ok: true,
      text:
        input.seconds > 0
          ? `已把处罚 ${label(updated)} 的禁言时长改为 ${input.seconds} 秒。`
          : `已解除处罚 ${label(updated)} 的禁言。`,
      record: updated,
    };
  }

  /** 卡片动作：把当事人移出群。 */
  public async kick(input: {
    code: string;
    actorId: string;
  }): Promise<PunishmentActionResult | undefined> {
    const record = this.get(input.code);
    if (!record) {
      return undefined;
    }
    try {
      await this.api.removeGroupMember(record.groupId, record.userId);
    } catch (error) {
      log.warn("punishment kick failed", {
        recordId: record.recordId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        text: `移出群失败：${error instanceof Error ? error.message : String(error)}`,
        record,
      };
    }
    const updated: PunishmentRecord = {
      ...record,
      actions: { ...record.actions, kicked: true },
      updatedAt: this.now(),
    };
    this.records.set(updated.recordId, updated);
    this.persist(updated);
    this.audit({
      groupId: updated.groupId,
      actorId: input.actorId,
      targetUserId: updated.userId,
      action: "moderation:kick",
      reason: "",
    });
    return {
      ok: true,
      text: `已把处罚 ${label(updated)} 的当事人移出群。`,
      record: updated,
    };
  }

  /** 卡片动作：拉黑（本群 / 全局，走 §A5）。 */
  public async blacklistUser(input: {
    code: string;
    scope: BlacklistScope;
    actorId: string;
    reason?: string | undefined;
  }): Promise<PunishmentActionResult | undefined> {
    const record = this.get(input.code);
    if (!record) {
      return undefined;
    }
    const added = await this.blacklist.add({
      scope: input.scope,
      groupId: record.groupId,
      userId: record.userId,
      actorId: input.actorId,
      reason: input.reason ?? `处罚 ${label(record)}`,
      source: "card",
    });
    const updated: PunishmentRecord = {
      ...record,
      actions: { ...record.actions, blacklist: input.scope, kicked: true },
      updatedAt: this.now(),
    };
    this.records.set(updated.recordId, updated);
    this.persist(updated);
    return {
      ok: true,
      text: `已${input.scope === "global" ? "全局拉黑" : "拉黑本群"}处罚 ${label(updated)} 的当事人。${added.detail}`,
      record: updated,
    };
  }

  public async pruneOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (record.createdAt < cutoff) {
        this.records.delete(record.recordId);
        removed += 1;
      }
    }
    if (removed > 0 && this.repository) {
      this.queue?.enqueue("punishment.prune", () =>
        this.repository!.deleteOlderThan(cutoff),
      );
    }
    return removed;
  }

  /** 处罚记录展示名：`#ABC123（@某人）`。 */
  public labelOf(record: PunishmentRecord): string {
    return label(record);
  }

  private async notify(record: PunishmentRecord): Promise<void> {
    if (!this.notifier) {
      return;
    }
    try {
      await this.notifier.notifyPunishment(record);
    } catch (error) {
      log.warn("punishment notification failed", {
        recordId: record.recordId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persist(record: PunishmentRecord): void {
    if (this.repository) {
      this.queue?.enqueue("punishment.save", () =>
        this.repository!.save(record),
      );
    }
  }

  /** 单个官方动作失败只记日志（与 MessageGuard 的「失败不阻塞」一致）。 */
  private async attempt(
    labelName: string,
    action: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      log.warn("punishment action failed", {
        action: labelName,
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
    reason: string;
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
      reason: input.reason,
      createdAt: this.now(),
    };
    this.auditLog.append(record);
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = randomCode(SHORT_CODE_LENGTH, this.random);
      if (!this.records.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("处罚短码生成失败：连续碰撞，请检查随机源");
  }
}

function label(record: PunishmentRecord): string {
  return `#${record.recordId}`;
}

/** `#abc123` / `abc123` → `ABC123`。 */
export function normalizeCode(code: string | undefined): string | undefined {
  const trimmed = code?.trim().replace(/^#/u, "").trim();
  return trimmed && trimmed.length > 0 ? trimmed.toUpperCase() : undefined;
}


