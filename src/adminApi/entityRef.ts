import {
  SHORT_CODE_PREFIX,
  type ShortCodeKind,
} from "../services/shortCodes.js";

/**
 * 管理面里一个实体（人 / 群 / 申请）的展示信息。
 *
 * 用户口径：**选择与交互优先出绑定号（QQ号 / 群号），其次短码，完整官方长码只该出现在「详情」里**。
 * 以前列表直接把 `group_openid` / 用户 openid 摊在表格里（32 位十六进制，扫一眼认不出是谁，
 * 还会把列撑坏），这层把「展示文本」与「完整 id」分开返回，避免前端各写一套截断规则。
 */
export interface AdminApiEntityRef {
  /** `user` = QQ 号 / openid，`group` = 群号 / 群 openid，`request` = 入群申请。 */
  kind: "user" | "group" | "request";
  /** 完整官方 id：**只在详情行展示**（也是过滤器要用的值）。 */
  officialId: string;
  /** 优先展示文本：绑定号 → 短码 → 截断后的官方 id。 */
  label: string;
  /** 绑定号（群号 / QQ号）；没绑定时缺省。 */
  externalId?: string | undefined;
  /** 短码（含 `#`）；库里没有就缺省 —— 展示路径不造假码（见 `ShortCodeService.existingCode`）。 */
  shortCode?: string | undefined;
}

/** 解析实体展示信息所需的三个数据源（都可缺省，缺省即只回退到官方 id）。 */
export interface AdminApiEntitySource {
  /** openid → QQ 号（`IdentityMapService.getQq`）。 */
  qqOf?: ((userId: string) => string | undefined) | undefined;
  /** 群 openid → 群号（`IdentityMapService.getGroupNumber`）。 */
  groupNumberOf?: ((groupId: string) => string | undefined) | undefined;
  /** 内部 id → 已存在的短码（`ShortCodeService.existingCode`，不含 `#`）；不要传会造码的方法。 */
  shortCodeOf?:
    | ((kind: ShortCodeKind, targetId: string) => string | undefined)
    | undefined;
}

export interface AdminApiEntities {
  user(userId: string): AdminApiEntityRef;
  group(groupId: string): AdminApiEntityRef;
  request(requestId: string): AdminApiEntityRef;
}

/** 官方 id 的兜底展示：太长就截断（完整值始终在 `officialId` 里）。 */
export const ENTITY_ID_PREVIEW_HEAD = 8;
export const ENTITY_ID_PREVIEW_TAIL = 4;

export function previewOfficialId(officialId: string): string {
  const limit = ENTITY_ID_PREVIEW_HEAD + ENTITY_ID_PREVIEW_TAIL;
  if (officialId.length <= limit) {
    return officialId;
  }
  return `${officialId.slice(0, ENTITY_ID_PREVIEW_HEAD)}…${officialId.slice(-ENTITY_ID_PREVIEW_TAIL)}`;
}

/**
 * 造一个实体解析器（管理 API 的读端点用）。
 *
 * 口径与指令层的 `DisplayNameService` 一致（绑定号 → 短码），**唯一区别**是这里**只查不造短码**：
 * 列一页审计（几百条历史 actor）时现造短码会把短码表撑脏，所以查不到就退回截断后的官方 id，
 * 前端再把完整 id 放详情行里。
 */
export function createAdminApiEntities(
  source: AdminApiEntitySource = {},
): AdminApiEntities {
  const build = (
    kind: AdminApiEntityRef["kind"],
    officialId: string,
    externalId: string | undefined,
  ): AdminApiEntityRef => {
    const shortCode = source.shortCodeOf?.(shortCodeKindOf(kind), officialId);
    const label =
      externalId ??
      (shortCode === undefined ? undefined : `${SHORT_CODE_PREFIX}${shortCode}`) ??
      previewOfficialId(officialId);
    return {
      kind,
      officialId,
      label,
      ...(externalId !== undefined ? { externalId } : {}),
      ...(shortCode !== undefined
        ? { shortCode: `${SHORT_CODE_PREFIX}${shortCode}` }
        : {}),
    };
  };

  return {
    user: (userId) => build("user", userId, source.qqOf?.(userId)),
    group: (groupId) => build("group", groupId, source.groupNumberOf?.(groupId)),
    request: (requestId) => build("request", requestId, undefined),
  };
}

/** 短码表里的申请类型叫 `join_request`，展示层的 `kind` 叫 `request`（只差这一层映射）。 */
function shortCodeKindOf(kind: AdminApiEntityRef["kind"]): ShortCodeKind {
  return kind === "request" ? "join_request" : kind;
}
