import type { KeyboardModal } from "../../adapters/qqOfficial.js";
import { appVersion, formatUptime } from "../../core/buildInfo.js";
import { PlatformLevel } from "../../core/enums.js";
import { encodeCallback } from "../callbackData.js";
import { renderCard } from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  viewButton,
  viewButtonWithOptions,
  type CardResult,
} from "./support.js";

/** 重启前的二次确认弹窗（与「恢复继承」同一套不可逆动作规范）。 */
export function confirmRestartModal(): KeyboardModal {
  return {
    content: "确认重启机器人？重启期间机器人会短暂离线（几秒），由进程管理器自动拉起。",
    confirmText: "确认重启",
    cancelText: "取消",
  };
}

function isSuperAdmin(ctx: AdminCommandContext, userId: string): boolean {
  return ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin);
}

function denied(title: string, text: string): CardResult {
  const card = renderCard({
    title,
    lines: [text],
    rows: [[viewButton("help", "指令帮助", "help", "topic", "restart")]],
  });
  return { ok: false, text: card.text, rich: card };
}

/**
 * `/restart`：打开**确认卡**（不直接重启）。
 *
 * 权限：全局超管。装配了重启钩子（`main.ts` 注入）才能用；没装配时明确拒绝，
 * 而不是把进程杀掉 —— 直接 `node dist/main.js` 起且没有进程管理器时，杀掉就再也起不来了。
 */
export function restartCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("权限不足", "重启机器人只有全局超管可以操作。");
  }
  const hook = ctx.restart;
  if (!hook?.available) {
    return denied(
      "重启不可用",
      "当前进程没有装配重启钩子（一般是直接 `node dist/main.js` 启动、且没有进程管理器）。" +
        "用 docker compose（`restart: unless-stopped`）或 systemd（`Restart=always`）启动后，这个指令才有意义。",
    );
  }
  return cardFromText(
    "重启机器人",
    [
      `**版本**：v${appVersion()} · **已运行**：${formatUptime(
        process.uptime() * 1000,
      )}`,
      "",
      "重启会：先落盘所有排队写入 → 关闭网关与数据库 → 进程退出（由进程管理器拉回）。",
      "重启期间机器人短暂离线（通常几秒）；重启完成后会给**发起人**私信一条回执。",
    ].join("\n"),
    {
      rows: [
        [
          viewButtonWithOptions(
            "confirm",
            "确认重启",
            encodeCallback("restart", "go"),
            { modal: confirmRestartModal() },
          ),
          viewButton("help", "指令帮助", "help", "topic", "restart"),
        ],
      ],
      footer: ["只有全局超管能执行；群内结果会 @ 发起人。"],
    },
  );
}

/** 回调：`cb:restart:go` —— 真正安排重启（回执卡先发出去，几秒后进程退出）。 */
export function restartNowCard(
  ctx: AdminCommandContext,
  userId: string,
  replyGroupId?: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("权限不足", "重启机器人只有全局超管可以操作。");
  }
  const hook = ctx.restart;
  if (!hook?.available) {
    return denied("重启不可用", "当前进程没有装配重启钩子，无法重启。");
  }
  const accepted = hook.request({ requestedBy: userId });
  if (!accepted) {
    return denied("重启失败", "重启钩子拒绝了本次请求，请查看启动日志。");
  }
  const notice = ctx.helpers.mention(replyGroupId, userId);
  const card = renderCard({
    title: "正在重启",
    lines: [
      `${notice}已安排重启，几秒后机器人会离线，然后由进程管理器拉起。`,
      "",
      "重启完成后会私信你一条回执；如果一直没收到，说明进程没有被自动拉起，请检查部署配置。",
    ],
    rows: [[viewButton("refresh", "再看状态", "status", "proc")]],
  });
  return { ok: true, text: card.text, rich: card };
}
