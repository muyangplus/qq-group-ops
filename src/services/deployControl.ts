import type { DeployControl, DeployPending } from "./deployWatcher.js";

/**
 * 把多个部署控制面合成一个（包模式 + 逐文件模式）。
 *
 * 为什么要合成：生产上有**两条独立的「新版本」来源** ——
 * - 逐文件模式（`DeployWatcher`）：磁盘 `package.json` 版本变了 → 提醒 + 宽限期到点重启；
 * - 包模式（`DeployInstaller`，ADR-0065）：`incoming/` 里的产物包校验通过 → 提醒 + 宽限期到点
 *   **替换产物并重启**。
 *
 * 命令层（`/deploy cancel`、`/deploy now`、卡片按钮）与后台「状态」页只需要一个控制面：
 * 「现在有没有待上线的新版本 / 取消它 / 立刻上」。所以这里按顺序找**第一个真的有等待项的**来源，
 * 取消与立即生效都作用在它身上 —— 两条路径的语义已经对齐（都是「先提醒 + 留宽限期」），
 * 所以「有等待项的那个」就是用户刚收到卡片的那一个。
 *
 * **顺序有意义**：包模式放前面 —— 它同时要替换产物（动作更重），更需要被优先看见。
 */
export function combineDeployControls(
  controls: readonly (DeployControl | undefined)[],
): DeployControl {
  const active = controls.filter(
    (item): item is DeployControl => item !== undefined,
  );
  return {
    pending: (): DeployPending | undefined => {
      for (const control of active) {
        const pending = control.pending();
        if (pending !== undefined) {
          return pending;
        }
      }
      return undefined;
    },
    cancel: (): boolean => {
      for (const control of active) {
        if (control.cancel()) {
          return true;
        }
      }
      return false;
    },
    restartNow: (): boolean => {
      for (const control of active) {
        if (control.restartNow()) {
          return true;
        }
      }
      return false;
    },
  };
}
