import { PlatformLevel } from "../../core/enums.js";
import { encodeCallback } from "../callbackData.js";
import { renderCard, type CardButton } from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import { cardFromText, viewButton, type CardResult } from "./support.js";

function isSuperAdmin(ctx: AdminCommandContext, userId: string): boolean {
  return ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin);
}

function denied(text: string): CardResult {
  const card = renderCard({
    title: "权限不足",
    lines: [text],
    rows: [[viewButton("help", "指令帮助", "help", "topic", "restart")]],
  });
  return { ok: false, text: card.text, rich: card };
}

function noPending(): CardResult {
  return cardFromText("部署监测", "现在没有待上线的新版本。", {
    rows: [
      [
        viewButton("proc", "进程状态", "status", "proc"),
        viewButton("help", "指令帮助", "help", "topic", "restart"),
      ],
    ],
  });
}

function actionRow(): CardButton[] {
  return [
    { id: "now", label: "立即重启", callbackData: encodeCallback("deploy", "now") },
    viewButton("proc", "进程状态", "status", "proc"),
  ];
}

/** 回调：`cb:deploy:cancel` —— 取消本次自动重启。 */
export function deployCancelCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("取消自动重启只有全局超管可以操作。");
  }
  const pending = ctx.deploy?.pending();
  if (!ctx.deploy || !pending) {
    return noPending();
  }
  ctx.deploy.cancel();
  return cardFromText(
    "已取消自动重启",
    [
      `**新版本**：v${pending.targetVersion}（服务器上已就绪）`,
      `**当前运行**：v${pending.currentVersion} —— 机器人继续跑旧版本，**不会再自动重启**。`,
      "",
      "想上线时点「立即重启」；同一个版本不会再提醒你（部署了新版本才会重新提醒）。",
    ].join("\n"),
    { rows: [actionRow()] },
  );
}

/** 回调：`cb:deploy:now` —— 立即重启加载新版本。 */
export function deployRestartNowCard(
  ctx: AdminCommandContext,
  userId: string,
  replyGroupId?: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("立即重启只有全局超管可以操作。");
  }
  const pending = ctx.deploy?.pending();
  if (!ctx.deploy || !pending) {
    return noPending();
  }
  const notice = ctx.helpers.mention(replyGroupId, userId);
  if (!ctx.deploy.restartNow()) {
    return {
      ...cardFromText(
        "重启没成功",
        [
          `${notice}**自动重启没能启动**（自我重启助手没起来），机器人仍在运行 v${pending.currentVersion}。`,
          "",
          "请查看启动日志或 `data/restart-failed.json`；也可以通过命令行手动重启一次。",
        ].join("\n"),
        { rows: [actionRow()] },
      ),
      ok: false,
    };
  }
  return cardFromText(
    "正在重启",
    [
      `${notice}马上重启到 **v${pending.targetVersion}**（当前 v${pending.currentVersion}）。`,
      "",
      "几秒内机器人会离线再回来；完成后会私信你一条回执。",
    ].join("\n"),
    {
      rows: [
        [
          viewButton("proc", "重启后看进程", "status", "proc"),
          viewButton("help", "指令帮助", "help", "topic", "restart"),
        ],
      ],
    },
  );
}
