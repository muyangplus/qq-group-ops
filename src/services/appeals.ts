import { randomInt } from "node:crypto";

import { getLogger } from "../core/logger.js";
import { utcNow } from "../core/models.js";
import type {
  AppealRecord,
  AppealRepository,
  AppealStatus,
} from "../db/appealRepository.js";
import type { PunishmentRecord } from "../db/punishmentRepository.js";
import { WriteQueue } from "../db/writeQueue.js";
import { randomCode, SHORT_CODE_LENGTH } from "./shortCodes.js";

const log = getLogger("appeals");

const MAX_CODE_ATTEMPTS = 20;

export interface AppealOptions {
  repository?: AppealRepository | undefined;
  queue?: WriteQueue | undefined;
  now?: (() => Date) | undefined;
  randomInt?: ((max: number) => number) | undefined;
}

export interface AppealSubmitInput {
  punishment: PunishmentRecord;
  /** 申诉人；必须是被处罚人本人。 */
  userId: string;
  reason?: string | undefined;
}

export interface AppealSubmitResult {
  appeal: AppealRecord;
  /** `true` = 更新了已有的待处理申诉（不会重复推送）。 */
  updated: boolean;
}

/**
 * 申诉服务（§B8）。
 *
 * 同一条处罚的同一当事人只保留**一条待处理申诉**：重复提交只更新理由，
 * 因此不会因为反复 `/appeal` 而给审核员刷屏。
 */
export class AppealService {
  private readonly appeals = new Map<string, AppealRecord>();
  private readonly repository: AppealRepository | undefined;
  private readonly queue: WriteQueue | undefined;
  private readonly now: () => Date;
  private readonly random: (max: number) => number;

  public constructor(options: AppealOptions = {}) {
    this.repository = options.repository;
    this.queue =
      options.repository !== undefined
        ? (options.queue ?? new WriteQueue())
        : undefined;
    this.now = options.now ?? (() => utcNow());
    this.random = options.randomInt ?? ((max) => randomInt(max));
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    const records = await this.repository?.findAll();
    this.appeals.clear();
    for (const record of records ?? []) {
      this.appeals.set(record.appealId, record);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public get(code: string | undefined): AppealRecord | undefined {
    const normalized = normalizeAppealCode(code);
    return normalized ? this.appeals.get(normalized) : undefined;
  }

  public pendingFor(
    punishmentId: string,
    userId: string,
  ): AppealRecord | undefined {
    return this.all().find(
      (appeal) =>
        appeal.punishmentId === punishmentId &&
        appeal.userId === userId &&
        appeal.status === "pending",
    );
  }

  /** 某条处罚下所有待处理申诉（卡片调整处罚后统一标记为「已调整」）。 */
  public pendingByPunishment(punishmentId: string): AppealRecord[] {
    return this.all().filter(
      (appeal) =>
        appeal.punishmentId === punishmentId && appeal.status === "pending",
    );
  }

  /** 全部待处理申诉（申诉值班轮转服务按它推进转派）。 */
  public listPending(): AppealRecord[] {
    return this.all().filter((appeal) => appeal.status === "pending");
  }

  public listForUser(userId: string, limit = 10): AppealRecord[] {
    return this.all()
      .filter((appeal) => appeal.userId === userId)
      .slice(0, limit);
  }

  /** 提交 / 更新申诉（已存在待处理申诉时只更新理由）。 */
  public async submit(input: AppealSubmitInput): Promise<AppealSubmitResult> {
    const existing = this.pendingFor(
      input.punishment.recordId,
      input.userId,
    );
    const reason = input.reason?.trim() ?? "";
    if (existing) {
      const updated: AppealRecord = {
        ...existing,
        ...(reason.length > 0 ? { reason } : {}),
      };
      this.appeals.set(updated.appealId, updated);
      this.persist(updated);
      return { appeal: updated, updated: true };
    }
    const record: AppealRecord = {
      appealId: this.generateCode(),
      punishmentId: input.punishment.recordId,
      groupId: input.punishment.groupId,
      userId: input.userId,
      reason,
      status: "pending",
      reviewerId: "",
      note: "",
      createdAt: this.now(),
    };
    this.appeals.set(record.appealId, record);
    this.persist(record);
    log.info("appeal submitted", {
      groupId: record.groupId,
      appealId: record.appealId,
      punishmentId: record.punishmentId,
    });
    return { appeal: record, updated: false };
  }

  /** 审核员在卡片上通过 / 驳回申诉。 */
  public async decide(input: {
    code: string;
    reviewerId: string;
    status: Exclude<AppealStatus, "pending">;
    note?: string | undefined;
  }): Promise<AppealRecord | undefined> {
    const appeal = this.get(input.code);
    if (!appeal) {
      return undefined;
    }
    const updated: AppealRecord = {
      ...appeal,
      status: input.status,
      reviewerId: input.reviewerId,
      note: input.note?.trim() ?? "",
      reviewedAt: this.now(),
    };
    this.appeals.set(updated.appealId, updated);
    this.persist(updated);
    log.info("appeal decided", {
      appealId: updated.appealId,
      status: updated.status,
      reviewerId: input.reviewerId,
    });
    return updated;
  }

  /**
   * 审核员在卡片上「调整处罚」时，把该处罚下所有待处理申诉标记为已处理
   * （`accepted` + 备注），避免申诉列表里长期挂着已处理的记录。
   */
  public async acceptByPunishment(input: {
    punishmentId: string;
    reviewerId: string;
    note: string;
  }): Promise<AppealRecord[]> {
    const decided: AppealRecord[] = [];
    for (const appeal of this.pendingByPunishment(input.punishmentId)) {
      const updated = await this.decide({
        code: appeal.appealId,
        reviewerId: input.reviewerId,
        status: "accepted",
        note: input.note,
      });
      if (updated) {
        decided.push(updated);
      }
    }
    return decided;
  }

  public async pruneOlderThan(cutoff: Date): Promise<number> {
    const stale = this.all().filter(
      (appeal) => appeal.createdAt < cutoff && appeal.status !== "pending",
    );
    for (const appeal of stale) {
      this.appeals.delete(appeal.appealId);
    }
    if (stale.length > 0 && this.repository) {
      this.queue?.enqueue("appeal.prune", () =>
        this.repository!.deleteOlderThan(cutoff),
      );
    }
    return stale.length;
  }

  private all(): AppealRecord[] {
    return [...this.appeals.values()].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
  }

  private persist(record: AppealRecord): void {
    if (this.repository) {
      this.queue?.enqueue("appeal.save", () => this.repository!.save(record));
    }
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = randomCode(SHORT_CODE_LENGTH, this.random);
      if (!this.appeals.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("申诉短码生成失败：连续碰撞，请检查随机源");
  }
}

/** `#abc123` / `abc123` → `ABC123`。 */
export function normalizeAppealCode(code: string | undefined): string | undefined {
  const trimmed = code?.trim().replace(/^#/u, "").trim();
  return trimmed && trimmed.length > 0 ? trimmed.toUpperCase() : undefined;
}

/** 申诉记录展示名 `#ABC123`。 */
export function appealLabel(appeal: AppealRecord): string {
  return `#${appeal.appealId}`;
}
