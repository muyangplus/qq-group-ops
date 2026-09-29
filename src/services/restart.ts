import { getLogger } from "../core/logger.js";
import type { PreflightResult } from "./restartPreflight.js";

/**
 * `/restart` 的重启钩子。
 *
 * 机器人**自己重启自己**有两条路：
 * 1. 「优雅关闭 → 进程退出」，由进程管理器拉起（docker compose 的 `restart: unless-stopped`、
 *    systemd 的 `Restart=always`、pm2 等同理）；
 * 2. **自我重启**（当前实现，用户选定）：退出前先脱离会话拉起 `scripts/respawn.mjs`，
 *    助手等旧进程消失、端口与句柄释放之后再启动新进程 —— 直接 `node dist/main.js` 起也能重启。
 *
 * 命令层只依赖这个钩子：`main.ts` 把实际动作注入进来；`request()` 返回 `false` 表示**未受理**
 * （没注入钩子、或钩子同步失败），命令层据此回「重启失败」，而不是让进程半死不活。
 */
/** 重启请求：谁说、为什么（`manual` = 指令点的；`deploy` = 部署监测自动触发）。 */
export interface RestartRequestInfo {
  requestedBy: string;
  reason?: "manual" | "deploy" | undefined;
  /** 部署自动重启时带上的目标版本。 */
  targetVersion?: string | undefined;
  /** 强制重启：跳过退出前自检（失败卡上的「强制重启」按钮）。 */
  force?: boolean | undefined;
}

export type RestartRequestHandler = (info: RestartRequestInfo) => void;

/** 只跑一次退出前自检（「再次检查」按钮）；未装配时返回 `undefined`。 */
export type RestartPreflightRunner = () => PreflightResult | undefined;

export interface RestartHook {
  /** 是否装配了可用的重启钩子。 */
  readonly available: boolean;
  /** 安排一次重启；返回是否受理。 */
  request(info: RestartRequestInfo): boolean;
  /** 只跑自检、不重启（「再次检查」按钮）。 */
  preflight(): PreflightResult | undefined;
}

export function createRestartHook(
  handler?: RestartRequestHandler | undefined,
  preflight?: RestartPreflightRunner | undefined,
): RestartHook {
  return {
    get available(): boolean {
      return handler !== undefined;
    },
    request(info): boolean {
      if (!handler) {
        return false;
      }
      try {
        handler(info);
        return true;
      } catch (error) {
        // 钩子同步失败（例如自我重启助手没拉起来）→ 报告「未受理」，
        // 命令层会回「重启失败」，而**不是**让回调抛异常或让进程半死不活。
        getLogger("restart").error("restart request rejected", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    preflight(): PreflightResult | undefined {
      if (!preflight) {
        return undefined;
      }
      try {
        return preflight();
      } catch (error) {
        getLogger("restart").error("restart preflight failed to run", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
  };
}
