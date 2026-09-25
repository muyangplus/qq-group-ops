import { getLogger } from "../core/logger.js";
import type { Activity, ActivityRegistration, ActivityWaitlistEntry } from "./activity.js";
import { code as activityCode } from "./activityCards.js";
import type { RichMessageSender } from "./richMessages.js";
import type { UserProfile } from "./userProfiles.js";

const log = getLogger("activity-export");

/**
 * 单条私信的字符预算。
 *
 * 官方单条消息正文有长度上限，CSV 又是「越长越容易超」的内容，因此这里保守
 * 取 1800 字符：超出就**不硬塞**，改为提示用 `/export` 拿完整文件。
 */
export const CSV_MESSAGE_LIMIT = 1800;

/** 导出行（含候补标记）。 */
export interface ActivityExportRow {
  serial: number;
  name: string;
  studentId: string;
  className: string;
  college: string;
  note: string;
  waitlisted: boolean;
}

export interface ActivityExportInput {
  activity: Activity;
  registrations: readonly ActivityRegistration[];
  /** 候补名单（CSV 里带「候补」标记，排在正式报名之后）。 */
  waitlist?: readonly ActivityWaitlistEntry[] | undefined;
  operatorId: string;
}

export interface ActivityExportServiceOptions {
  /** 私信通道（复用 `RichMessageSender.sendPlainToUser`）。 */
  sender?: RichMessageSender | undefined;
  /** 资料查询；缺省时对应列留空。 */
  profiles?: { get(userId: string): UserProfile | undefined } | undefined;
  /** 单条消息字符预算；默认 `CSV_MESSAGE_LIMIT`。 */
  messageLimit?: number | undefined;
}

/**
 * 活动名单 CSV 导出（§B3）。
 *
 * 用户确认的列：**序号 / 姓名 / 学号 / 班级 / 学院 / 备注 / 候补标记**。
 * 学号 / 班级 / 学院都是隐私字段，因此**只私信给操作者本人**（群里不回执内容）。
 *
 * 长度策略：超过 `messageLimit` 就不再发代码块，改成提示「改用 /export」——
 * 硬塞会被平台截断，用户反而拿到半份名单。
 */
export class ActivityExportService {
  private readonly sender: RichMessageSender | undefined;
  private readonly profiles: { get(userId: string): UserProfile | undefined } | undefined;
  private readonly messageLimit: number;

  public constructor(options: ActivityExportServiceOptions = {}) {
    this.sender = options.sender;
    this.profiles = options.profiles;
    this.messageLimit = options.messageLimit ?? CSV_MESSAGE_LIMIT;
  }

  /**
   * 生成 CSV 并把内容私信给操作者。
   *
   * 返回 `{ ok, text }`：`text` 是给操作者的说明（成功/失败原因），
   * 由调用方渲染成卡片；CSV 本体不落在群消息里。
   */
  public async exportCsv(
    input: ActivityExportInput,
  ): Promise<{ ok: boolean; text: string }> {
    const csv = this.buildCsv(input);
    const rows = countRows(input);
    const label = activityCode(input.activity);
    if (!this.sender) {
      return { ok: false, text: "发送通道未启用，无法私信 CSV。" };
    }
    if (csv.length > this.messageLimit) {
      log.info("activity export too large for one message", {
        activityId: input.activity.activityId,
        bytes: csv.length,
        limit: this.messageLimit,
      });
      const fallback = await this.sender.sendPlainToUser(
        input.operatorId,
        `活动 ${label} 的名单共 ${rows} 行，超过单条消息长度上限。请在客户端使用 /export ${label} 获取完整文件。`,
      );
      return fallback.ok
        ? {
            ok: true,
            text: `名单 ${rows} 行超过单条消息上限，已私信提示改用 /export。`,
          }
        : { ok: false, text: `私信失败：${fallback.detail}` };
    }
    const sent = await this.sender.sendPlainToUser(
      input.operatorId,
      `活动 ${label} 名单（CSV，共 ${rows} 行）\n\`\`\`csv\n${csv}\`\`\``,
    );
    if (!sent.ok) {
      log.warn("activity export delivery failed", {
        activityId: input.activity.activityId,
        error: sent.detail,
      });
      return {
        ok: false,
        text: `已生成 CSV，但私信失败（${sent.detail}）；请先私聊机器人再试。`,
      };
    }
    log.info("activity export delivered", {
      activityId: input.activity.activityId,
      rows,
      operatorId: input.operatorId,
    });
    return { ok: true, text: `已私信导出 ${rows} 行 CSV。` };
  }

  /** 只生成 CSV 文本（不发送），便于测试与复用。 */
  public buildCsv(input: ActivityExportInput): string {
    const header = ["序号", "姓名", "学号", "班级", "学院", "备注", "候补"];
    const rows = this.buildRows(input);
    return [header, ...rows.map(rowToCells)]
      .map((row) => row.map(csvEscape).join(","))
      .join("\n")
      .concat("\n");
  }

  /** 导出模型：正式报名在前，候补在后，序号连续。 */
  public buildRows(input: ActivityExportInput): ActivityExportRow[] {
    const rows: ActivityExportRow[] = [];
    let serial = 0;
    for (const registration of input.registrations) {
      serial += 1;
      rows.push(this.toRow(serial, registration.userId, registration.displayName, registration.note, false));
    }
    for (const entry of input.waitlist ?? []) {
      serial += 1;
      rows.push(this.toRow(serial, entry.userId, entry.displayName, entry.note, true));
    }
    return rows;
  }

  private toRow(
    serial: number,
    userId: string,
    displayName: string,
    note: string,
    waitlisted: boolean,
  ): ActivityExportRow {
    const profile = this.profiles?.get(userId);
    return {
      serial,
      name: displayName.trim(),
      studentId: profile?.studentId ?? "",
      className: profile?.className ?? "",
      college: profile?.college ?? "",
      note: note.trim(),
      waitlisted,
    };
  }
}

function countRows(input: ActivityExportInput): number {
  return input.registrations.length + (input.waitlist?.length ?? 0);
}

function rowToCells(row: ActivityExportRow): string[] {
  return [
    String(row.serial),
    row.name,
    row.studentId,
    row.className,
    row.college,
    row.note,
    row.waitlisted ? "候补" : "",
  ];
}

/** CSV 转义：含逗号 / 引号 / 换行的字段加引号，内部引号翻倍。 */
export function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
