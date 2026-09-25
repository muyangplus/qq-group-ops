import type { CardButton } from "../cardTemplate.js";
import type { AuditLog } from "../audit.js";
import type { ActivityService } from "../activity.js";
import type { ActivityCardService } from "../activityCards.js";
import type { ActivityNotificationService } from "../activityNotifications.js";
import type { ClassAliasService } from "../classAliases.js";
import type { DisplayNameService } from "../displayNames.js";
import type { GroupConfigStore } from "../groupConfig.js";
import type { GroupMessageModeRegistry } from "../groupMessageMode.js";
import type { IdentityMapService } from "../identityMap.js";
import type { JoinApprovalService } from "../joinApproval.js";
import type { JoinAuditService } from "../joinAudit.js";
import type { JoinRequestSyncService } from "../joinAuditSync.js";
import type { JoinRuleEvaluator } from "../joinRules.js";
import type { NotificationService } from "../notifications.js";
import type { PermissionService } from "../permissions.js";
import type { RichMessageSender } from "../richMessages.js";
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
    buttonHint?: string,
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
}
export interface AdminCommandContext {
  /** 共享小工具（展示名 / 目标解析 / 卡片包装）。 */
  readonly helpers: CommandHelpers;
  readonly permissions: PermissionService;
  readonly joinAudit: JoinAuditService;
  readonly configStore: GroupConfigStore;
  readonly joinApproval: JoinApprovalService;
  readonly joinSync: JoinRequestSyncService;
  readonly auditLog: AuditLog;
  readonly joinRules: JoinRuleEvaluator | undefined;
  readonly groupMessageMode: GroupMessageModeRegistry | undefined;
  readonly identityMap: IdentityMapService | undefined;
  readonly display: DisplayNameService | undefined;
  readonly userProfiles: UserProfileService | undefined;
  readonly classAliases: ClassAliasService | undefined;
  readonly activity: ActivityService | undefined;
  readonly activityCards: ActivityCardService | undefined;
  readonly notifications: NotificationService | undefined;
  readonly richMessages: RichMessageSender | undefined;
}
