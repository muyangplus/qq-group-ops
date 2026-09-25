import type { AdminCommandContext } from "./context.js";

/**
 * 目标参数解析（R1 拆分）：把用户输入的 `QQ号 / openid / #短码` 解析成内部 id。
 *
 * 纯函数式：只读 `ctx.display` 与 `ctx.identityMap`，不依赖门面类，便于各领域模块复用与单测。
 */

/** 用户参数：`#用户短码` 优先，否则按 QQ号 / userId 解析。 */
export function resolveUserId(
  ctx: AdminCommandContext,
  input: string | undefined,
): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  // `#短码` 优先；否则按 QQ号/openid 解析
  const fromCode = ctx.display?.resolveUser(trimmed);
  if (fromCode) {
    return fromCode;
  }
  return ctx.identityMap?.resolveUserId(trimmed) ?? trimmed;
}

/** 群参数：群内直接用当前群；私聊按 `#群短码` → 绑定群号 → group_openid 解析。 */
export function resolveTargetGroupId(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  input: string | undefined,
): string | undefined {
  if (groupId) {
    return groupId;
  }
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  const fromCode = ctx.display?.resolveGroup(trimmed);
  if (fromCode) {
    return fromCode;
  }
  if (!ctx.identityMap) {
    return trimmed;
  }
  return ctx.identityMap.resolveGroupId(trimmed);
}

/** 申请参数：`#短码`（推荐）或完整 join_request_id。 */
export function resolveRequestId(
  ctx: AdminCommandContext,
  input: string | undefined,
): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  return ctx.display?.resolveRequest(trimmed) ?? trimmed;
}
