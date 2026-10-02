import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getLogger } from "../core/logger.js";
import { formatDisplayTime } from "../core/timeFormat.js";
import { encodeCallback } from "./callbackData.js";
import { renderCard, type CardButton } from "./cardTemplate.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("restart-notice");

/** 重启回执文件（相对启动目录，和 `data/` 下的库文件同居；gitignored）。 */
export const RESTART_NOTICE_FILE = "data/restart-notice.json";

/** 失败卡正文里内联的自检原文上限（完整内容走「自检结果」按钮）。 */
export const PREFLIGHT_SUMMARY_INLINE_MAX = 300;

export interface RestartNotice {
  /** 发起重启的人；部署自动重启时是占位符 `deploy-watcher`（不是真实用户）。 */
  userId: string;
  /** 请求时间（ISO）。 */
  requestedAt: string;
  /** 请求时的版本（部署自动重启时 = 重启前的旧版本）。 */
  version: string;
  /** 重启方式：`respawn` = 自我重启（当前实现）；`supervisor` = 靠进程管理器拉起。 */
  mode?: "respawn" | "supervisor" | undefined;
  /** 触发原因：`manual` = 指令点的；`deploy` = 部署监测自动触发。 */
  reason?: "manual" | "deploy" | undefined;
  /** 部署自动重启的目标版本。 */
  targetVersion?: string | undefined;
}

/**
 * 写重启回执（**尽力而为**）：重启会退出进程，写失败只记日志 ——
 * 绝不能因为写不了这个文件就不重启。
 */
export function writeRestartNotice(
  notice: RestartNotice,
  file: string = RESTART_NOTICE_FILE,
): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(notice), "utf8");
    return true;
  } catch (error) {
    log.warn("restart notice not written", { file, error: String(error) });
    return false;
  }
}

/** 读走重启回执（读到即删除，只提示一次）；坏文件 / 缺字段都当没有。 */
export function takeRestartNotice(
  file: string = RESTART_NOTICE_FILE,
): RestartNotice | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    rmSync(file, { force: true });
  } catch (error) {
    log.warn("restart notice not removed", { file, error: String(error) });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RestartNotice>;
    if (
      typeof parsed.userId === "string" &&
      parsed.userId.length > 0 &&
      typeof parsed.requestedAt === "string"
    ) {
      return {
        userId: parsed.userId,
        requestedAt: parsed.requestedAt,
        version: typeof parsed.version === "string" ? parsed.version : "unknown",
        ...(parsed.mode === "respawn" || parsed.mode === "supervisor"
          ? { mode: parsed.mode }
          : {}),
        ...(parsed.reason === "manual" || parsed.reason === "deploy"
          ? { reason: parsed.reason }
          : {}),
        ...(typeof parsed.targetVersion === "string"
          ? { targetVersion: parsed.targetVersion }
          : {}),
      };
    }
  } catch (error) {
    log.warn("restart notice is not valid json", { file, error: String(error) });
  }
  return undefined;
}

/**
 * 「重启已取消」卡（自检没过时发给超管 / 发起人）。
 *
 * 三件事必须说清：
 * 1. **机器人还在跑上一版**（没有重启）—— 这是最容易被误解的一句；
 * 2. **为什么没过**：退出码 + 原因，并把 `data/startup-check.json` 的原文**内联**一段
 *    （完整内容点「自检结果」按钮发过来，见 `startupCheckCard`）；
 * 3. **还能怎么办**：手动重试**不限次数**（「重新检查并重启」），自动重试才受
 *    「同一版本只试一次」的限制；「强制重启」跳过自检、换完就看新版本行为。
 */
export function preflightFailedCard(input: {
  /** 本次要换上去的版本（`info.targetVersion ?? 磁盘版本`）。 */
  targetVersion: string;
  /** 自检失败原因（`PreflightResult.reason`）。 */
  reason: string;
  /** 回滚结果（坏构建是否换回上一版）。 */
  restore: { ok: boolean; detail: string };
  /** `data/startup-check.json` 的内容（可能读不到）。 */
  summary?: Record<string, unknown> | undefined;
}): RichMessage {
  const lines = [
    "**机器人仍在运行上一版**（这次没有重启）。",
    `**新版本**：v${input.targetVersion}`,
    `**原因**：${input.reason}`,
    ...(input.summary
      ? [`**自检结果**（data/startup-check.json）：`, "```json", inlineSummary(input.summary), "```"]
      : ["**自检结果**：读不到 data/startup-check.json（自检进程可能没跑到写文件那一步）。"]),
    input.restore.ok
      ? `已把坏构建换回上一版：${input.restore.detail}`
      : `换回上一版没成功：${input.restore.detail}`,
    "",
    "「重新检查并重启」= 再跑一次自检，过了就换版本（没过会再来一张这张卡）。",
    "**手动重试不限次数**；只有部署监测的**自动重试**对同一版本只试一次（它已经被拦掉了）。",
    "也可以在修好新版本后重新部署 —— 版本一变就会自动重新检查。",
  ];
  return renderCard({
    title: "重启已取消",
    lines,
    rows: [
      [
        callbackButton("retry", "重新检查并重启", encodeCallback("restart", "go")),
        callbackButton("report", "自检结果", encodeCallback("restart", "detail")),
      ],
      [
        callbackButton("force", "强制重启", encodeCallback("restart", "force")),
        callbackButton("again", "再次检查", encodeCallback("restart", "again")),
      ],
      [callbackButton("proc", "看看进程状态", encodeCallback("status", "proc"))],
    ],
  });
}

/** 内联展示的紧凑 JSON：太长就截断（完整内容走「自检结果」按钮）。 */
export function inlineSummary(
  summary: Record<string, unknown>,
  max: number = PREFLIGHT_SUMMARY_INLINE_MAX,
): string {
  let text: string;
  try {
    text = JSON.stringify(summary);
  } catch {
    text = String(summary);
  }
  return text.length > max
    ? `${text.slice(0, max)}…（完整内容点「自检结果」）`
    : text;
}

/** 本地小工具：避免服务层依赖命令层（与 `deployWatcher.ts` 同样的做法）。 */
function callbackButton(
  id: string,
  label: string,
  callbackData: string,
): CardButton {
  return { id, label, callbackData };
}

/**
 * 「已重启」的私信卡片（启动时发出去，证明新进程真的起来了）。
 *
 * 两种口吻：`manual` = 你刚点了重启；`deploy` = 部署监测自动重启到新版本（重点说清新旧版本）。
 */
export function restartDoneCard(
  notice: RestartNotice,
  currentVersion: string,
): RichMessage {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const requestedAt = new Date(notice.requestedAt);
  const tookSeconds = Number.isNaN(requestedAt.getTime())
    ? undefined
    : Math.max(0, Math.round((startedAt - requestedAt.getTime()) / 1000));
  const deployed = notice.reason === "deploy";
  return renderCard({
    title: deployed ? "新版本已上线" : "机器人已重启",
    lines: [
      ...(deployed
        ? [
            `**版本**：v${notice.version} → **v${currentVersion}**`,
            `**本次启动**：${formatDisplayTime(new Date(startedAt))}`,
          ]
        : [
            `**版本**：v${currentVersion}${
              notice.version !== currentVersion
                ? `（重启前 v${notice.version}）`
                : ""
            }`,
            `**本次启动**：${formatDisplayTime(new Date(startedAt))}`,
          ]),
      ...(tookSeconds !== undefined
        ? [`**请求到启动**：约 ${tookSeconds} 秒`]
        : []),
      ...(notice.mode === "respawn"
        ? ["**重启方式**：自我重启（`scripts/respawn.mjs`）"]
        : []),
      "",
      deployed
        ? "看到这条说明新版本已经跑起来了。如果功能不对，可在服务器上回滚文件后再重启一次。"
        : "看到这条说明机器人已经重新起来了。",
    ],
  });
}
