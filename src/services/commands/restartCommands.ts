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
    content: "确认重启机器人？重启期间机器人会短暂离线（几秒），随后自行拉起。",
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
      "当前进程没有装配重启钩子（一般是纯测试环境或直接 import 服务层调用），无法重启。",
    );
  }
  return cardFromText(
    "重启机器人",
    [
      `**版本**：v${appVersion()} · **已运行**：${formatUptime(
        process.uptime() * 1000,
      )}`,
      "",
      "重启流程：脱离会话拉起自我重启助手（`scripts/respawn.mjs`）→ 落盘排队写入 → 关闭网关与数据库 → 进程退出；",
      "助手等旧进程退出、端口与句柄释放后，再用同样的命令启动新进程（约几秒）。",
      "",
      "**兜底**：助手没起来时旧进程**不会退出**（会私信你「重启已取消」），不会把机器人搞没。",
      "重启完成后会给**发起人**私信一条回执（版本 / 启动时间 / 请求到启动的耗时）。",
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
      `${notice}已安排重启：几秒后机器人会离线，随后由自我重启助手拉起。`,
      "",
      "重启完成后会私信你一条回执；如果一直没收到，说明新进程没起来，请查看 `data/restart-failed.json` 与启动日志。",
    ],
    rows: [[viewButton("refresh", "再看状态", "status", "proc")]],
  });
  return { ok: true, text: card.text, rich: card };
}
