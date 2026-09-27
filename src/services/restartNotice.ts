import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getLogger } from "../core/logger.js";
import { formatDisplayTime } from "../core/timeFormat.js";
import { renderCard } from "./cardTemplate.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("restart-notice");

/** 重启回执文件（相对启动目录，和 `data/` 下的库文件同居；gitignored）。 */
export const RESTART_NOTICE_FILE = "data/restart-notice.json";

export interface RestartNotice {
  /** 发起重启的人（重启用完给他回一条私信）。 */
  userId: string;
  /** 请求时间（ISO）。 */
  requestedAt: string;
  /** 请求时的版本。 */
  version: string;
  /** 重启方式：`respawn` = 自我重启（当前实现）；`supervisor` = 靠进程管理器拉起。 */
  mode?: "respawn" | "supervisor" | undefined;
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
      };
    }
  } catch (error) {
    log.warn("restart notice is not valid json", { file, error: String(error) });
  }
  return undefined;
}

/** 「已重启完成」的私信卡片（启动时发给发起人，证明进程管理器真的把它拉回来了）。 */
export function restartDoneCard(
  notice: RestartNotice,
  currentVersion: string,
): RichMessage {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const requestedAt = new Date(notice.requestedAt);
  const tookSeconds = Number.isNaN(requestedAt.getTime())
    ? undefined
    : Math.max(0, Math.round((startedAt - requestedAt.getTime()) / 1000));
  return renderCard({
    title: "机器人已重启",
    lines: [
      `**版本**：v${currentVersion}${
        notice.version !== currentVersion ? `（请求时 v${notice.version}）` : ""
      }`,
      `**本次启动**：${formatDisplayTime(new Date(startedAt))}`,
      ...(tookSeconds !== undefined
        ? [`**请求到启动**：约 ${tookSeconds} 秒`]
        : []),
      ...(notice.mode === "respawn"
        ? ["**重启方式**：自我重启（`scripts/respawn.mjs`）"]
        : []),
      "",
      "看到这条说明进程已经重新起来了（重启期间未送达的消息会按平台策略重推）。",
    ],
  });
}
