import { randomBytes } from "node:crypto";

import { getLogger } from "../core/logger.js";
import {
  totalPrivacyCounts,
  type PrivacyCounts,
  type PrivacyExportSection,
  type PrivacyRepository,
} from "../db/privacyRepository.js";
import { CSV_MESSAGE_LIMIT, csvEscape } from "./activityExport.js";
import type { RichMessageSender } from "./richMessages.js";

const log = getLogger("privacy");

export interface PrivacyServiceOptions {
  /** 存储层（按表匿名化 / 导出取数）；缺省表示功能未装配。 */
  repository?: PrivacyRepository | undefined;
  /** 匿名化后重载内存态（资料 / 报名 / 短码 / 订阅）——不重载则内存里还认得出这个人。 */
  reload?: (() => Promise<void>) | undefined;
  /** 私信通道（导出 CSV 用）；未装配时导出只给文案。 */
  sender?: RichMessageSender | undefined;
  /** 占位 id 生成器（测试固定值用）。 */
  generateAnonId?: (() => string) | undefined;
  /** 单条私信字符预算；默认沿用活动导出的 1800。 */
  messageLimit?: number | undefined;
}

export interface PrivacyPlan {
  counts: PrivacyCounts;
  total: number;
}

export interface PrivacyResult extends PrivacyPlan {
  /** 本次生成的占位 id；`total = 0` 时为空串。 */
  anonId: string;
}

export interface PrivacyExportResult {
  ok: boolean;
  /** 给操作者的说明文案。 */
  text: string;
  rows: number;
}

/**
 * 个人数据匿名化与导出（D7）。
 *
 * 口径（`TODO.md` §2 D7，已确认）：
 * - **全部匿名化、不物理删行**：`user_id` 换成占位值、个人字段清空，幂等（已匿名化过再跑是 0 条）；
 * - `blacklist_entries` / `permission_grants` 保留生效、`audit_records` 保留（合规）；
 * - 导出 = 一段可复制的 CSV 私信给操作者，不落文件。
 */
export class PrivacyService {
  private readonly repository: PrivacyRepository | undefined;
  private readonly reload: (() => Promise<void>) | undefined;
  private readonly sender: RichMessageSender | undefined;
  private readonly generateAnonId: () => string;
  private readonly messageLimit: number;

  public constructor(options: PrivacyServiceOptions = {}) {
    this.repository = options.repository;
    this.reload = options.reload;
    this.sender = options.sender;
    this.generateAnonId =
      options.generateAnonId ?? (() => `anon:${randomBytes(6).toString("hex")}`);
    this.messageLimit = options.messageLimit ?? CSV_MESSAGE_LIMIT;
  }

  public get configured(): boolean {
    return this.repository !== undefined;
  }

  /** 预览：按表列出待匿名化条数（只读，不改库）。 */
  public async plan(userId: string): Promise<PrivacyPlan> {
    const counts = await this.requireRepository().scan(userId);
    return { counts, total: totalPrivacyCounts(counts) };
  }

  /** 执行匿名化（幂等：没有可匿名化的行时不做任何写入）。 */
  public async anonymize(userId: string): Promise<PrivacyResult> {
    const repository = this.requireRepository();
    const counts = await repository.scan(userId);
    const total = totalPrivacyCounts(counts);
    if (total === 0) {
      return { anonId: "", counts, total };
    }
    const anonId = this.generateAnonId();
    await repository.anonymize(userId, anonId);
    await this.reload?.();
    log.info("user data anonymized", { anonId, total });
    return { anonId, counts, total };
  }

  /** 导出为 CSV 并私信给操作者；超长时只回一份分节摘要。 */
  public async exportCsv(
    userId: string,
    operatorId: string,
  ): Promise<PrivacyExportResult> {
    const sections = await this.requireRepository().collect(userId);
    const rows = sections.reduce((sum, section) => sum + section.rows.length, 0);
    if (rows === 0) {
      return { ok: true, text: "没有查到该用户的数据。", rows: 0 };
    }
    const summary = sections
      .map((section) => `${section.title} ${section.rows.length} 行`)
      .join("；");
    if (this.sender === undefined) {
      return {
        ok: false,
        text: `已汇总 ${rows} 行（${summary}），但发送通道未启用，无法私信 CSV。`,
        rows,
      };
    }
    const csv = buildCsv(sections);
    if (csv.length > this.messageLimit) {
      log.info("privacy export too large for one message", {
        rows,
        chars: csv.length,
        limit: this.messageLimit,
      });
      return {
        ok: true,
        text: `共 ${rows} 行，超过单条消息长度上限（${this.messageLimit} 字），只发分节摘要：\n${summary}`,
        rows,
      };
    }
    const sent = await this.sender.sendPlainToUser(
      operatorId,
      `个人数据导出（CSV，共 ${rows} 行）\n\`\`\`csv\n${csv}\`\`\``,
    );
    if (!sent.ok) {
      log.warn("privacy export delivery failed", { error: sent.detail });
      return {
        ok: false,
        text: `已生成 CSV（${rows} 行），但私信失败：${sent.detail}`,
        rows,
      };
    }
    return { ok: true, text: `已私信 CSV（共 ${rows} 行）。`, rows };
  }

  private requireRepository(): PrivacyRepository {
    if (!this.repository) {
      throw new Error("个人数据功能未装配（缺少存储层）");
    }
    return this.repository;
  }
}

/** 分节 CSV：`# 标题` + 表头 + 数据行；空节不输出。 */
export function buildCsv(sections: readonly PrivacyExportSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`# ${section.title}`);
    lines.push(section.columns.map(csvEscape).join(","));
    for (const row of section.rows) {
      lines.push(row.map(csvEscape).join(","));
    }
  }
  return lines.join("\n");
}
