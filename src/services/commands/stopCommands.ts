import { randomUUID } from "node:crypto";

import { AuditStatus, PlatformLevel } from "../../core/enums.js";
import { encodeCallback } from "../callbackData.js";
import { renderCard } from "../cardTemplate.js";
import { describeStopUntil, parseStopDuration, type StopState } from "../stop.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  viewButton,
  viewButtonWithOptions,
  type CardResult,
} from "./support.js";

/**
 * `/stop` 家族：**临时停机 / 静默**（ADR-0070，用户 2026-10-12 提出）。
 *
 * - `/stop`：让机器人**立即停机**（进程退出、不再自启；要恢复得手动启动或让进程管理器拉起）；
 * - `/stop 30m|2h|1d`：静默一段时间，到点自动恢复；
 * - `/stop forever`：永久静默，直到 `/start`；
 * - `/start`：手动恢复。
 *
 * 静默期间的边界（用户口径）：**非超管的消息完全不处理**（不回复、不审核、不推送），
 * 出站消息里**群聊一律不发**、私信只发给平台超管；定时发言 / 活动提醒 / 申诉轮转 / 入群对账
 * 这些会发消息的周期任务也一并停掉。`/stop` 与 `/start` 本身只对超管生效，所以静默中仍可用。
 *
 * 权限：全局超管，且**只走私信**（群里发会提示去私信 —— 停机是运维动作，不该在群里广播）。
 */

function isSuperAdmin(ctx: AdminCommandContext, userId: string): boolean {
  return ctx.permissions.meetsGlobal(userId, PlatformLevel.GlobalSuperAdmin);
}

function denied(text: string): CardResult {
  const card = renderCard({
    title: "权限不足",
    lines: [text],
    rows: [[viewButton("help", "指令帮助", "help", "topic", "stop")]],
  });
  return { ok: false, text: card.text, rich: card };
}

function helpRow() {
  return [viewButton("help", "指令帮助", "help", "topic", "stop")];
}

/** 平台级运维动作都写审计（不挂在任何群上）。 */
function writeAudit(
  ctx: AdminCommandContext,
  userId: string,
  action: string,
  reason: string,
): void {
  ctx.auditLog.append({
    recordId: randomUUID(),
    groupId: "",
    actorId: userId,
    action,
    status: AuditStatus.Executed,
    reason,
    createdAt: new Date(),
  });
}

/** 停机前的二次确认弹窗（与「确认重启」同一套不可逆动作规范）。 */
export function confirmStopModal() {
  return {
    content:
      "确认停止机器人？进程会立即退出，而且**不会再自动起来** —— 之后要靠手动启动（或你自己的守护进程）恢复。想只是临时不出声，请点旁边的「静默」。",
    confirmText: "确认停止",
    cancelText: "取消",
  };
}

/** 静默回执卡（`/stop <时长>` 与 `/stop forever` 共用）。 */
function silencedCard(state: StopState): CardResult {
  const until = describeStopUntil(state);
  const forever = state.until === null;
  return cardFromText(
    "已进入静默",
    [
      `**静默到**：${until}`,
      forever
        ? "**没有到期时间** —— 恢复用 `/start`。"
        : "到点会自动恢复（不用手动操作）。",
      "",
      "静默期间：**非超管的消息一律不处理**（不回复、不审核、不推送）；群里一条都不发，",
      "私信只回超管；定时发言 / 活动提醒 / 申诉轮转 / 入群对账也停掉。",
      "你的私信仍能正常用 `/start` 恢复，也能用 `/status proc` 看状态。",
    ].join("\n"),
    { rows: [[viewButton("resume", "立即恢复", "stop", "resume"), ...helpRow()]] },
  );
}

/**
 * `/stop`：打开**停机 / 静默选择卡**（不直接停机）。
 *
 * 权限：全局超管（群里发会先提示去私信）；没装配停机钩子时仍然可以**静默**
 * （静默不依赖进程管理器）。
 */
export function stopCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("停机 / 静默只有全局超管可以操作。");
  }
  const stop = ctx.stop;
  if (!stop) {
    return denied("停机不可用：当前进程没有装配停机状态（纯测试环境）。");
  }
  const current = stop.current();
  const hook = ctx.stopProcess;
  const lines = [
    current
      ? `**当前状态**：静默中（到 ${describeStopUntil(current)}）`
      : "**当前状态**：正常运行",
    "",
    "**静默**（推荐用于突发 bug）：机器人不出声、也不处理非超管消息，但进程还在 ——",
    "到点自动恢复，或者 `/start` 提前恢复。",
    "**停机**：进程直接退出、**不再自动起来**，之后要手动启动（或靠你自己的守护进程）。",
    "",
    "选一个：",
  ];
  const rows = [
    [
      viewButton("s1h", "静默1小时", "stop", "silence", "1h"),
      viewButton("s1d", "静默1天", "stop", "silence", "1d"),
    ],
    [
      viewButton("sforever", "永久静默", "stop", "silence", "forever"),
      viewButton("resume", "立即恢复", "stop", "resume"),
    ],
  ];
  if (hook?.available) {
    rows.push([
      viewButtonWithOptions(
        "go",
        "确认停止",
        encodeCallback("stop", "go"),
        { modal: confirmStopModal() },
      ),
      ...helpRow(),
    ]);
  } else {
    lines.push(
      "（当前进程没有装配停机钩子，「确认停止」不可用；静默不受影响。）",
    );
    rows.push(helpRow());
  }
  return cardFromText("停机 / 静默", lines.join("\n"), { rows });
}

/** `/stop <时长>`：进入静默（`30m` / `2h` / `1d` / `forever`）。 */
export function stopSilenceCard(
  ctx: AdminCommandContext,
  userId: string,
  raw: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("停机 / 静默只有全局超管可以操作。");
  }
  const stop = ctx.stop;
  if (!stop) {
    return denied("停机不可用：当前进程没有装配停机状态（纯测试环境）。");
  }
  const parsed = parseStopDuration(raw);
  if (!parsed.ok) {
    return {
      ...cardFromText(
        "时长没认出来",
        [
          parsed.error,
          "",
          "用法：`/stop 30m` · `/stop 2h` · `/stop 1d` · `/stop forever`",
        ].join("\n"),
        { rows: [helpRow()] },
      ),
      ok: false,
    };
  }
  const state = stop.silence({
    untilMs: parsed.ms,
    by: userId,
    reason: "/stop 指令",
  });
  writeAudit(
    ctx,
    userId,
    "platform_silence",
    `静默到 ${describeStopUntil(state)}（/stop ${raw}）`,
  );
  return silencedCard(state);
}

/** `/start`：手动恢复（清掉静默）。 */
export function stopResumeCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("恢复只有全局超管可以操作。");
  }
  const stop = ctx.stop;
  if (!stop) {
    return denied("停机不可用：当前进程没有装配停机状态（纯测试环境）。");
  }
  if (!stop.silenced()) {
    return cardFromText(
      "现在没有在静默",
      [
        "机器人本来就在正常服务（可能已经到点自动恢复了）。",
        "",
        "要停机 / 静默请看 `/stop`。",
      ].join("\n"),
      { rows: [helpRow()] },
    );
  }
  const previous = stop.resume(userId);
  writeAudit(
    ctx,
    userId,
    "platform_resume",
    `恢复服务（原静默到 ${previous ? describeStopUntil(previous) : "未知"}）`,
  );
  return cardFromText(
    "已恢复",
    [
      "静默已解除：机器人从现在起正常处理群聊与私信。",
      "",
      previous?.until === null
        ? "（这次是**永久静默**被手动恢复的。）"
        : "（下次要停就再发 `/stop <时长>`。）",
    ].join("\n"),
    { rows: [helpRow()] },
  );
}

/** 回调：`cb:stop:go` —— 真正停机（回执先发出去，随后进程优雅退出、不自启）。 */
export function stopGoCard(
  ctx: AdminCommandContext,
  userId: string,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("停机只有全局超管可以操作。");
  }
  const hook = ctx.stopProcess;
  if (!hook?.available) {
    return denied("停机不可用：当前进程没有装配停机钩子（纯测试环境）。");
  }
  const accepted = hook.request({ requestedBy: userId, reason: "manual" });
  if (!accepted) {
    return {
      ...cardFromText(
        "停机没成功",
        [
          "停机钩子拒绝了本次请求，进程仍在运行（详见启动日志）。",
          "",
          "可以用 `/stop <时长>` 先静默。",
        ].join("\n"),
        { rows: [helpRow()] },
      ),
      ok: false,
    };
  }
  writeAudit(ctx, userId, "platform_stop", "手动停机（/stop）");
  return cardFromText(
    "正在停机",
    [
      "机器人正在保存数据并优雅退出。",
      "",
      "⚠️ **它不会再自动起来** —— 恢复服务要手动启动（或你自己的守护进程）。",
      "如果只是想让机器人先别说话，下次可以用 `/stop 30m` 这类**静默**，到点自动恢复。",
    ].join("\n"),
    { rows: [helpRow()] },
  );
}

/** 回调：`cb:stop:silence:<spec>` —— 卡片上的「静默 1 小时 / 1 天 / 永久」。 */
export function stopSilenceCallbackCard(
  ctx: AdminCommandContext,
  userId: string,
  spec: string | undefined,
): CardResult {
  if (!isSuperAdmin(ctx, userId)) {
    return denied("停机 / 静默只有全局超管可以操作。");
  }
  const stop = ctx.stop;
  if (!stop) {
    return denied("停机不可用：当前进程没有装配停机状态（纯测试环境）。");
  }
  const parsed = parseStopDuration(spec ?? "");
  if (!parsed.ok) {
    return {
      ...cardFromText("静默失败", parsed.error, { rows: [helpRow()] }),
      ok: false,
    };
  }
  const state = stop.silence({
    untilMs: parsed.ms,
    by: userId,
    reason: "按卡片按钮静默",
  });
  writeAudit(
    ctx,
    userId,
    "platform_silence",
    `静默到 ${describeStopUntil(state)}（卡片按钮 ${spec ?? ""}）`,
  );
  return silencedCard(state);
}
