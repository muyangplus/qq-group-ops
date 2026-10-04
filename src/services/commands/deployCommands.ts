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

/**
 * 回调：`cb:deploy:rollback` —— **回滚到上一个版本**（ADR-0065 第 3 条）。
 *
 * 回滚不是「把文件换回去就完事」：它走的是与安装新包**同一套**流程
 * （重新应用 `data/packages/` 里的上一个包 → sha 之外的指纹自证 → 整目录替换 → 重启），
 * 所以这里只负责说清「换了什么」，真正的校验与替换交给 `DeployInstaller`。
 *
 * 按钮上已经有官方的二次确认弹窗（`/status proc` 卡片），所以回调进来就直接执行。
 */
export async function deployRollbackCard(
  ctx: AdminCommandContext,
  userId: string,
): Promise<CardResult> {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("回滚只有全局超管可以操作。");
  }
  const install = ctx.install;
  const target = install?.rollbackTarget();
  if (!install || !target) {
    return cardFromText(
      "没有可回滚的版本",
      [
        "现在没有可回滚的上一个版本（`data/deploy-state.json` 里没有 `previousVersion`，",
        "或 `data/packages/` 里已经没有那个包了）。",
        "",
        "运维手工路径见 `docs/OPERATIONS.md` 的「手工救急」。",
      ].join("\n"),
      {
        rows: [
          [
            viewButton("proc", "进程状态", "status", "proc"),
            viewButton("help", "指令帮助", "help", "topic", "restart"),
          ],
        ],
      },
    );
  }

  const result = await install.rollback();
  const rows = [
    [
      viewButton("proc", "回滚后看进程", "status", "proc"),
      viewButton("help", "指令帮助", "help", "topic", "restart"),
    ],
  ];
  if (!result.ok) {
    return {
      ...cardFromText(
        "回滚没成功",
        [
          `**目标版本**：v${target.version}（当前 v${target.currentVersion}）`,
          `**原因**：${result.message}`,
          "",
          "现役产物没有被改动（安装器在替换之前就拒绝了）；机器人继续按当前版本工作。",
          "可以稍后再试，或按 `docs/OPERATIONS.md` 的「手工救急」处理。",
        ].join("\n"),
        { rows },
      ),
      ok: false,
    };
  }
  return cardFromText(
    "正在回滚",
    [
      `**v${target.currentVersion} → v${target.version}**：上一个包已经重新应用并通过指纹自证。`,
      `几秒内机器人会重启到 v${target.version}；重启完成后会私信你一条回执。`,
      "",
      "回滚会作废 FTP 同步状态，所以下一轮 CD 会自动全量上传（一次性，不是每次都全量）。",
    ].join("\n"),
    { rows },
  );
}
