/**
 * `/api/audit` 的筛选（只读）：时间范围 / 操作人 / 操作对象 / 动作 / 状态。
 *
 * 为什么单独一个纯模块：筛选逻辑要能单测（边界与坏值），
 * 而 HTTP 层只该做「取参数 → 过滤 → 分页」。
 *
 * 两条口径：
 * - **操作人 / 操作对象按「人念得出来的名字」匹配**：内部 id、绑定的 QQ号、`#短码`、
 *   以及展示名都算命中 —— 页面上复制一个 QQ号过来就能筛，不必先去翻「详情」里的 openid；
 * - **时间参数**：`YYYY-MM-DD`（按**本地日**，`to` 含当天最后一毫秒）或 ISO 时间；
 *   认不出来就抛错（HTTP 层回 400），**不静默忽略**（否则会以为筛了其实没筛）。
 */

/** 过滤器用得到的字段（与 `AdminApiAuditRecord` 结构兼容，避免模块间循环依赖）。 */
export interface AuditFilterableRef {
  label: string;
  externalId?: string | undefined;
  shortCode?: string | undefined;
}

export interface AuditFilterableRecord {
  groupId: string;
  actorId: string;
  actor: AuditFilterableRef;
  action: string;
  status: string;
  createdAt: string | number;
  targetUserId?: string | undefined;
  target?: AuditFilterableRef | undefined;
}

export interface AuditFilters {
  group?: string | undefined;
  actor?: string | undefined;
  target?: string | undefined;
  action?: string | undefined;
  status?: string | undefined;
  /** 起始时刻（含）；`YYYY-MM-DD` 按本地日 00:00:00.000。 */
  from?: Date | undefined;
  /** 结束时刻（含）；`YYYY-MM-DD` 按本地日 23:59:59.999。 */
  to?: Date | undefined;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * 解析时间参数：`YYYY-MM-DD`（本地日）或 ISO 时间。
 *
 * `to` 用日期时**含当天最后一毫秒** —— 否则「筛到 10-03」会把 10-03 当天的记录全漏掉。
 */
export function parseAuditBound(raw: string, bound: "from" | "to"): Date {
  const value = raw.trim();
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split("-").map((part) => Number(part));
    const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
    // `new Date(2026, 12, 99)` 会**顺延**成有效日期，所以要回读一遍字段，防止 2026-13-99 蒙混过关
    if (
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() !== (month ?? 1) - 1 ||
      date.getDate() !== day
    ) {
      throw new Error(`时间格式不认识：${value}（用 YYYY-MM-DD 或 ISO 时间）`);
    }
    if (bound === "to") {
      date.setHours(23, 59, 59, 999);
    }
    return date;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`时间格式不认识：${value}（用 YYYY-MM-DD 或 ISO 时间）`);
  }
  return date;
}

/** 这个「人」是否命中筛选：内部 id / 绑定号 / #短码（忽略大小写）/ 展示名。 */
function matchesParty(
  raw: string,
  id: string | undefined,
  ref: AuditFilterableRef | undefined,
): boolean {
  if (id !== undefined && id === raw) {
    return true;
  }
  if (!ref) {
    return false;
  }
  if (ref.externalId !== undefined && ref.externalId === raw) {
    return true;
  }
  if (
    ref.shortCode !== undefined &&
    ref.shortCode.toUpperCase() === raw.toUpperCase()
  ) {
    return true;
  }
  return ref.label === raw;
}

/** 逐条判定（`groupId` 传空串表示「不做群过滤」的调用方自己处理）。 */
export function filterAuditRecords<T extends AuditFilterableRecord>(
  records: readonly T[],
  filters: AuditFilters,
): T[] {
  return records.filter((record) => {
    if (filters.group !== undefined && record.groupId !== filters.group) {
      return false;
    }
    if (
      filters.actor !== undefined &&
      !matchesParty(filters.actor, record.actorId, record.actor)
    ) {
      return false;
    }
    if (
      filters.target !== undefined &&
      !matchesParty(filters.target, record.targetUserId, record.target)
    ) {
      return false;
    }
    if (filters.action !== undefined && record.action !== filters.action) {
      return false;
    }
    if (filters.status !== undefined && record.status !== filters.status) {
      return false;
    }
    if (filters.from !== undefined || filters.to !== undefined) {
      const at = new Date(record.createdAt);
      const time = at.getTime();
      if (Number.isNaN(time)) {
        return false;
      }
      if (filters.from !== undefined && time < filters.from.getTime()) {
        return false;
      }
      if (filters.to !== undefined && time > filters.to.getTime()) {
        return false;
      }
    }
    return true;
  });
}
