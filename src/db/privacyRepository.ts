import type { Queryable } from "./queryable.js";

/**
 * 个人数据匿名化 / 导出（D7，口径见 `TODO.md` §2 D7）。
 *
 * **全部匿名化、不物理删行**：把该用户的行里 `user_id`（或绑定键）换成一次操作生成的占位值，
 * 并清空个人字段。这样统计与去重不会断，但从「能关联到人」变成「关联不到」。
 *
 * 两张表**故意不动**（删号不等于解封 / 授权仍然有效）：
 * `blacklist_entries`、`permission_grants`；`audit_records` 同样保留（合规要求）。
 *
 * 为什么放在 db 层而不是各仓储：要按表改列，走仓储得给十几张表各加一遍改写方法，
 * 这里集中描述一次；改写完成后**调用方必须 `reload()` 内存态**，否则内存里还认得出这个人。
 */
export interface PrivacyCounts {
  bindings: number;
  profiles: number;
  joinRequests: number;
  registrations: number;
  waitlist: number;
  punishments: number;
  appeals: number;
  shortCodes: number;
  notifySubscriptions: number;
  notifyDeliveries: number;
  activitySubscriptions: number;
  activityNotifications: number;
  menuDeliveries: number;
}

export type PrivacyTargetKey = keyof PrivacyCounts;

/** 一次匿名化要碰的表：`{{user}}` 在统计时替换成 `$1`、改写时替换成 `$2`。 */
interface PrivacyStep {
  key: PrivacyTargetKey;
  label: string;
  /** 命中条件。 */
  where: string;
  /** 匿名化时改写的列；`$1` 固定是新的占位 id。 */
  assignments: string;
}

const STEPS: readonly PrivacyStep[] = [
  {
    key: "bindings",
    label: "身份绑定（openid ↔ QQ号）",
    where: "kind = 'user' AND official_id = {{user}}",
    // 绑定行本身就是「两个标识的对应关系」：把两边都换成占位值，唯一索引仍然成立
    assignments: "official_id = $1, external_id = $1, updated_at = NOW()",
  },
  {
    key: "profiles",
    label: "个人资料",
    where: "user_id = {{user}}",
    assignments:
      "user_id = $1, name = '', student_id = '', class_name = '', college = '', year = '', updated_at = NOW()",
  },
  {
    key: "joinRequests",
    label: "入群申请",
    where: "user_id = {{user}}",
    assignments: "user_id = $1, reason = ''",
  },
  {
    key: "registrations",
    label: "活动报名",
    where: "user_id = {{user}}",
    assignments: "user_id = $1, display_name = '', note = ''",
  },
  {
    key: "waitlist",
    label: "活动候补",
    where: "user_id = {{user}}",
    assignments: "user_id = $1, display_name = '', note = ''",
  },
  {
    key: "punishments",
    label: "处罚记录",
    where: "user_id = {{user}}",
    assignments: "user_id = $1, message_excerpt = '', updated_at = NOW()",
  },
  {
    key: "appeals",
    label: "申诉记录",
    where: "user_id = {{user}}",
    assignments: "user_id = $1, reason = '', note = ''",
  },
  {
    key: "shortCodes",
    label: "短码",
    where: "kind = 'user' AND target_id = {{user}}",
    assignments: "target_id = $1",
  },
  {
    key: "notifySubscriptions",
    label: "通知订阅",
    where: "user_id = {{user}}",
    assignments: "user_id = $1",
  },
  {
    key: "notifyDeliveries",
    label: "通知投递记录",
    where: "user_id = {{user}}",
    assignments: "user_id = $1",
  },
  {
    key: "activitySubscriptions",
    label: "活动订阅",
    where: "user_id = {{user}}",
    assignments: "user_id = $1",
  },
  {
    key: "activityNotifications",
    label: "活动通知去重",
    where: "user_id = {{user}}",
    assignments: "user_id = $1",
  },
  {
    key: "menuDeliveries",
    label: "主菜单推送去重",
    where: "user_id = {{user}}",
    assignments: "user_id = $1",
  },
];

/** 表名只在这里出现一次，避免每张表写两遍 SQL。 */
const TABLES: Record<PrivacyTargetKey, { table: string; select: string }> = {
  bindings: {
    table: "identity_bindings",
    select: "SELECT kind, official_id, external_id, created_at FROM identity_bindings",
  },
  profiles: {
    table: "user_profiles",
    select:
      "SELECT user_id, name, student_id, class_name, college, year, updated_at FROM user_profiles",
  },
  joinRequests: {
    table: "join_requests",
    select:
      "SELECT request_id, group_id, user_id, reason, status, created_at, reviewed_at FROM join_requests",
  },
  registrations: {
    table: "activity_registrations",
    select:
      "SELECT registration_id, activity_id, group_id, user_id, display_name, note, created_at FROM activity_registrations",
  },
  waitlist: {
    table: "activity_waitlist",
    select: "SELECT activity_id, user_id, display_name, note, created_at FROM activity_waitlist",
  },
  punishments: {
    table: "punishment_records",
    select:
      "SELECT record_id, group_id, user_id, rule_reason, actions, detail, status, created_at FROM punishment_records",
  },
  appeals: {
    table: "appeal_records",
    select:
      "SELECT appeal_id, punishment_id, group_id, user_id, reason, status, reviewer_id, note, created_at, reviewed_at FROM appeal_records",
  },
  shortCodes: {
    table: "short_codes",
    select: "SELECT code, kind, target_id, created_at FROM short_codes",
  },
  notifySubscriptions: {
    table: "notification_subscriptions",
    select: "SELECT user_id, scope, created_at FROM notification_subscriptions",
  },
  notifyDeliveries: {
    table: "notification_deliveries",
    select:
      "SELECT group_id, request_id, user_id, status, detail, created_at FROM notification_deliveries",
  },
  activitySubscriptions: {
    table: "activity_subscriptions",
    select: "SELECT group_id, user_id, created_at FROM activity_subscriptions",
  },
  activityNotifications: {
    table: "activity_notifications",
    select: "SELECT activity_id, user_id, kind, created_at FROM activity_notifications",
  },
  menuDeliveries: {
    table: "menu_deliveries",
    select: "SELECT user_id, pushed_at FROM menu_deliveries",
  },
};

/** 目标表清单（预览卡按这个顺序列条数）。 */
export const PRIVACY_TARGETS: ReadonlyArray<{
  key: PrivacyTargetKey;
  label: string;
}> = STEPS.map((step) => ({ key: step.key, label: step.label }));

export interface PrivacyExportSection {
  key: string;
  title: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
}

function withUser(template: string, placeholder: string): string {
  return template.replaceAll("{{user}}", placeholder);
}

export interface PrivacyRepository {
  /** 待匿名化条数（按表）。 */
  scan(userId: string): Promise<PrivacyCounts>;
  /** 执行匿名化：`anonId` 是这次操作生成的占位值。 */
  anonymize(userId: string, anonId: string): Promise<void>;
  /** 导出该用户的数据（含故意保留的黑名单 / 授权，便于当事人核对）。 */
  collect(userId: string): Promise<PrivacyExportSection[]>;
}

export class SqlPrivacyRepository implements PrivacyRepository {
  public constructor(private readonly db: Queryable) {}

  public async scan(userId: string): Promise<PrivacyCounts> {
    const counts = emptyCounts();
    for (const step of STEPS) {
      const { table } = TABLES[step.key];
      const result = await this.db.query<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${withUser(step.where, "$1")}`,
        [userId],
      );
      counts[step.key] = Number(result.rows[0]?.n ?? 0);
    }
    return counts;
  }

  public async anonymize(userId: string, anonId: string): Promise<void> {
    for (const step of STEPS) {
      const { table } = TABLES[step.key];
      await this.db.query(
        `UPDATE ${table} SET ${step.assignments} WHERE ${withUser(step.where, "$2")}`,
        [anonId, userId],
      );
    }
  }

  public async collect(userId: string): Promise<PrivacyExportSection[]> {
    const sections: PrivacyExportSection[] = [];
    for (const step of STEPS) {
      const { select } = TABLES[step.key];
      const result = await this.db.query<Record<string, unknown>>(
        `${select} WHERE ${withUser(step.where, "$1")} ORDER BY 1 ASC`,
        [userId],
      );
      if (result.rows.length === 0) {
        continue;
      }
      const columns = Object.keys(result.rows[0]!);
      sections.push({
        key: step.key,
        title: step.label,
        columns,
        rows: result.rows.map((row) =>
          columns.map((column) => formatCell(row[column])),
        ),
      });
    }
    // 故意保留的两类管理数据也让当事人看得到（黑名单 / 授权）
    sections.push(
      ...(await this.collectKept(userId)),
    );
    return sections;
  }

  /** `blacklist_entries` 与 `permission_grants` 属于「保留生效」的管理数据，导出时照实列出。 */
  private async collectKept(userId: string): Promise<PrivacyExportSection[]> {
    const blacklist = await this.db.query<Record<string, unknown>>(
      `SELECT scope, group_id, reason, actor_id, source, created_at
       FROM blacklist_entries WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    const grants = await this.db.query<Record<string, unknown>>(
      `SELECT scope, group_id, granted_at
       FROM permission_grants WHERE user_id = $1 ORDER BY granted_at ASC`,
      [userId],
    );
    const sections: PrivacyExportSection[] = [];
    if (blacklist.rows.length > 0) {
      const columns = Object.keys(blacklist.rows[0]!);
      sections.push({
        key: "blacklist",
        title: "黑名单（管理数据，保留生效）",
        columns,
        rows: blacklist.rows.map((row) =>
          columns.map((column) => formatCell(row[column])),
        ),
      });
    }
    if (grants.rows.length > 0) {
      const columns = Object.keys(grants.rows[0]!);
      sections.push({
        key: "grants",
        title: "权限授权（管理数据，保留生效）",
        columns,
        rows: grants.rows.map((row) =>
          columns.map((column) => formatCell(row[column])),
        ),
      });
    }
    return sections;
  }
}

export function emptyCounts(): PrivacyCounts {
  return {
    bindings: 0,
    profiles: 0,
    joinRequests: 0,
    registrations: 0,
    waitlist: 0,
    punishments: 0,
    appeals: 0,
    shortCodes: 0,
    notifySubscriptions: 0,
    notifyDeliveries: 0,
    activitySubscriptions: 0,
    activityNotifications: 0,
    menuDeliveries: 0,
  };
}

export function totalPrivacyCounts(counts: PrivacyCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
