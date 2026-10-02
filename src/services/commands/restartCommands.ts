import type { KeyboardModal } from "../../adapters/qqOfficial.js";
import { appVersion, formatUptime, runningVersionOf } from "../../core/buildInfo.js";
import { PlatformLevel } from "../../core/enums.js";
import { STARTUP_CHECK_FILE, readStartupCheckFile } from "../../startupCheck.js";
import { encodeCallback } from "../callbackData.js";
import { renderCard } from "../cardTemplate.js";
import { inlineSummary } from "../restartNotice.js";
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
      // **本进程正在跑的**版本（`appVersion()` 读的是磁盘 —— 部署还没重启时会显示成新版本）
      `**当前版本**：v${runningVersionOf()} · 已运行 ${formatUptime(
        process.uptime() * 1000,
      )}`,
      "",
      "重启会先保存数据、优雅关闭，再由自我重启助手拉起新进程；期间大约 5 秒不能响应。",
      "助手拉起前会先自检新版本：起不来的话**不换版本**，并回滚到上一次能起来的构建。",
      "点「确认重启」后还会弹出一次确认；助手没起来时**不会**关掉机器人。",
      "**手动重启不限次数**（同一版本反复试都可以）；只有部署监测的自动重试对同一版本只试一次。",
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
    },
  );
}

/**
 * 回调：`cb:restart:go` —— 真正安排重启（回执卡先发出去，几秒后进程退出）。
 *
 * 退出**之前**会先跑一次自检（`main.ts` 的流程）：跑不过就不退出、把坏构建换回上一版，
 * 并私信一张带「强制重启 / 再次检查」的取消卡。传 `force` = 跳过自检（失败卡上的「强制重启」）。
 */
export function restartNowCard(
  ctx: AdminCommandContext,
  userId: string,
  replyGroupId?: string,
  options: { force?: boolean } = {},
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("权限不足", "重启机器人只有全局超管可以操作。");
  }
  const hook = ctx.restart;
  if (!hook?.available) {
    return denied("重启不可用", "当前进程没有装配重启钩子，无法重启。");
  }
  const force = options.force === true;
  const accepted = hook.request({
    requestedBy: userId,
    reason: "manual",
    ...(force ? { force: true } : {}),
  });
  if (!accepted) {
    return denied("重启失败", "重启钩子拒绝了本次请求，请查看启动日志。");
  }
  const notice = ctx.helpers.mention(replyGroupId, userId);
  const card = renderCard({
    title: force ? "强制重启中" : "正在重启",
    lines: [
      force
        ? `${notice}已跳过自检，几秒内机器人会短暂离线。`
        : `${notice}正在重启：先自检新版本，通过后几秒内机器人会短暂离线，随后自动回来。`,
      "",
      "完成后会私信你一条回执（版本 + 耗时）。若自检没过，机器人会**留在当前版本**并私信你原因（附「强制重启 / 再次检查」按钮）。",
    ],
    rows: [
      [
        viewButton("refresh", "重启后看进程", "status", "proc"),
        viewButton("help", "指令帮助", "help", "topic", "restart"),
      ],
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/** 回调：`cb:restart:again` —— 只跑一次退出前自检，不重启。 */
export function restartCheckCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("权限不足", "重启自检只有全局超管可以操作。");
  }
  const hook = ctx.restart;
  if (!hook?.available) {
    return denied("自检不可用", "当前进程没有装配重启钩子，无法自检。");
  }
  const result = hook.preflight();
  if (!result) {
    return denied("自检不可用", "重启自检没有装配（一般是纯测试环境）。");
  }
  if (result.ok) {
    return cardFromText(
      "自检通过",
      [
        "新版本能正常初始化（配置 / 数据库 / 建表 / 各模块加载都过了）。",
        "",
        "可以点「确认重启」换到新版本；重启前会**再检查一次**（检查很快，不影响运行）。",
      ].join("\n"),
      {
        rows: [
          [
            viewButtonWithOptions(
              "run",
              "确认重启",
              encodeCallback("restart", "go"),
              { modal: confirmRestartModal() },
            ),
            viewButton("help", "指令帮助", "help", "topic", "restart"),
          ],
        ],
      },
    );
  }
  const card = renderCard({
    title: "自检不通过",
    lines: [
      `**原因**：${result.reason ?? "未知（详见 data/startup-check.json）"}`,
      ...(result.summary
        ? ["**自检结果**：", "```json", inlineSummary(result.summary), "```"]
        : []),
      "",
      "机器人仍在当前版本上运行，没有重启。修好之后可以再点「再次检查」；",
      "**手动重试不限次数**（「重新检查并重启」）；确认要看新版本行为时，可以点「强制重启」跳过自检。",
    ],
    rows: [
      [
        viewButton("retry", "重新检查并重启", "restart", "go"),
        viewButton("report", "自检结果", "restart", "detail"),
      ],
      [
        viewButton("force", "强制重启", "restart", "force"),
        viewButton("again", "再次检查", "restart", "again"),
      ],
      [viewButton("help", "指令帮助", "help", "topic", "restart")],
    ],
  });
  return { ok: false, text: card.text, rich: card };
}

/** 「自检结果」正文上限：超过就截断并提示去看服务器上的文件。 */
export const STARTUP_CHECK_BODY_MAX = 1500;

/**
 * 回调：`cb:restart:detail` —— 把 `data/startup-check.json` 的原文发过来。
 *
 * 为什么单独一张卡：失败卡正文只内联一段紧凑 JSON（太长容易被客户端截），
 * 而「到底哪一步没过」要看完整原文 —— 所以卡上一个按钮，点了就私信全文。
 * 原文异常长时（例如 degraded 列表很长）只发前 1500 字并提示用别的方式取，避免整条被拒收。
 */
export function startupCheckCard(
  ctx: AdminCommandContext,
  userId: string,
  options: { file?: string } = {},
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("权限不足", "查看自检结果只有全局超管可以操作。");
  }
  const summary = readStartupCheckFile(options.file);
  if (!summary) {
    return cardFromText(
      "读不到自检结果",
      [
        `文件 \`${options.file ?? STARTUP_CHECK_FILE}\` 不存在或不是合法 JSON。`,
        "",
        "常见原因：自检进程还没跑到写文件那一步就退出了（例如模块加载阶段抛错），",
        "或者这份结果已经被后续一次成功的启动覆盖 / 删掉。可以点「重新检查并重启」再跑一次自检。",
      ].join("\n"),
      {
        rows: [
          [viewButton("retry", "重新检查并重启", "restart", "go")],
          [viewButton("help", "指令帮助", "help", "topic", "restart")],
        ],
      },
    );
  }
  const raw = JSON.stringify(summary, null, 2);
  const truncated = raw.length > STARTUP_CHECK_BODY_MAX;
  const card = renderCard({
    title: "自检结果",
    lines: [
      `**文件**：\`${options.file ?? STARTUP_CHECK_FILE}\``,
      `**结论**：${summary.ok === true ? "通过" : "不通过"}${summary.at !== undefined ? ` · 写入时间 ${String(summary.at)}` : ""}`,
      "",
      "```json",
      truncated ? `${raw.slice(0, STARTUP_CHECK_BODY_MAX)}…` : raw,
      "```",
      ...(truncated
        ? [`正文超过 ${STARTUP_CHECK_BODY_MAX} 字，已截断；完整内容请直接在服务器上看这个文件。`]
        : []),
    ],
    rows: [
      [viewButton("retry", "重新检查并重启", "restart", "go")],
      [viewButton("help", "指令帮助", "help", "topic", "restart")],
    ],
  });
  return { ok: summary.ok !== false, text: card.text, rich: card };
}
