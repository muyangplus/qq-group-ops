import type { AdminApiEntityRef } from "@/api/admin";

/**
 * 展示层的统一口径（E2-e）：**优先出绑定号（QQ号 / 群号），其次短码，
 * 完整官方长码只放在「详情」里**。
 *
 * 后端已经在 `AdminApiEntityRef.label` 里算好了优先级，这里只负责三件前端专属的事：
 * 1. 全局默认群（`__default__`）不显示成短码，直接叫「全局默认」；
 * 2. 兜底：老响应 / 缺字段时退回调用方给的原始 id；
 * 3. 把「详情」要展示的几行拼好，页面不用各写一套。
 */

/** 全局默认群在库里的内部标识（与后端 `DEFAULT_GROUP_ID` 一致）。 */
export const GLOBAL_GROUP_ID = "__default__";

/** 展示文本（选择器 / 表格单元格用它）。 */
export function entityLabel(
  ref: AdminApiEntityRef | undefined,
  fallback: string,
): string {
  if (ref?.kind === "group" && ref.officialId === GLOBAL_GROUP_ID) {
    return "全局默认";
  }
  const label = ref?.label?.trim();
  return label !== undefined && label.length > 0 ? label : fallback;
}

/** 群展示文本（`groupId` 是内部 id，`ref` 可缺省）。 */
export function groupLabel(
  ref: AdminApiEntityRef | undefined,
  groupId: string,
): string {
  return entityLabel(ref ?? { kind: "group", officialId: groupId, label: groupId }, groupId);
}

export interface EntityDetailRow {
  label: string;
  value: string;
  /** 长 id 这类值建议等宽显示。 */
  mono?: boolean;
}

const ID_LABELS: Record<AdminApiEntityRef["kind"], string> = {
  user: "用户 ID（openid）",
  group: "群 ID（group_openid）",
  request: "申请 ID（join_request_id）",
};

const EXTERNAL_LABELS: Record<AdminApiEntityRef["kind"], string> = {
  user: "QQ 号",
  group: "群号",
  request: "绑定号",
};

/**
 * 「详情」里的几行：绑定号 → 短码 → 完整官方 id。
 *
 * 完整 id 永远有（哪怕它是空串：平台级动作的群就是空串，页面自己决定要不要跳过）。
 */
export function entityDetailRows(
  ref: AdminApiEntityRef,
): EntityDetailRow[] {
  const rows: EntityDetailRow[] = [];
  if (ref.kind === "group" && ref.officialId === GLOBAL_GROUP_ID) {
    return [{ label: "范围", value: "平台全局（无群号）", mono: false }];
  }
  if (ref.externalId !== undefined && ref.externalId.length > 0) {
    rows.push({ label: EXTERNAL_LABELS[ref.kind], value: ref.externalId, mono: true });
  }
  if (ref.shortCode !== undefined && ref.shortCode.length > 0) {
    rows.push({ label: "短码", value: ref.shortCode, mono: true });
  }
  rows.push({ label: ID_LABELS[ref.kind], value: ref.officialId, mono: true });
  return rows;
}

/** 平台级动作的群 id 是空串：详情里不必列一行空的「群 ID」。 */
export function isEmptyGroupRef(ref: AdminApiEntityRef | undefined): boolean {
  return ref !== undefined && ref.kind === "group" && ref.officialId.length === 0;
}
