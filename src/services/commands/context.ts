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

/**
 * 领域子模块共享依赖（R1 拆分用）。
 *
 * `AdminCommandService` 作为**门面**保留全部对外 API；内部按领域拆到 `src/services/commands/*`
 * 的子模块，子模块只接收这个只读依赖对象 + 调用参数，不再直接持有服务实例，
 * 这样每个领域都能独立测试、也能清楚看出它依赖了什么。
 *
 * 注意：这里只放**服务依赖**；纯工具与常量在 `support.ts`。
 */
export interface AdminCommandContext {
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
