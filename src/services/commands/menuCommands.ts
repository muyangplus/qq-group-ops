import {
  buildMenu,
  buildUnknownCommandMenu,
  findMenuSection,
  type MenuContext,
} from "../menu.js";
import type { RichMessage } from "../richMessages.js";
import type { AdminCommandContext } from "./context.js";
import type { CommandResult } from "./support.js";

/**
 * `/menu` 领域模块：主菜单与各层级菜单的渲染入口。
 *
 * 菜单结构本身定义在 `src/services/menu.ts`；这里只负责组装 `MenuContext` 并交给它渲染，
 * 供门面 `AdminCommandService.mainMenu()` / `menuMessage()` 与回调 renderer 复用。
 */

/** 主菜单（`/menu`、空 `@机器人`、私信首次交互都走它）。 */
export function mainMenu(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): RichMessage {
  return buildMenu("main", menuContext(ctx, groupId, userId)).message;
}

/** 回调 renderer 用：渲染菜单的某一级（`cb:menu:open:<section>`）。 */
export function menuMessage(
  ctx: AdminCommandContext,
  section: string | undefined,
  groupId: string | undefined,
  userId: string,
): RichMessage {
  return buildMenu(
    findMenuSection(section) ?? "main",
    menuContext(ctx, groupId, userId),
  ).message;
}

/** 组装菜单上下文（与原门面实现逐字段等价）。 */
export function menuContext(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
): MenuContext {
  const context: MenuContext = {
    userId,
    groupId,
    // 与 buildHelp 保持一致：未注入身份映射时（单元测试）视为已绑定
    bound: ctx.identityMap ? Boolean(ctx.identityMap.getQq(userId)) : true,
    permissions: ctx.permissions,
  };
  if (ctx.display) {
    context.userLabel = ctx.display.user(userId);
  }
  if (groupId !== undefined) {
    if (ctx.display) {
      context.groupLabel = ctx.display.group(groupId);
    }
    if (ctx.identityMap) {
      context.groupBound = Boolean(ctx.identityMap.getGroupNumber(groupId));
    }
  }
  return context;
}

/** 未知指令：保留原来的报错文案，同时附上菜单入口按钮。 */
export function unknownCommandResult(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  command: string | undefined,
): CommandResult {
  const rich = buildUnknownCommandMenu(
    command ?? "",
    menuContext(ctx, groupId, userId),
  );
  return { ok: false, text: rich.text, rich };
}
