import { ActivityStatus } from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import {
  SystemScheduler,
  type Scheduler,
} from "../adapters/reconnectingWebSocketGateway.js";
import type { Activity } from "./activity.js";
import { ActivityService } from "./activity.js";
import type { ActivityNotificationService } from "./activityNotifications.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("activity-reminder");

/** 默认扫描间隔：1 分钟（精度即轮询间隔，活动提醒不需要秒级精度）。 */
export const DEFAULT_ACTIVITY_REMIND_INTERVAL_MS = 60_000;

/**
 * 活动定时提醒（C3）。
 *
 * 设计：提醒时间存在 `activity_settings` 的 `remindAt` 行（老库免迁移），
 * 由本服务**周期轮询**——每轮扫出「到点且还没发过」的活动，在**所有绑定群**广播一张提醒卡，
 * 然后清掉提醒时间。广播走 `ActivityNotificationService.notifyGroupsCard`：
 * 去重键是 `(活动, group:<群ID>, remind)`，因此**每个群只发一次、重启也不会重发**。
 *
 * 到点时若活动已取消 / 已关闭 / 已过报名截止，则只清提醒、不广播。
 */
export class ActivityReminderService {
  private readonly activity: ActivityService;
  private readonly notifications: ActivityNotificationService | undefined;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly scheduler: Scheduler;
  private timer: unknown;
  private running = false;

  public constructor(options: {
    activity: ActivityService;
    notifications?: ActivityNotificationService | undefined;
    now?: () => Date;
    intervalMs?: number;
    scheduler?: Scheduler;
  }) {
    this.activity = options.activity;
    this.notifications = options.notifications;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_ACTIVITY_REMIND_INTERVAL_MS;
    this.scheduler = options.scheduler ?? new SystemScheduler();
  }

  /** 扫一轮：到点且在报名的活动 → 广播提醒并清掉提醒时间。 */
  public async runOnce(): Promise<{ fired: number; skipped: number }> {
    const now = this.now();
    const candidates = this.activity.listActivitiesWithReminder();
    let fired = 0;
    let skipped = 0;
    for (const activity of candidates) {
      const due = activity.remindAt;
      if (due === undefined || due > now) {
        skipped += 1;
        continue;
      }
      const groups = this.activity.listBoundGroups(activity.activityId);
      const open =
        activity.status === ActivityStatus.Open &&
        (activity.closeAt === undefined || activity.closeAt > now);
      if (open && this.notifications && groups.length > 0) {
        const result = await this.notifications.notifyGroupsCard({
          activityId: activity.activityId,
          groupIds: groups,
          kind: "remind",
          card: this.reminderCard(activity),
        });
        log.info("activity reminder broadcast", {
          activityId: activity.activityId,
          groups: groups.length,
          sent: result.sent,
          skipped: result.skipped,
          failed: result.failed,
        });
      } else {
        log.debug("activity reminder skipped", {
          activityId: activity.activityId,
          reason: open ? "no-bound-group-or-channel" : "not-open",
        });
      }
      // 无论是否发出都清掉提醒（persistSettings 会删掉 KV 行），避免下一轮重复扫描
      this.activity.updateActivity(activity.activityId, { remindAt: undefined });
      fired += 1;
    }
    return { fired, skipped };
  }

  /** 提醒卡：正文给出活动标题与报名入口（纯文本卡，避免服务层依赖指令层）。 */
  private reminderCard(activity: Activity): RichMessage {
    const lines = [
      `**${activity.title}**`,
      "报名仍在进行中，发送 `/activity` 查看列表并报名。",
    ];
    const capacity = activity.capacity;
    if (capacity !== undefined) {
      const registered = this.activity.listRegistrations(activity.activityId).length;
      lines.push(`当前报名：${registered} / ${capacity}`);
    }
    if (activity.closeAt !== undefined) {
      lines.push(`报名截止：${formatTime(activity.closeAt)}`);
    }
    return {
      markdown: `## 活动提醒\n${lines.join("\n")}`,
      text: `活动提醒\n${lines.join("\n")}`,
    };
  }

  public start(): void {
    if (this.running || this.intervalMs <= 0) {
      return;
    }
    this.running = true;
    this.scheduleNext();
    log.info("activity reminder scheduled", { intervalMs: this.intervalMs });
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((error: unknown) => {
          log.error("activity reminder run failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNext();
          }
        });
    }, this.intervalMs);
  }
}

/** 本地时间 `MM-DD HH:mm`（与卡片里其它时间展示一致）。 */
function formatTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
