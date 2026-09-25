import { compactText } from "../memberRoster.js";
import type { AdminCommandContext } from "./context.js";

/**
 * 展示名解析（R1 拆分）：把内部 id 换成用户能读懂的标识。
 *
 * 规则（`docs/DECISIONS.md` ADR-0036）：已绑定的 QQ号 / 群号直接展示；
 * 未绑定展示随机短码 `#XXXXXX`；**永远不暴露内部 openid**。
 * 没有注入 `DisplayNameService` 时（部分单测）回退为「绑定号 → 号，否则原样 id」。
 */
export function displayUser(
  ctx: AdminCommandContext,
  officialId: string,
): string {
  if (ctx.display) {
    return ctx.display.user(officialId);
  }
  return ctx.identityMap?.getQq(officialId) ?? officialId;
}

/** 展示群：群号 或随机短码 `#XXXXXX`。 */
export function displayGroup(ctx: AdminCommandContext, groupId: string): string {
  if (ctx.display) {
    return ctx.display.group(groupId);
  }
  return ctx.identityMap?.getGroupNumber(groupId) ?? groupId;
}

/** 展示申请：短码 `#XXXXXX`（替代又长又难读的 join_request_id）。 */
export function displayRequest(
  ctx: AdminCommandContext,
  requestId: string,
): string {
  return ctx.display?.request(requestId) ?? requestId;
}

/** 一组用户 id 的展示名（逗号分隔）。 */
export function displayUsers(
  ctx: AdminCommandContext,
  ids: readonly string[],
): string {
  return ids.length > 0
    ? ids.map((id) => displayUser(ctx, id)).join(", ")
    : "（空）";
}

/** 兼容导出：给需要按空白归一化后比较的调用方（与 `MemberRoster` 同一实现）。 */
export { compactText };
