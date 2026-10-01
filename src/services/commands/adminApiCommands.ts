import type { AdminApiLinkService } from "../../adminApi/loginLink.js";
import { getLogger } from "../../core/logger.js";
import type { AdminCommandContext } from "./context.js";
import { cardFromText, viewButton, type CommandResult } from "./support.js";

const log = getLogger("admin-commands");

const ADMIN_USAGE = [
  "用法（仅全局超管、只在私信）：",
  "  /admin login        签发一次性登录令牌，并给出管理后台登录链接",
  "  /admin status       看管理 API 是否开启",
].join("\n");

/**
 * `/admin`：管理后台登录令牌（E1-b，认证方案 B2）。
 *
 * 为什么只在私信：令牌等价于登录凭据，发在群里等于把后台入口贴给全群。
 * 令牌只存 sha256、一次性、默认 10 分钟过期；浏览器兑换后才种会话 cookie。
 */
export async function handleAdmin(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  operatorId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const action = (parts[1] ?? "").trim().toLowerCase();
  const service = ctx.adminApi;

  if (!service) {
    return deny("管理后台", "功能未装配：本进程没有令牌仓储（需要连接数据库）。");
  }
  if (!service.enabled) {
    return deny(
      "管理后台未开启",
      "管理 API 没有开启（`ADMIN_API_ENABLED`）。开启并重启管理 API 进程后再试。",
    );
  }
  if (groupId !== undefined) {
    return deny(
      "只在私信执行",
      "登录令牌是凭据，只在私信里发（群里等于把后台入口贴给全群）。",
    );
  }
  if (!service.canIssue(operatorId)) {
    return deny(
      "权限不足",
      "需要全局超级管理员权限（或不在 `ADMIN_API_ALLOWED_OPENIDS` 白名单里）。",
    );
  }

  if (action === "status" || action === "状态") {
    const card = cardFromText(
      "管理后台状态",
      "管理 API：**已开启**\n登录令牌：一次性、默认 10 分钟过期\n用 `/admin login` 获取登录链接。",
      { rows: [[viewButton("help", "指令帮助", "help", "home")]] },
    );
    return { ok: true, text: card.text, rich: card.rich };
  }

  if (action === "" || action === "login" || action === "登录") {
    const issued = await service.issueFor(operatorId);
    // 只记"谁要了令牌"，不记令牌本身
    log.info("admin api login token issued", { operatorId, ttlMs: issued.ttlMs });
    const minutes = Math.round(issued.ttlMs / 60_000);
    const lines = ["**一次性登录令牌**（只能用一次，过期作废）：", "", `\`${issued.token}\``, ""];
    if (issued.link !== undefined) {
      lines.push(
        "**登录链接**（点开直接进后台）：",
        "",
        issued.link,
        "",
        "链接点不动就打开后台登录页，把上面的令牌粘进去。",
      );
    } else {
      lines.push(
        "没有配置 `ADMIN_API_PUBLIC_BASE_URL`，只给令牌：打开后台登录页，把令牌粘进去。",
      );
    }
    lines.push(
      "",
      `有效期约 ${minutes} 分钟。这条消息本身就是凭据，**别转发**；用过就失效，下次重新发 /admin login。`,
    );
    const card = cardFromText("管理后台登录", lines.join("\n"), {
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: true, text: card.text, rich: card.rich };
  }

  const card = cardFromText("管理后台", ADMIN_USAGE, {
    rows: [[viewButton("help", "指令帮助", "help", "home")]],
  });
  return { ok: false, text: card.text, rich: card.rich };
}

function deny(title: string, text: string): CommandResult {
  const card = cardFromText(title, text);
  return { ok: false, text: card.text, rich: card.rich };
}
