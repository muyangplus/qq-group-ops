import type { CardButton } from "../cardTemplate.js";
import type { Settings } from "../../config.js";
import type { MigrationResult } from "../../db/migrate.js";
import type { WriteQueue } from "../../db/writeQueue.js";
import type { AuditLog } from "../audit.js";
import type { ActivityService } from "../activity.js";
import type { ActivityCardService, ActivityExportLike, ActivityStatsLike } from "../activityCards.js";
import type { ActivityNotificationService } from "../activityNotifications.js";
import type { AppealService } from "../appeals.js";
import type { BlacklistService } from "../blacklist.js";
import type { ClassAliasService } from "../classAliases.js";
import type { DeployControl } from "../deployWatcher.js";
import type { DisplayNameService } from "../displayNames.js";
import type { ExportService } from "../export.js";
import type { GroupConfigStore } from "../groupConfig.js";
import type { GroupMessageModeRegistry } from "../groupMessageMode.js";
import type { HealthRegistry } from "../health.js";
import type { IdentityMapService } from "../identityMap.js";
import type { JoinApprovalService } from "../joinApproval.js";
import type { JoinAuditService } from "../joinAudit.js";
import type { JoinRequestSyncService } from "../joinAuditSync.js";
import type { JoinRuleEvaluator } from "../joinRules.js";
import type { MemberRoster } from "../memberRoster.js";
import type { DataMigrationService } from "../dataMigration.js";
import type { PrivacyService } from "../privacy.js";
import type { AdminApiLinkService } from "../../adminApi/loginLink.js";
import type { ModerationNotifier } from "../moderationNotifier.js";
import type { NotificationService } from "../notifications.js";
import type { PlatformSettingsStore } from "../platformSettings.js";
import type { PermissionService } from "../permissions.js";
import type { PunishmentService } from "../punishments.js";
import type { RestartHook } from "../restart.js";
import type { RichMessageSender } from "../richMessages.js";
import type { ScheduledAnnouncementService } from "../scheduledAnnouncements.js";
import type { UserProfileService } from "../userProfiles.js";
import type { CardResult, CommandResult } from "./support.js";

/**
 * 领域子模块共享依赖（R1 拆分用）。
 *
 * `AdminCommandService` 作为**门面**保留全部对外 API；内部按领域拆到 `src/services/commands/*`
 * 的子模块，子模块只接收这个只读依赖对象 + 调用参数，不再直接持有服务实例，
 * 这样每个领域都能独立测试、也能清楚看出它依赖了什么。
 *
 * 注意：这里只放**服务依赖**；纯工具与常量在 `support.ts`。
 */

/**
 * 门面提供的共享小工具（把「展示名 / 目标解析 / 卡片包装」这类跨领域能力显式暴露给子模块）。
 *
 * 子模块不直接依赖 `AdminCommandService`，只依赖这里的函数签名，避免循环引用。
 */
export interface CommandHelpers {
  /** 用统一标题/按钮包装已有指令结果（纯文本降级与旧输出等价）。 */
  cardify(
    title: string,
    result: CommandResult,
    rows: readonly (readonly CardButton[])[],
    footer?: readonly string[],
  ): CardResult;
  /** 把 handler 的 notice（可含首行 @）转成卡片正文行。 */
  renderNotice(notice: string | undefined): string[];
  /** 群内回复的 @ 提及（首行单独一行）；私聊返回空串。 */
  mention(replyGroupId: string | undefined, userId: string): string;
  /** 展示名：已绑定显示 QQ号 / 群号，未绑定显示短码。 */
  displayUser(officialId: string): string;
  displayGroup(groupId: string): string;
  displayRequest(requestId: string): string;
  /** 多个用户的展示名列表（用 `、` 连接，用于权限列表等）。 */
  displayUsers(ids: readonly string[]): string;
  /** 展示用群标签（与 displayGroup 同源，便于个别卡片使用）。 */
  groupLabel(groupId: string): string;
  /** 解析目标群：群号 / #群短码 / 内部 id。 */
  resolveTargetGroupId(
    groupId: string | undefined,
    raw: string | undefined,
  ): string | undefined;
  /** 活动卡片发送器（显式注入 → 富消息 → 通知服务发送器）。 */
  cardSender(): RichMessageSender | undefined;
  /** 班级库（活动学院 / 年级按钮）；未装配时为 undefined。 */
  roster(): MemberRoster | undefined;
  /** 活动统计图片服务；未装配时为 undefined（不生成「统计图片」按钮）。 */
  statsService(): ActivityStatsLike | undefined;
  /** 活动 CSV 导出服务；未装配时为 undefined（不生成「导出 CSV」按钮）。 */
  exportService(): ActivityExportLike | undefined;
  /** 活动通知服务缺失时的内存兜底订阅表（仅「是否已订阅」状态）。 */
  readonly fallbackSubscriptions: Set<string>;
}
export interface DiagnosticsDeps {
  settings: Settings;
  writeQueue: WriteQueue;
  /** 启动期迁移里的非致命问题（补列 / 数据归一化失败），由 `/status proc` 展示。 */
  migration?: MigrationResult | undefined;
}

export interface AdminCommandContext {
  /** 共享小工具（展示名 / 目标解析 / 卡片包装）。 */
  readonly helpers: CommandHelpers;
  /** 模块健康与功能闸门；未装配时不做闸门判断（纯单测场景）。 */
  readonly health: HealthRegistry | undefined;
  /** 平台热配置（`/config`）；未装配时该指令拒绝执行。 */
  readonly platform: PlatformSettingsStore | undefined;
  /** 进程级诊断依赖（`/status proc`）：配置摘要 + 写队列；未装配时只显示进程自身信息。 */
  readonly diagnostics: DiagnosticsDeps | undefined;
  readonly permissions: PermissionService;
  readonly joinAudit: JoinAuditService;
  readonly configStore: GroupConfigStore;
  readonly joinApproval: JoinApprovalService;
  readonly joinSync: JoinRequestSyncService;
  readonly auditLog: AuditLog;
  /** §B6 审核日志 CSV 导出（脱敏 + 权限校验在 ExportService 内）。 */
  readonly exportService: ExportService | undefined;
  readonly joinRules: JoinRuleEvaluator | undefined;
  readonly groupMessageMode: GroupMessageModeRegistry | undefined;
  readonly identityMap: IdentityMapService | undefined;
  readonly display: DisplayNameService | undefined;
  readonly userProfiles: UserProfileService | undefined;
  readonly classAliases: ClassAliasService | undefined;
  readonly activity: ActivityService | undefined;
  readonly activityCards: ActivityCardService | undefined;
  readonly activityNotifications: ActivityNotificationService | undefined;
  readonly notifications: NotificationService | undefined;
  /** 机器人定时发言（`/announce`，本群群管 130）；未装配时该指令拒绝执行。 */
  readonly scheduledAnnouncements: ScheduledAnnouncementService | undefined;
  /** §A5 黑名单（本群 / 全局）。 */
  readonly blacklist: BlacklistService | undefined;
  /** §B7 处罚记录与卡片动作。 */
  readonly punishments: PunishmentService | undefined;
  /** §B8 申诉记录。 */
  readonly appeals: AppealService | undefined;
  /** 处罚 / 申诉的私信卡片渲染与推送。 */
  readonly moderationNotifier: ModerationNotifier | undefined;
  /** `/restart` 的重启钩子；未装配时该指令拒绝执行。 */
  readonly restart: RestartHook | undefined;
  /** 一次性数据迁移（`/migrate`，仅全局超管、只私信）；未装配时该指令拒绝执行。 */
  readonly migrate: DataMigrationService | undefined;
  /** 个人数据匿名化 / 导出（`/data`，仅全局超管、只私信）；未装配时该指令拒绝执行。 */
  readonly privacy: PrivacyService | undefined;
  /** 管理后台登录令牌签发（`/admin login`，仅全局超管、只私信）。 */
  readonly adminApi: AdminApiLinkService | undefined;
  /** 部署监测（新版本自动重启）的控制面；未装配时没有待重启状态。 */
  readonly deploy: DeployControl | undefined;
  readonly richMessages: RichMessageSender | undefined;
}
