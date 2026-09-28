import { getLogger } from "../core/logger.js";
import type { AppealService } from "./appeals.js";
import type { ModerationNotifier } from "./moderationNotifier.js";
import type { PunishmentService } from "./punishments.js";

const log = getLogger("appeal-watcher");

/**
 * 申诉值班轮转（§B8）。
 *
 * 用户口径：申诉**默认通知所有管理员**（群管理员 / 本群超管 / 全局超管），
 * **审核员之间轮单** —— 一次只通知一位，超过 `APPEAL_HOLD_MINUTES` 仍未处理就转给下一位。
 * 本服务只负责「超时转派」这一轮扫描（首次派发在 `ModerationNotifier.notifyAppeal` 里完成），
 * 由统一扫描周期驱动（`TickScheduler`，注册为 `runOnStart: false` —— 启动时先不扫）。
 *
 * 单次失败只记日志，不影响事件处理链。备注：值班记录是内存态，进程重启后会从当前订阅者里的
 * 第一位审核员重新开始（投递去重键带 `attempt`，所以不会把同一张卡重复推给同一个人）。
 */
export class AppealWatcher {
  public constructor(
    private readonly notifier: ModerationNotifier,
    private readonly appeals: AppealService,
    private readonly punishments: PunishmentService,
  ) {}

  /** 扫一轮：把超时的申诉转给下一位审核员，返回转派条数。 */
  public async runOnce(): Promise<number> {
    let forwarded = 0;
    for (const appeal of this.appeals.listPending()) {
      const punishment = this.punishments.get(appeal.punishmentId);
      if (!punishment) {
        continue;
      }
      try {
        if (await this.notifier.forwardAppealIfStale(appeal, punishment)) {
          forwarded += 1;
        }
      } catch (error) {
        log.warn("appeal forward failed", {
          appealId: appeal.appealId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (forwarded > 0) {
      log.info("appeal forwarded", { forwarded });
    }
    return forwarded;
  }
}
