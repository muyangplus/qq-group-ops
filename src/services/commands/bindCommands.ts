import { getLogger } from "../../core/logger.js";
import type { AdminCommandContext } from "./context.js";
import {
  type CommandResult,
  bindingFailureText,
  formatError,
  normalize,
} from "./support.js";

/**
 * `/bind` 域：QQ 号 / 群号 / openid 绑定（自助 + 超管代绑）。
 */

const log = getLogger("admin-commands");

export async function handleBind(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const target = normalize(parts[1]);
  if (!target) {
    return {
      ok: false,
      text:
        "用法：\n" +
        "/bind qq <QQ号>\n" +
        "/bind group <群号>\n" +
        "/bind user <userId> <QQ号>（超管）\n" +
        "/bind groupid <group_openid> <群号>（超管）",
    };
  }

  if (target === "qq") {
    const qq = parts[2]?.trim();
    if (!qq) {
      return { ok: false, text: "用法：/bind qq <QQ号>" };
    }
    try {
      await ctx.identityMap?.bindUser(userId, qq);
    } catch (error) {
      log.error("bind user qq failed", {
        userId,
        error: formatError(error),
      });
      return { ok: false, text: bindingFailureText() };
    }
    log.info("bound user qq", { userId, qq });
    return {
      ok: true,
      text: `已绑定：QQ ${qq}`,
    };
  }

  if (target === "group") {
    const groupNumber = parts[2]?.trim();
    if (!groupId || !groupNumber) {
      return {
        ok: false,
        text: "该指令需要在群内使用。用法：/bind group <群号>",
      };
    }
    if (
      !ctx.permissions.canApproveJoin(userId, groupId) &&
      !ctx.permissions.isSuperAdmin(userId)
    ) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    try {
      await ctx.identityMap?.bindGroup(groupId, groupNumber);
    } catch (error) {
      log.error("bind group number failed", {
        groupId,
        userId,
        error: formatError(error),
      });
      return { ok: false, text: bindingFailureText() };
    }
    log.info("bound group number", { groupId, groupNumber, userId });
    return {
      ok: true,
      text: `已绑定：群号 ${groupNumber}`,
    };
  }

  if (target === "user") {
    if (!ctx.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：仅超级管理员可以绑定任意用户。" };
    }
    const officialId = parts[2]?.trim();
    const qq = parts[3]?.trim();
    if (!officialId || !qq) {
      return { ok: false, text: "用法：/bind user <userId> <QQ号>" };
    }
    try {
      await ctx.identityMap?.bindUser(officialId, qq);
    } catch (error) {
      log.error("bind user failed", {
        officialId,
        operator: userId,
        error: formatError(error),
      });
      return { ok: false, text: bindingFailureText() };
    }
    log.info("bound user qq", { officialId, qq, operator: userId });
    return {
      ok: true,
      text: `已绑定：QQ ${qq}`,
    };
  }

  if (target === "groupid") {
    if (!ctx.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：仅超级管理员可以绑定任意群。" };
    }
    const officialId = parts[2]?.trim();
    const groupNumber = parts[3]?.trim();
    if (!officialId || !groupNumber) {
      return { ok: false, text: "用法：/bind groupid <group_openid> <群号>" };
    }
    try {
      await ctx.identityMap?.bindGroup(officialId, groupNumber);
    } catch (error) {
      log.error("bind group failed", {
        officialId,
        operator: userId,
        error: formatError(error),
      });
      return { ok: false, text: bindingFailureText() };
    }
    log.info("bound group number", {
      officialId,
      groupNumber,
      operator: userId,
    });
    return {
      ok: true,
      text: `已绑定：群号 ${groupNumber}`,
    };
  }

  return {
    ok: false,
    text:
      "未知绑定类型。用法：\n" +
      "/bind qq <QQ号>\n" +
      "/bind group <群号>\n" +
      "/bind user <userId> <QQ号>（超管）\n" +
      "/bind groupid <group_openid> <群号>（超管）",
  };
}
