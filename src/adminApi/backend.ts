import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import {
  AuditStatus,
  JoinRequestStatus,
  PermissionLevel,
  PlatformLevel,
} from "../core/enums.js";
import {
  distFingerprint,
  onDiskVersion,
  processStartedAt,
  runningVersionOf,
} from "../core/buildInfo.js";
import { getLogger } from "../core/logger.js";
import type { AdminTokenRepository, ActiveAdminToken } from "../db/adminTokenRepository.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import type { NotificationDeliveryRepository } from "../db/notificationRepository.js";
import type { NotificationSubscriptionRepository } from "../db/notificationRepository.js";
import type { PunishmentRecord } from "../db/punishmentRepository.js";
import type { AppealRecord } from "../db/appealRepository.js";
import type { BlacklistEntry } from "../db/blacklistRepository.js";
import type { NotificationDelivery } from "../db/notificationRepository.js";
import type { WriteQueue } from "../db/writeQueue.js";
import type { ActivityService } from "../services/activity.js";
import type { Activity } from "../services/activity.js";
import {
  activitySettingField,
  describeActivitySetting,
} from "../services/activitySettings.js";
import { buildAdminApiReports, buildReportsCsv } from "./reports.js";
import type { ActivityExportService } from "../services/activityExport.js";
import type { AppealService } from "../services/appeals.js";
import type { AuditLogStore } from "../services/audit.js";
import type { BlacklistService } from "../services/blacklist.js";
import {
  ACTIVITY_SET_USAGE,
  RULE_KEYWORD_MAX_LENGTH,
  parseRuleSetting,
} from "../services/commands/support.js";
import {
  DIST_BROKEN_DIR,
  readRollbackNotice,
} from "../services/distSnapshot.js";
import type { ExportService } from "../services/export.js";
import { DEFAULT_GROUP_ID, type GroupConfigStore } from "../services/groupConfig.js";
import { MODULE_KEYS, type HealthRegistry, type ModuleKey } from "../services/health.js";
import type { JoinApprovalService } from "../services/joinApproval.js";
import type { JoinAuditService, JoinRequest } from "../services/joinAudit.js";
import type { JoinRequestSyncService } from "../services/joinAuditSync.js";
import type { MigrationResult } from "../db/migrate.js";
import type { ModerationNotifier } from "../services/moderationNotifier.js";
import type { IdentityMapService } from "../services/identityMap.js";
import type { IdentityBindingRepository } from "../db/identityBindingRepository.js";
import type { IdentityBinding } from "../db/identityBindingRepository.js";
import {
  PERMISSION_ROLE_LABELS,
  PERMISSION_ROLES,
  grantPermissionRole,
  isGlobalPermissionRole,
  listPermissionRole,
  revokePermissionRole,
  type PermissionRole,
} from "../services/permissionRoles.js";
import type { NotifyTopicLevelStore } from "../services/notifyTopics.js";
import {
  ANNOUNCEMENT_NEXT_TIMES,
  DEFAULT_ANNOUNCEMENT_HOURLY_LIMIT,
  minuteKeyOf,
  nextTimesOfCron,
  parseCronExpression,
  type ScheduledAnnouncement,
  type ScheduledAnnouncementService,
} from "../services/scheduledAnnouncements.js";
import type { ClassAliasService } from "../services/classAliases.js";
import {
  CLASS_ALIAS_KIND_LABELS,
  type ClassAliasKind,
} from "../services/classAliases.js";
import type { GroupConfigOverride } from "../services/groupConfigCore.js";
import { ruleFieldLabel, RULE_FIELD_LABELS } from "../services/commands/support.js";
import type { NotifyChannel } from "../services/notifyTopics.js";
import type { NotificationService } from "../services/notifications.js";
import {
  NOTIFY_CHANNELS,
  NOTIFY_SCOPE_ALL,
  NOTIFY_TOPIC_META,
} from "../services/notifyTopics.js";
import type { PermissionService } from "../services/permissions.js";
import type { PunishmentService } from "../services/punishments.js";
import { readRestartFailure } from "../services/restartNotice.js";
import type { ShortCodeService } from "../services/shortCodes.js";
import type { TickSchedulerState } from "../services/tickScheduler.js";
import type { DeployControl } from "../services/deployWatcher.js";
import type { PlatformSettingsStore } from "../services/platformSettings.js";
import type { UserProfileService } from "../services/userProfiles.js";
import { badRequest, conflict, forbidden, notFound, unavailable } from "./errors.js";
import {
  createAdminApiEntities,
  type AdminApiEntities,
  type AdminApiEntityRef,
} from "./entityRef.js";
import { buildSettingsView, toSettingItem } from "./settings.js";
import {
  describePermissions,
  type AdminApiPermissionsView,
} from "./permissions.js";
import type {
  AdminApiActivityItem,
  AdminApiAnnouncementItem,
  AdminApiAnnouncementsView,
  AdminApiAppealItem,
  AdminApiAuditRecord,
  AdminApiBlacklistEntry,
  AdminApiDeliveryItem,
  AdminApiDeniedInput,
  AdminApiHealthView,
  AdminApiIdentitiesView,
  AdminApiIdentityItem,
  AdminApiAliasItem,
  AdminApiAliasResult,
  AdminApiNotifySubscriptionItem,
  AdminApiNotifySubscriptionsView,
  AdminApiNotifyTopic,
  AdminApiRuleKeywordsResult,
  AdminApiRuleOverridesView,
  AdminApiRuleResetResult,
  AdminApiRuleUpdateResult,
  AdminApiNotifyLevelResult,
  AdminApiNotifyTestResult,
  AdminApiPendingItem,
  AdminApiPermissionChangeResult,
  AdminApiPermissionGrantsView,
  AdminApiPermissionMember,
  AdminApiPermissionRoleList,
  AdminApiProfileSummary,
  AdminApiPunishmentItem,
  AdminApiReaders,
  AdminApiReportCsvResult,
  AdminApiReportsView,
  AdminApiRulesView,
  AdminApiStatusExtra,
  AdminApiSettingsView,
  AdminApiTasksView,
  AdminApiTokenItem,
  AdminApiWriters,
} from "./server.js";

const log = getLogger("admin-api");

/** 写端点要调用的领域服务与审计入口（E1-d）。 */
export interface AdminApiBackendDeps {
  permissions: PermissionService;
  auditLog: AuditLogStore;
  joinAudit: JoinAuditService;
  joinApproval: JoinApprovalService;
  configStore: GroupConfigStore;
  activity: ActivityService;
  activityExport: ActivityExportService;
  /**
   * 改活动字段：由机器人侧提供（`AdminCommandService.updateActivitySetting`），
   * 内部就是 `/activity set` 用的那个 `applyActivitySetting` —— 字段校验、满员广播、
   * 变更私信都与指令层一致，管理面不再写第二套。
   */
  updateActivitySetting?:
    | ((
        activityId: string,
        field: string,
        value: string,
      ) => Promise<{ ok: boolean; text: string }>)
    | undefined;
  /** 登录令牌仓储（`/api/status` 的 `activeTokens`）；内存模式为 undefined。 */
  adminTokens?: AdminTokenRepository | undefined;
  /**
   * 定时发言（本群群管 130 自治）：与群里 `/announce` **同一个领域服务**。
   *
   * 只读巡检进程没有内存态任务 → 不传（那个进程用自己的 reader 直接读 `group_settings`）。
   */
  scheduledAnnouncements?: ScheduledAnnouncementService | undefined;
  /** 话题订阅计数（只读原始行）；未接数据库时为 undefined。 */
  notificationSubscriptions?: NotificationSubscriptionRepository | undefined;
  /** 原始 `group_settings` 行（只读视图用；生效值一律以 `configStore` 为准）。 */
  groupSettings?: GroupSettingsRepository | undefined;
  /** 短码表：写端点接受 `#申请短码` 形式的路径参数。 */
  shortCodes?: ShortCodeService | undefined;
  /**
   * 展示层解析器（群号 / QQ号 → 短码 → 截断 id）。
   *
   * 不传时列表只回官方 id 自己当展示文本（只读巡检模式、单测里常见），
   * 传了就按用户口径优先出绑定号，完整长码留给详情行。
   */
  entities?: AdminApiEntities | undefined;
  /**
   * 周期任务状态的取值函数（`/api/tasks`）。
   *
   * 调度器在 `main.ts` 里**晚于运行时创建**（先起监听口、再建调度器），所以这里只能惰性取；
   * 没装配（只读巡检模式）时 `/api/tasks` 回 503。
   */
  tickTasks?: (() => TickSchedulerState | undefined) | undefined;
  /** 部署监测控制面：把「发现新版本、宽限期内」的状态一并展示在监测列表里。 */
  deploy?: DeployControl | undefined;
  /**
   * 热改配置存储（`/api/settings` 的读写都走它）。
   *
   * 这是机器人 `/config` 用的**同一个**入口（校验 → 落库 → 立即生效），
   * 管理 API 不另造配置通路；没装配（只读巡检模式）时该端点回 503。
   */
  platform?: PlatformSettingsStore | undefined;
  /** 数据库类型（`/api/status`）。 */
  database?: string | undefined;
  /** 启动期迁移问题数（`/api/status`）。 */
  migrationIssues?: number | undefined;
  now?: (() => Date) | undefined;

  // ---------------------------------------------------------- P1 只读补齐
  /** 处罚记录（`/api/punishments`）；未装配时该端点回 503。 */
  punishments?: PunishmentService | undefined;
  /** 黑名单（`/api/blacklist`）。 */
  blacklist?: BlacklistService | undefined;
  /** 申诉（`/api/appeals`）。 */
  appeals?: AppealService | undefined;
  /** 申请人资料摘要（`/api/pending` 每项附带 `profile`）。 */
  userProfiles?: UserProfileService | undefined;
  /** 通知投递记录（`/api/notify/deliveries`）。 */
  notificationDeliveries?: NotificationDeliveryRepository | undefined;
  /** 通知服务：进程级投递 / 订阅计数（`/api/health`）。 */
  notifications?: NotificationService | undefined;
  /**
   * 模块健康注册表（`/api/health` 的模块列表与降级原因）。
   *
   * 传取值函数而不是实例：健康表要引用几乎所有服务，**创建在管理后端之后**，
   * 只能等请求进来时再取（与 `tickTasks` 同样的原因）。
   */
  health?: (() => HealthRegistry | undefined) | undefined;
  /** 写队列（`/api/health` 的「待写数据库」计数与最近错误）。 */
  writeQueue?: WriteQueue | undefined;
  /** 启动期迁移详情（`/api/health`；`migrationIssues` 只是它的条数）。 */
  migration?: MigrationResult | undefined;
  /** 运行模式（`fake` / `official`）：`/api/health` 展示用。 */
  mode?: string | undefined;
  /** 申请队列同步（`POST /api/join/sync`，与指令层 `/sync` 同一服务）。 */
  joinSync?: JoinRequestSyncService | undefined;
  /** 申诉结论的私信通道（与指令层同一套 `ModerationNotifier`）。 */
  moderationNotifier?: ModerationNotifier | undefined;
  /** 通知话题门槛存储（`/api/notify/levels` 的读写都走它，与 `/notify level` 同一份数据）。 */
  notifyTopics?: NotifyTopicLevelStore | undefined;
  /** 班级 / 学院 / 专业别名表（`/api/aliases` 的读写都走它，与 `/alias` 同一份数据）。 */
  classAliases?: ClassAliasService | undefined;
  /** 身份映射（`/api/permissions` 把 QQ号 / #短码 解析成 openid）。 */
  identityMap?: IdentityMapService | undefined;
  /** 身份绑定表（`GET /api/identities` 的只读来源；不装配时退回内存映射）。 */
  identityBindings?: IdentityBindingRepository | undefined;
  /** 审计导出（`/api/audit/export.csv`，与指令层 `/export audit` 同一实现）。 */
  exportService?: ExportService | undefined;
}

/** 读 + 写：真实服务图上的管理 API 后端。 */
export interface AdminApiBackend extends AdminApiReaders, AdminApiWriters {
  status(): Promise<AdminApiStatusExtra>;
  audit(): Promise<AdminApiAuditRecord[]>;
  permissionsOf(userId: string): Promise<AdminApiPermissionsView>;
  /** 登录账号的展示信息（顶栏用）：QQ号 → 短码 → 完整 openid。 */
  userRefOf(userId: string): AdminApiEntityRef;
  /** 周期任务监测（`/api/tasks`）；没有调度器时返回 `undefined` → 端点回 503。 */
  tasks(): AdminApiTasksView | undefined;
  /** 配置视图（`/api/settings`）；没有内存态配置存储时返回 `undefined` → 端点回 503。 */
  settings(): AdminApiSettingsView | undefined;
  /** 只读权限被拒时写一条审计（E1-g / E1-b 第 9 条）。 */
  auditDenied(input: AdminApiDeniedInput): void;
}

/**
 * 把管理 API 接到**真实服务图**上（E1-d）。
 *
 * 为什么不再直接读仓储：写端点必须走与指令层同一个入口（`JoinApprovalService` /
 * `GroupConfigStore.setOverride` / `ActivityService`），否则会出现「管理面写进库、
 * 机器人内存态还是旧的」这种两份状态互相覆盖的问题（见 docs/ADMIN-API.md §2）。
 * 读端点的**权威来源**因此也是内存态服务（`auditLog.all()`、`configStore.listOverrides()`），
 * 只有「话题订阅计数」「原始 settings 行」这类纯聚合才直接读仓储。
 *
 * 权限判据与指令层保持一致：入群审批 / 活动 / 规则都要**本群群管理员 130**，
 * 全局规则（`__default__`）要**平台超管 240**；越权抛 403 并写一条审计。
 */
export function createAdminApiBackend(deps: AdminApiBackendDeps): AdminApiBackend {
  const now = deps.now ?? (() => new Date());

  const appendAudit = (input: {
    groupId: string;
    actorId: string;
    action: string;
    status: AuditStatus;
    reason: string;
    /** 操作对象（审批的申请人等）：写进 `target_user_id`，后台「审计」页才有「操作对象」列。 */
    targetUserId?: string | undefined;
  }): void => {
    deps.auditLog.append({
      recordId: randomUUID(),
      groupId: input.groupId,
      actorId: input.actorId,
      action: input.action,
      status: input.status,
      reason: input.reason,
      ...(input.targetUserId !== undefined
        ? { targetUserId: input.targetUserId }
        : {}),
      createdAt: now(),
    });
  };

  /**
   * 展示层解析器：没注入就退回「官方 id 自己当文本（过长则截断）」。
   *
   * 兜底那支是给只读巡检模式与单测用的（它们可能没有绑定表/短码表），
   * 保证任何情况下都不会因为「查不到展示名」而少返回字段。
   */
  const entities: AdminApiEntities =
    deps.entities ?? createAdminApiEntities();

  /** 热改配置存储：没装配就明确回 503（只读巡检进程没有内存态配置）。 */
  const requirePlatform = (): PlatformSettingsStore => {
    const platform = deps.platform;
    if (!platform) {
      throw unavailable("本进程没有内存态配置存储：请用机器人进程内的管理监听口改配置。");
    }
    return platform;
  };

  const requireGroupAdmin = (
    actorId: string,
    groupId: string,
    action: string,
  ): void => {
    if (deps.permissions.meetsInGroup(actorId, groupId, PermissionLevel.GroupAdmin)) {
      return;
    }
    appendAudit({
      groupId,
      actorId,
      action: "admin_api:denied",
      status: AuditStatus.Rejected,
      reason: `${action} 需要本群群管理员（130）`,
    });
    throw forbidden("权限不足：需要该群的群管理员或以上权限。");
  };

  /**
   * 定时发言的领域服务（与群里 `/announce` 同一个）：没装配就 503。
   *
   * 只读巡检进程没有内存态任务 → 只装配 reader（直接读 `group_settings`），写不了。
   */
  const requireAnnouncements = (): ScheduledAnnouncementService => {
    const service = deps.scheduledAnnouncements;
    if (!service) {
      throw unavailable(
        "定时发言未装配（只读巡检进程没有内存态任务）：请用机器人进程内的管理监听口改。",
      );
    }
    return service;
  };

  /**
   * 本群**审核员 120** 门槛：与指令层 `/sync` 一致（比审批低一档）。
   *
   * 为什么单独一个：同步申请队列只是「把官方队列拉下来」，不改变任何人的状态，
   * 所以指令层给的就是 120；管理面照搬，不擅自抬高。
   */
  const requireGroupModerator = (
    actorId: string,
    groupId: string,
    action: string,
  ): void => {
    if (deps.permissions.meetsInGroup(actorId, groupId, PermissionLevel.Moderator)) {
      return;
    }
    appendAudit({
      groupId,
      actorId,
      action: "admin_api:denied",
      status: AuditStatus.Rejected,
      reason: `${action} 需要本群审核员（120）`,
    });
    throw forbidden("权限不足：需要该群的审核员或以上权限。");
  };

  // ---------------------------------------------------------- 定时发言（本群 130 自治）

  /** 总开关 / 每小时上限都是热配置；没装配 platform 时按「关 + 默认上限」如实回。 */
  const announceSettings = (): { enabled: boolean; hourlyLimit: number } => ({
    enabled: deps.platform?.get("scheduledAnnounceEnabled") ?? false,
    hourlyLimit:
      deps.platform?.get("scheduledAnnounceHourlyLimit") ??
      DEFAULT_ANNOUNCEMENT_HOURLY_LIMIT,
  });

  const announcementsView = (groupId: string): AdminApiAnnouncementsView =>
    announcementsViewOf({
      tasks: requireAnnouncements().list(groupId),
      entities,
      ...announceSettings(),
    });

  // ---------------------------------------------------------- P1 只读补齐：视图换算

  /** 处罚记录 → API 形状（动作摘要的用词与指令层卡片一致）。 */
  const punishmentItem = (
    record: PunishmentRecord,
  ): AdminApiPunishmentItem => ({
    recordId: record.recordId,
    code: codeLabel(record.recordId),
    groupId: record.groupId,
    group: entities.group(record.groupId),
    userId: record.userId,
    target: entities.user(record.userId),
    actorId: record.actorId,
    actor: entities.user(record.actorId),
    source: record.source,
    ruleReason: record.ruleReason,
    messageExcerpt: record.messageExcerpt,
    actions: punishmentActionsLabel(record.actions),
    detail: record.detail,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });

  const blacklistItem = (entry: BlacklistEntry): AdminApiBlacklistEntry => ({
    scope: entry.scope,
    groupId: entry.groupId,
    ...(entry.scope === "group"
      ? { group: entities.group(entry.groupId) }
      : {}),
    userId: entry.userId,
    user: entities.user(entry.userId),
    reason: entry.reason,
    actorId: entry.actorId,
    actor: entities.user(entry.actorId),
    source: entry.source,
    createdAt: entry.createdAt.toISOString(),
  });

  /** 申诉记录 → API 形状；`holdMinutes` 用来算「还剩多少分钟超时转派」。 */
  const appealItem = (
    record: AppealRecord,
    holdMinutes: number,
  ): AdminApiAppealItem => {
    const pending = record.status === "pending";
    const elapsedMinutes = Math.floor(
      (now().getTime() - record.createdAt.getTime()) / 60_000,
    );
    const remaining = holdMinutes - elapsedMinutes;
    return {
      appealId: record.appealId,
      code: codeLabel(record.appealId),
      punishmentId: record.punishmentId,
      punishmentCode: codeLabel(record.punishmentId),
      groupId: record.groupId,
      group: entities.group(record.groupId),
      userId: record.userId,
      appellant: entities.user(record.userId),
      reason: record.reason,
      status: record.status,
      reviewerId: record.reviewerId,
      ...(record.reviewerId.length > 0
        ? { reviewer: entities.user(record.reviewerId) }
        : {}),
      note: record.note,
      createdAt: record.createdAt.toISOString(),
      ...(record.reviewedAt !== undefined
        ? { reviewedAt: record.reviewedAt.toISOString() }
        : {}),
      ...(pending ? { holdRemainingMinutes: remaining } : {}),
      overdue: pending && holdMinutes > 0 && remaining < 0,
    };
  };

  const deliveryItem = (row: NotificationDelivery): AdminApiDeliveryItem => ({
    groupId: row.groupId,
    group: entities.group(row.groupId),
    requestId: row.requestId,
    userId: row.userId,
    recipient: entities.user(row.userId),
    status: row.status,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  });

  /** 申请人资料摘要（学号脱敏；没填过资料就返回 undefined，界面显示「未填写」）。 */
  const profileSummary = (
    userId: string,
  ): AdminApiProfileSummary | undefined => {
    const profile = deps.userProfiles?.get(userId);
    if (!profile) {
      return undefined;
    }
    return {
      name: profile.name,
      studentId: maskStudentId(profile.studentId),
      className: profile.className,
      college: profile.college,
      year: profile.year,
    };
  };

  /**
   * 处罚 / 申诉的「短码」就是它们自己的 `recordId`（模型里写死了 6 位随机码，
   * 展示成 `#A1B2C3`），不需要经短码表。
   */
  const codeLabel = (recordId: string): string => `#${recordId}`;

  const requirePunishments = (): PunishmentService => {
    const service = deps.punishments;
    if (!service) {
      throw unavailable("处罚数据源未装配（只读巡检模式 / 缺少数据库）。");
    }
    return service;
  };

  const requireBlacklist = (): BlacklistService => {
    const service = deps.blacklist;
    if (!service) {
      throw unavailable("黑名单数据源未装配（只读巡检模式 / 缺少数据库）。");
    }
    return service;
  };

  const requireNotifications = (): NotificationService => {
    const service = deps.notifications;
    if (!service) {
      throw unavailable("推送服务未启用（内存模式 / 只读巡检）。");
    }
    return service;
  };

  /** 话题视图（含当前门槛与订阅计数）：`/api/notify/topics` 与写端点返回体共用。 */
  const notifyTopicViews = async (): Promise<AdminApiNotifyTopic[]> =>
    buildNotifyTopicViews(
      (await deps.notificationSubscriptions?.findAll()) ?? [],
      (topic) => deps.notifications?.topicLevel(topic) ?? 0,
    );

  /**
   * 规则写入的公共前置：门槛（本群 130 / 全局 240，与指令层 `canManageRules` 同口径）+ 群 id 非空。
   *
   * 关键词增删与「恢复继承」都必须先过它，免得三处各写一遍门槛。
   */
  const requireRuleTarget = (actorId: string, rawGroupId: string): string => {
    const groupId = rawGroupId.trim();
    if (groupId.length === 0) {
      throw badRequest("缺少 group（群 ID；全局用 __default__）。");
    }
    if (groupId === DEFAULT_GROUP_ID) {
      requireGlobalSuperAdmin(actorId, "修改全局规则");
    } else {
      requireGroupAdmin(actorId, groupId, "修改群规则");
    }
    return groupId;
  };

  const requireClassAliases = (): ClassAliasService => {
    const service = deps.classAliases;
    if (!service) {
      throw unavailable("别名服务未启用（内存模式 / 只读巡检）。");
    }
    return service;
  };

  /** 别名表视图（读端点与写端点返回体共用）。 */
  const aliasItems = (): AdminApiAliasItem[] =>
    (deps.classAliases?.list() ?? []).map((alias) => ({
      alias: alias.alias,
      target: alias.target,
      kind: alias.kind,
    }));

  const requireAppeals = (): AppealService => {
    const service = deps.appeals;
    if (!service) {
      throw unavailable("申诉数据源未装配（只读巡检模式 / 缺少数据库）。");
    }
    return service;
  };

  const requireGlobalSuperAdmin = (actorId: string, action: string): void => {
    if (deps.permissions.meetsGlobal(actorId, PlatformLevel.GlobalSuperAdmin)) {
      return;
    }
    appendAudit({
      groupId: "",
      actorId,
      action: "admin_api:denied",
      status: AuditStatus.Rejected,
      reason: `${action} 需要平台超级管理员（240）`,
    });
    throw forbidden("权限不足：需要平台超级管理员。");
  };

  /** 路径参数：`#申请短码`（推荐）或完整 `request_id`。 */
  const resolveRequestId = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw badRequest("缺少申请 ID。");
    }
    const resolved = deps.shortCodes?.resolve(trimmed);
    return resolved?.kind === "join_request" ? resolved.targetId : trimmed;
  };

  const requirePending = (raw: string): JoinRequest => {
    const requestId = resolveRequestId(raw);
    let request: JoinRequest;
    try {
      request = deps.joinAudit.get(requestId);
    } catch {
      throw notFound(`找不到待审批申请 ${requestId}。`);
    }
    if (request.status !== JoinRequestStatus.Pending) {
      throw conflict("这条申请已经被处理过了（其它管理员 / 群管理后台）。");
    }
    return request;
  };

  const requireActivity = (raw: string) => {
    const code = raw.trim();
    if (code.length === 0) {
      throw badRequest("缺少活动短码。");
    }
    const activity = deps.activity.findByCode(code);
    if (!activity) {
      throw notFound(`活动不存在：${code}`);
    }
    return activity;
  };

  const activityItem = (activityId: string): AdminApiActivityItem => {
    const activity = deps.activity.getActivity(activityId);
    return {
      activityId: activity.activityId,
      code: activity.code,
      title: activity.title,
      groupId: activity.groupId,
      status: activity.status,
      ...(activity.capacity !== undefined ? { capacity: activity.capacity } : {}),
      registered: deps.activity.listRegistrations(activity.activityId).length,
      createdAt: activity.createdAt.toISOString(),
      group: entities.group(activity.groupId),
      boundGroups: deps.activity
        .listBoundGroups(activity.activityId)
        .map((groupId) => entities.group(groupId)),
      ...(activity.closeAt !== undefined
        ? { closeAt: activity.closeAt.toISOString() }
        : {}),
    };
  };

  /**
   * 统计报表的**数据装配**：读端点与 CSV 导出共用一份，保证两边口径一致。
   *
   * 只读巡检模式没有内存态（审计 / 处罚 / 活动都在进程里），这里直接回 503。
   */
  const collectReports = async (options: {
    group?: string | undefined;
    days: number;
  }): Promise<AdminApiReportsView> => {
    const repository = deps.notificationDeliveries;
    if (!repository) {
      throw unavailable("统计报表数据源未装配（只读巡检模式 / 缺少数据库）。");
    }
    const activities = deps.activity.listAllActivities();
    return buildAdminApiReports({
      now: new Date(),
      days: options.days,
      ...(options.group !== undefined ? { groupId: options.group } : {}),
      audit: deps.auditLog.all(),
      punishments: deps.punishments?.listAll() ?? [],
      activities,
      registrations: activities.flatMap((activity) =>
        deps.activity.listRegistrations(activity.activityId),
      ),
      waitlist: activities.flatMap((activity) =>
        deps.activity.listWaitlist(activity.activityId),
      ),
      deliveries: await repository.findAll(),
      entities,
    });
  };

  /** 权限成员：`userId` + 展示信息。 */
  const permissionMember = (userId: string): AdminApiPermissionMember => ({
    userId,
    user: entities.user(userId),
  });

  /** 一条身份映射：内部 ID + 展示信息 +（有的话）绑定 / 改绑时间。 */
  const identityItem = (row: IdentityBinding): AdminApiIdentityItem => ({
    officialId: row.officialId,
    entity:
      row.kind === "user"
        ? entities.user(row.officialId)
        : entities.group(row.officialId),
    externalId: row.externalId,
    ...(row.createdAt !== undefined
      ? { createdAt: row.createdAt.toISOString() }
      : {}),
    ...(row.updatedAt !== undefined
      ? { updatedAt: row.updatedAt.toISOString() }
      : {}),
  });

  /** 权限目标（人）：openid / 已绑定的 QQ号 / #短码；认不出来就原样当 openid。 */
  const resolvePermissionUser = (raw: string | undefined): string => {
    const value = (raw ?? "").trim();
    if (value.length === 0) {
      throw badRequest("需要 userId（openid / 已绑定的 QQ号 / #短码）。");
    }
    return deps.identityMap?.resolveUserId(value) ?? value;
  };

  /** 权限目标（群）：内部群 ID / #群短码 / 群号；认不出来按内部群 ID 原样。 */
  const resolvePermissionGroup = (raw: string | undefined): string => {
    const value = (raw ?? "").trim();
    if (value.length === 0) {
      throw badRequest("群角色需要 group（内部群 ID / #群短码 / 群号）。");
    }
    return deps.identityMap?.resolveGroupId(value) ?? value;
  };

  /** 规则视图（覆盖行 + 生效值）：`/api/rules` 与规则写端点的 diff 共用同一份口径。 */
  const rulesViewOf = async (groupId: string): Promise<AdminApiRulesView> => {
    const override = deps.configStore
      .listOverrides()
      .find((row) => row.groupId === groupId);
    const settings = deps.groupSettings
      ? (await deps.groupSettings.findAll())
          .filter((row) => row.groupId === groupId)
          .map((row) => ({ key: row.key, value: row.value }))
      : [];
    return {
      groupId,
      group: entities.group(groupId),
      override:
        (override as unknown as Record<string, unknown> | undefined) ?? null,
      settings,
      effective: deps.configStore.get(groupId) as unknown as Record<
        string,
        unknown
      >,
    };
  };

  /**
   * 一次改多项的实现（`updateRule` 是「只有一项」的特例，走同一条路）。
   *
   * 三条口径：
   * - **先全部解析、再落库**：任何一项不合法 → 整体 400 + 审计 `rejected`，**不写半套**；
   * - 回执带**逐字段 diff**（生效值的 旧值 → 新值，与界面同一套展示口径），
   *   所以「一次改了几项、各自从什么变成了什么」有出处（审计里也带）；
   * - 项数上限 20（一次点几十个字段已经是误操作，别让一次请求改出半张表）。
   */
  const applyRuleUpdates = async (input: {
    group: string;
    updates: Array<{ field: string; value: string }>;
    actorId: string;
  }): Promise<AdminApiRuleUpdateResult> => {
    const groupId = input.group.trim();
    if (groupId.length === 0) {
      throw badRequest("缺少 group（群 ID / #群短码 / 全局用 __default__）。");
    }
    if (input.updates.length === 0) {
      throw badRequest("至少给一项要改的字段。");
    }
    if (input.updates.length > 20) {
      throw badRequest("一次最多改 20 项（多了请分两次，避免误操作）。");
    }
    // 与指令层 `canManageRules` 同口径：全局规则只有平台超管能改
    if (groupId === DEFAULT_GROUP_ID) {
      requireGlobalSuperAdmin(input.actorId, "修改全局规则");
    } else {
      requireGroupAdmin(input.actorId, groupId, "修改群规则");
    }
    const before = await rulesViewOf(groupId);
    // 1) 先全部解析（dry-run）：这里不落库
    const parsed: Array<{
      field: string;
      value: string;
      override: Record<string, unknown> & { groupId: string };
    }> = [];
    for (const update of input.updates) {
      const trimmedField = update.field.trim();
      if (trimmedField.length === 0) {
        throw badRequest("缺少 field（规则字段名）。");
      }
      try {
        parsed.push({
          field: trimmedField,
          value: update.value,
          override: parseRuleSetting(
            groupId,
            trimmedField,
            update.value,
            deps.configStore,
          ) as unknown as Record<string, unknown> & { groupId: string },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendAudit({
          groupId,
          actorId: input.actorId,
          action: "admin_api:rule_update",
          status: AuditStatus.Rejected,
          reason: `字段=${trimmedField} 解析失败：${message}`,
        });
        throw badRequest(`规则值不合法：${message}`);
      }
    }
    // 2) 落库：一次性把解析好的覆盖写进去（同一个 setOverride 入口）
    for (const item of parsed) {
      deps.configStore.setOverride(item.override);
    }
    const after = await rulesViewOf(groupId);
    const fields: string[] = [];
    for (const item of parsed) {
      for (const key of Object.keys(item.override)) {
        if (key !== "groupId" && !fields.includes(key)) {
          fields.push(key);
        }
      }
    }
    const changes = fields.map((key) => ({
      field: key,
      label: ruleFieldLabel(key),
      before: describeRuleValue(ruleValueOf(before, key)),
      after: describeRuleValue(ruleValueOf(after, key)),
    }));
    appendAudit({
      groupId,
      actorId: input.actorId,
      action: "admin_api:rule_update",
      status: AuditStatus.Executed,
      reason: `字段=${fields.join(",")} ${changes
        .map((change) => `${change.field}: ${change.before} → ${change.after}`)
        .join("；")}`,
    });
    log.info("admin api rules updated", {
      groupId,
      actorId: input.actorId,
      fields: fields.join(","),
      entries: parsed.length,
    });
    return {
      groupId,
      locale: groupId === DEFAULT_GROUP_ID ? "global" : "group",
      fields,
      changes,
      message:
        groupId === DEFAULT_GROUP_ID
          ? "已更新全局规则（影响所有未单独覆盖的群）。"
          : "已更新群规则。",
    };
  };

  return {
    // ---------------------------------------------------------------- 只读

    status: async () => ({
      database: deps.database ?? "unknown",
      migrationIssues: deps.migrationIssues ?? 0,
      activeTokens: (await deps.adminTokens?.countActive()) ?? 0,
    }),

    audit: async () =>
      [...deps.auditLog.all()]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map((record) => ({
          recordId: record.recordId,
          groupId: record.groupId,
          actorId: record.actorId,
          action: record.action,
          status: record.status,
          reason: record.reason,
          createdAt: record.createdAt.toISOString(),
          group: entities.group(record.groupId),
          // 操作人可能是机器人自己（actorId = "bot"）或机器令牌（`machine:xxx`），
          // 它们没有绑定号也没有短码，展示层会自动退回截断后的 id。
          actor: entities.user(record.actorId),
          ...(record.targetUserId !== undefined
            ? {
                targetUserId: record.targetUserId,
                target: entities.user(record.targetUserId),
              }
            : {}),
        })),

    pending: async (): Promise<AdminApiPendingItem[]> =>
      [...deps.joinAudit.listPending()]
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((request) => {
          const profile = profileSummary(request.userId);
          return {
            requestId: request.requestId,
            groupId: request.groupId,
            userId: request.userId,
            reason: request.reason,
            createdAt: request.createdAt.toISOString(),
            group: entities.group(request.groupId),
            applicant: entities.user(request.userId),
            request: entities.request(request.requestId),
            ...(profile !== undefined ? { profile } : {}),
          };
        }),

    rules: (groupId: string): Promise<AdminApiRulesView> => rulesViewOf(groupId),

    /**
     * 规则覆盖率总览（平台超管 240）：哪些群覆盖了哪些字段。
     *
     * 与机器人 `/rules overrides`（`ruleOverridesCard`）**同一个数据源**
     * （`GroupConfigStore.listOverrideSummaries()`），只是这里一次全给、不翻页。
     * 只读巡检模式没有这个内存态服务 → 503。
     */
    ruleOverrides: async (): Promise<AdminApiRuleOverridesView> => {
      const summaries = deps.configStore.listOverrideSummaries();
      const items = summaries.map((summary) => ({
        groupId: summary.groupId,
        group: entities.group(summary.groupId),
        fields: summary.fields as unknown as string[],
        labels: summary.fields.map((field) =>
          ruleFieldLabel(field as string),
        ),
        fieldCount: summary.fields.length,
      }));
      return {
        items,
        totalGroups: items.length,
        totalFields: items.reduce((sum, item) => sum + item.fieldCount, 0),
      };
    },

    notifyTopics: notifyTopicViews,

    /**
     * 定时发言列表（本群群管 130；HTTP 层已判过门槛）。
     *
     * 每项都带**后五次执行时间**（与 `/announce show` 同一口径），
     * 响应里带上总开关与每小时上限，页面据此提示「总开关关着，配了也不会发」。
     */
    scheduledAnnouncements: async (
      groupId: string,
    ): Promise<AdminApiAnnouncementsView> => announcementsView(groupId),

    /**
     * 订阅关系只读（平台超管 240）：谁订了哪些话题、订的哪个范围、现在够不够门槛。
     *
     * 数据源是**推送服务的内存订阅表**（权威），不是 `notification_subscriptions` 原始行 ——
     * 只有服务里才有「现在的角色还够不够」这份判据（`checkTopicReach`，与推送同一份）。
     * 因此只读巡检模式（没有推送服务）回 503。
     */
    notifySubscriptions: async (options): Promise<AdminApiNotifySubscriptionsView> => {
      const notifications = requireNotifications();
      if (
        options.topic !== undefined &&
        !(NOTIFY_CHANNELS as readonly string[]).includes(options.topic)
      ) {
        throw badRequest(
          `未知话题：${options.topic}。可用：${NOTIFY_CHANNELS.join(" / ")}`,
        );
      }
      const wantedUser =
        options.userId === undefined
          ? undefined
          : (deps.identityMap?.resolveUserId(options.userId) ?? options.userId);
      const rows = notifications.listSubscriptions();
      const items: AdminApiNotifySubscriptionItem[] = [];
      for (const row of rows) {
        if (options.topic !== undefined && row.topic !== options.topic) {
          continue;
        }
        if (options.group !== undefined && row.scope !== options.group) {
          continue;
        }
        if (wantedUser !== undefined && row.userId !== wantedUser) {
          continue;
        }
        const reach = notifications.checkTopicReach(
          row.userId,
          row.topic,
          row.scope,
        );
        if (options.ineligibleOnly === true && reach.ok) {
          continue;
        }
        const all = row.scope === NOTIFY_SCOPE_ALL;
        items.push({
          userId: row.userId,
          user: entities.user(row.userId),
          topic: row.topic,
          topicLabel: NOTIFY_TOPIC_META[row.topic].label,
          scope: all ? "all" : "group",
          ...(all
            ? {}
            : { groupId: row.scope, group: entities.group(row.scope) }),
          eligible: reach.ok,
          reason: reach.reason,
        });
      }
      return {
        items,
        total: items.length,
        // 计数始终按**全部**订阅行算（不受筛选影响）：它对应话题表那一列
        counts: buildNotifyTopicViews(
          rows.map((row) => ({
            userId: row.userId,
            scope: `${row.topic}:${row.scope}`,
          })),
          (topic) => notifications.topicLevel(topic),
        ),
      };
    },

    aliases: async () => aliasItems(),

    activities: async () =>
      deps.activity.listAllActivities().map((activity) => activityItem(activity.activityId)),

    // ------------------------------------------------- P1 只读补齐（域数据）

    punishments: async (options) => {
      const service = requirePunishments();
      const records =
        options.group === undefined
          ? service.listAll()
          : service.listByGroup(options.group, Number.MAX_SAFE_INTEGER);
      const filtered =
        options.status === undefined
          ? records
          : records.filter((record) => record.status === options.status);
      return filtered.map(punishmentItem);
    },

    blacklist: async (groupId, options) => {
      const service = requireBlacklist();
      return {
        groupId,
        group: entities.group(groupId),
        entries: service.entriesForGroup(groupId).map(blacklistItem),
        globalEntries: options.includeGlobal
          ? service.globalEntries().map(blacklistItem)
          : [],
        globalVisible: options.includeGlobal,
      };
    },

    appeals: async (options) => {
      const service = requireAppeals();
      const holdMinutes = deps.platform?.get("appealHoldMinutes") ?? 0;
      const all = service
        .listAll()
        .filter(
          (record) =>
            options.group === undefined || record.groupId === options.group,
        );
      const filtered =
        options.status === undefined
          ? all
          : all.filter((record) => record.status === options.status);
      return {
        items: filtered.map((record) => appealItem(record, holdMinutes)),
        holdMinutes,
        pendingCount: all.filter((record) => record.status === "pending").length,
      };
    },

    deliveries: async (options) => {
      const repository = deps.notificationDeliveries;
      if (!repository) {
        throw unavailable(
          "投递记录数据源未装配（只读巡检模式 / 缺少数据库）。",
        );
      }
      const rows = await repository.findAll();
      return rows
        .filter(
          (row) => options.group === undefined || row.groupId === options.group,
        )
        .filter(
          (row) => options.status === undefined || row.status === options.status,
        )
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        )
        .map(deliveryItem);
    },

    reports: async (options) => collectReports(options),

    /** 登录令牌只读（平台超管 240）：按成员聚合，**不暴露哈希**（见 `aggregateActiveAdminTokens`）。 */
    tokens: async () => {
      const repository = deps.adminTokens;
      if (!repository) {
        throw unavailable(
          "登录令牌仓储未装配（内存模式 / 纯测试）：令牌列表看不了。",
        );
      }
      return aggregateActiveAdminTokens(await repository.listActive(), entities);
    },

    identities: async () => {
      const repository = deps.identityBindings;
      if (repository) {
        const rows = await repository.findAll();
        return {
          users: rows.filter((row) => row.kind === "user").map(identityItem),
          groups: rows.filter((row) => row.kind === "group").map(identityItem),
        };
      }
      // 没接库（纯内存单测 / 假模式）：退回内存映射的列表，仍然只有读
      const map = deps.identityMap;
      return {
        users: (map?.listUsers() ?? []).map((row) =>
          identityItem({
            kind: "user",
            officialId: row.officialId,
            externalId: row.qq,
          }),
        ),
        groups: (map?.listGroups() ?? []).map((row) =>
          identityItem({
            kind: "group",
            officialId: row.officialId,
            externalId: row.groupNumber,
          }),
        ),
      };
    },

    permissions: async (options) => {
      const service = deps.permissions;
      const granted = service.listGrantedGroups();
      const groupIds = [
        ...new Set([
          ...granted,
          ...(options.group !== undefined ? [options.group] : []),
        ]),
      ].sort();
      const roleList = (
        role: PermissionRole,
        groupId?: string,
      ): AdminApiPermissionRoleList => ({
        role,
        roleLabel: PERMISSION_ROLE_LABELS[role],
        members: listPermissionRole(service, role, groupId).map(
          permissionMember,
        ),
      });
      return {
        groups: groupIds.map((groupId) => ({
          groupId,
          group: entities.group(groupId),
        })),
        global: [roleList("super")],
        ...(options.group !== undefined
          ? {
              group: {
                group: entities.group(options.group),
                roles: [
                  roleList("group_super", options.group),
                  roleList("group_admin", options.group),
                  roleList("moderator", options.group),
                ],
              },
            }
          : {}),
      };
    },

    health: async (): Promise<AdminApiHealthView> => {
      const memory = process.memoryUsage();
      const queue = deps.writeQueue;
      const notify = deps.notifications?.stats();
      const failure = readRestartFailure();
      const rollback = readRollbackNotice();
      return {
        process: {
          runningVersion: runningVersionOf(),
          diskVersion: onDiskVersion(),
          uptimeMs: Math.round(process.uptime() * 1000),
          startedAt: processStartedAt().toISOString(),
          pid: process.pid,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          mode: deps.mode ?? "unknown",
        },
        database: {
          driver: deps.database ?? "unknown",
          migrationIssues: (deps.migration?.issues ?? []).map((issue) => ({
            step: String(issue.step),
            error: String(issue.error),
          })),
        },
        queue: {
          pending: queue?.pending ?? 0,
          failures: queue?.failures ?? 0,
          ...(queue?.lastError !== undefined
            ? { lastError: queue.lastError }
            : {}),
        },
        notify: {
          subscribers: notify?.subscribers ?? 0,
          deliveries: notify?.deliveries ?? 0,
        },
        modules: (deps.health?.()?.list() ?? []).map((status) => ({
          key: status.key,
          label: status.label,
          state: status.state,
          ...(status.error !== undefined ? { error: status.error } : {}),
        })),
        restart: {
          ...(failure !== undefined
            ? {
                failure: {
                  reason: failure.reason ?? "未知原因",
                  ...(failure.at !== undefined ? { at: failure.at } : {}),
                  ...(typeof failure.code === "number"
                    ? { code: failure.code }
                    : {}),
                },
              }
            : {}),
          ...(rollback !== undefined
            ? {
                rollback: {
                  reason: String(rollback.reason),
                  at: String(rollback.at),
                },
              }
            : {}),
          brokenBuild: existsSync(DIST_BROKEN_DIR),
        },
      };
    },

    permissionsOf: async (userId: string): Promise<AdminApiPermissionsView> => {
      // 群集合 = 有授权行的群 ∪ 有规则覆盖的群 ∪ **绑过群号的群**；
      // 与只读巡检模式口径一致（后者同样从 `group_configs` / `identity_bindings` 取）。
      // 第三个来源是必须的：刚 `/bind group` 完、还没写过任何规则或授权行的群，
      // 以前**不会**出现在后台的群列表里（真机报过：`/whois` 查得到这个群，
      // 管理平台里却只有别的群）—— 群列表是「这个机器人管得到的群」，
      // 绑定表就是这份权威来源；`describePermissions` 只保留本人 ≥120 的群，不会越权展示。
      const boundGroupIds = ((await deps.identityBindings?.findAll()) ?? [])
        .filter((row) => row.kind === "group")
        .map((row) => row.officialId);
      const groupIds = new Set<string>([
        ...deps.permissions.listModeratedGroups(userId),
        ...deps.configStore.listOverrideSummaries().map((row) => row.groupId),
        ...boundGroupIds,
      ]);
      return describePermissions(deps.permissions, userId, [...groupIds], entities);
    },

    userRefOf: (userId: string): AdminApiEntityRef => entities.user(userId),

    tasks: (): AdminApiTasksView | undefined => {
      const state = deps.tickTasks?.();
      if (!state) {
        return undefined;
      }
      const pending = deps.deploy?.pending();
      return {
        intervalMs: state.intervalMs,
        started: state.started,
        tasks: state.tasks,
        ...(pending !== undefined
          ? {
              deploy: {
                targetVersion: pending.targetVersion,
                currentVersion: pending.currentVersion,
                detectedAt: pending.detectedAt,
                deadlineAt: pending.deadlineAt,
              },
            }
          : {}),
      };
    },

    settings: (): AdminApiSettingsView | undefined => {
      const platform = deps.platform;
      return platform ? buildSettingsView(platform) : undefined;
    },

    auditDenied: (input: AdminApiDeniedInput): void => {
      appendAudit({
        groupId: input.groupId,
        actorId: input.actorId,
        action: "admin_api:denied",
        status: AuditStatus.Rejected,
        reason: `${input.route} ${input.reason}`,
      });
      log.warn("admin api access denied", {
        actorId: input.actorId,
        route: input.route,
        reason: input.reason,
        groupId: input.groupId,
      });
    },

    // ---------------------------------------------------------------- 写

    approveJoin: async (rawRequestId, actorId) => {
      const request = requirePending(rawRequestId);
      requireGroupAdmin(actorId, request.groupId, "通过入群申请");
      await deps.joinApproval.approve(
        request.groupId,
        request.requestId,
        actorId,
      );
      appendAudit({
        groupId: request.groupId,
        actorId,
        action: "admin_api:approve_join",
        status: AuditStatus.Executed,
        reason: `来源=管理后台 申请=${request.requestId}`,
        targetUserId: request.userId,
      });
      log.info("admin api approved join request", {
        groupId: request.groupId,
        actorId,
      });
      return {
        requestId: request.requestId,
        groupId: request.groupId,
        status: JoinRequestStatus.Approved,
        message: "已通过入群申请。",
      };
    },

    rejectJoin: async (rawRequestId, actorId, reason) => {
      const request = requirePending(rawRequestId);
      requireGroupAdmin(actorId, request.groupId, "拒绝入群申请");
      const trimmed = reason.trim();
      await deps.joinApproval.reject(
        request.groupId,
        request.requestId,
        actorId,
        trimmed,
      );
      appendAudit({
        groupId: request.groupId,
        actorId,
        action: "admin_api:reject_join",
        status: AuditStatus.Executed,
        reason: `来源=管理后台 申请=${request.requestId}${
          trimmed.length > 0 ? ` 理由=${trimmed}` : ""
        }`,
        targetUserId: request.userId,
      });
      log.info("admin api rejected join request", {
        groupId: request.groupId,
        actorId,
        hasReason: trimmed.length > 0,
      });
      return {
        requestId: request.requestId,
        groupId: request.groupId,
        status: JoinRequestStatus.Rejected,
        message: "已拒绝入群申请。",
      };
    },

    /**
     * 改规则：**单字段是批量的特例**（`applyRuleUpdates` 传一项）。
     *
     * 口径（与指令层同源）：门槛 `canManageRules`（本群 130 / 全局 240）、值的解析走
     * `parseRuleSetting`、落库走 `configStore.setOverride` —— 与机器人 `/rules set` 同一入口。
     */
    updateRule: (rawGroupId, field, value, actorId) =>
      applyRuleUpdates({
        group: rawGroupId,
        updates: [{ field, value }],
        actorId,
      }),

    /** 一次改多项（收尾批次 E）：实现见 `applyRuleUpdates`（先全解析、再落库，回执带 diff）。 */
    updateRules: applyRuleUpdates,

    setActivityStatus: async (rawCode, action, actorId) => {
      const activity = requireActivity(rawCode);
      requireGroupAdmin(actorId, activity.groupId, "变更活动状态");
      const updated =
        action === "open"
          ? deps.activity.openActivity(activity.activityId)
          : action === "close"
            ? deps.activity.closeActivity(activity.activityId)
            : deps.activity.cancelActivity(activity.activityId);
      appendAudit({
        groupId: activity.groupId,
        actorId,
        action: `admin_api:activity_${action}`,
        status: AuditStatus.Executed,
        reason: `活动=${activity.code} 状态=${activity.status}→${updated.status}`,
      });
      log.info("admin api activity status changed", {
        activityId: activity.activityId,
        actorId,
        action,
      });
      return {
        activityId: updated.activityId,
        code: updated.code,
        groupId: updated.groupId,
        status: updated.status,
        message: `活动状态已更新为 ${updated.status}。`,
      };
    },

    exportActivityCsv: async (rawCode, actorId, options) => {
      const activity = requireActivity(rawCode);
      requireGroupAdmin(actorId, activity.groupId, "导出活动名单");
      const registrations = deps.activity.listRegistrations(activity.activityId);
      const waitlist = deps.activity.listWaitlist(activity.activityId);
      const csv = deps.activityExport.buildCsv({
        activity,
        registrations,
        waitlist,
        operatorId: actorId,
        maskPii: !options.full,
      });
      const rows = registrations.length + waitlist.length;
      appendAudit({
        groupId: activity.groupId,
        actorId,
        action: "admin_api:activity_export",
        status: AuditStatus.Executed,
        reason: `活动=${activity.code} 行=${rows} 含隐私=${options.full ? "是" : "否"}`,
      });
      log.info("admin api exported activity csv", {
        activityId: activity.activityId,
        actorId,
        rows,
        full: options.full,
      });
      return {
        filename: `activity-${activity.code}.csv`,
        csv,
        rows,
        full: options.full,
      };
    },

    updateSetting: async (key, value, actorId) => {
      requireGlobalSuperAdmin(actorId, "改平台配置");
      const platform = requirePlatform();
      const trimmed = key.trim();
      const before = platform.valueOf(trimmed);
      const result = await platform.set(trimmed, value);
      if (!result.ok) {
        // 校验失败（键名不存在 / 值不合法）：不写审计、不落库，把中文原因回给界面
        throw badRequest(result.error);
      }
      const item = toSettingItem(result.view);
      appendAudit({
        groupId: "",
        actorId,
        action: "admin_api:setting_update",
        status: AuditStatus.Executed,
        reason:
          before === undefined
            ? `配置 ${item.key} = ${item.display}`
            : `配置 ${item.key}：${String(before)} → ${item.display}`,
      });
      log.info("admin api updated platform setting", {
        key: item.key,
        actorId,
        source: item.source,
      });
      return item;
    },

    clearSetting: async (key, actorId) => {
      requireGlobalSuperAdmin(actorId, "恢复平台配置");
      const platform = requirePlatform();
      const trimmed = key.trim();
      const cleared = await platform.clear(trimmed);
      if (!cleared.ok) {
        throw badRequest(cleared.error ?? "恢复默认值失败。");
      }
      const view = platform
        .list()
        .find((item) => item.definition.key === trimmed);
      if (!view) {
        throw badRequest(`没有叫「${trimmed}」的可改配置项`);
      }
      const item = toSettingItem(view);
      appendAudit({
        groupId: "",
        actorId,
        action: "admin_api:setting_clear",
        status: AuditStatus.Executed,
        reason: `配置 ${item.key} 恢复 .env 默认值（现为 ${item.display}）`,
      });
      log.info("admin api cleared platform setting", {
        key: item.key,
        actorId,
      });
      return item;
    },
    syncJoinRequests: async (groupId, actorId) => {
      const service = deps.joinSync;
      if (!service) {
        throw unavailable("申请队列同步未装配（只读巡检模式）。");
      }
      requireGroupModerator(actorId, groupId, "同步入群申请");
      const fetched = await service.syncGroup(groupId);
      const pending = deps.joinAudit
        .listPending()
        .filter((request) => request.groupId === groupId).length;
      appendAudit({
        groupId,
        actorId,
        action: "admin_api:join_sync",
        status: AuditStatus.Executed,
        reason: `同步官方申请 ${fetched.length} 条（当前待审批 ${pending} 条）`,
      });
      log.info("admin api synced join requests", {
        groupId,
        actorId,
        fetched: fetched.length,
        pending,
      });
      return {
        groupId,
        group: entities.group(groupId),
        fetched: fetched.length,
        pending,
        message: `已同步 ${fetched.length} 条官方申请（当前待审批 ${pending} 条）。`,
      };
    },

    exportAuditCsv: async (actorId, options) => {
      const service = deps.exportService;
      if (!service) {
        throw unavailable("审计导出未装配（只读巡检模式）。");
      }
      const groupId = options.group;
      if (groupId === undefined) {
        requireGlobalSuperAdmin(actorId, "导出全量审计");
      } else {
        requireGroupAdmin(actorId, groupId, "导出审计记录");
      }
      // `full=1` = 导出**完整 openid**（不脱敏）：指令层 `/export audit` 永远脱敏、最多 50 条，
      // 这里更进一步，所以单独抬到平台超管 240 —— CSV 会落到下载目录，暴露面比页面大一档。
      if (options.full) {
        requireGlobalSuperAdmin(actorId, "导出未脱敏审计记录");
      }
      const records = deps.auditLog
        .all()
        .filter((record) => groupId === undefined || record.groupId === groupId);
      // 领域层自己按「本群 130」再校验一次（平台导出时 groupId=""，240 折算成 140 同样过），
      // 并写一条 `export_audit_records` 审计 —— 与指令层 `/export audit` 同一实现。
      const csv = service.exportAuditRecordsCsv(
        actorId,
        groupId ?? "",
        records,
        !options.full,
      );
      appendAudit({
        groupId: groupId ?? "",
        actorId,
        action: "admin_api:audit_export",
        status: AuditStatus.Executed,
        reason: `导出审计 行=${records.length} 含隐私=${options.full ? "是" : "否"}`,
      });
      log.info("admin api exported audit csv", {
        groupId: groupId ?? "all",
        actorId,
        rows: records.length,
        full: options.full,
      });
      return {
        filename: `audit-${groupId ?? "all"}.csv`,
        csv,
        rows: records.length,
        full: options.full,
      };
    },

    /**
     * 重试加载一个降级模块（运维写，平台超管 240）。
     *
     * 与机器人 `/status proc` 的「重试加载」按钮**同一个入口**（`HealthRegistry.retry`，
     * 见 `adminCommands.moduleRetryCard`）：只重跑该模块的 `load()` —— 幂等、不动业务数据、
     * 不重启进程。修好数据 / 环境后一次点击就能恢复该功能域。
     */
    retryModule: async (key, actorId) => {
      requireGlobalSuperAdmin(actorId, "重试加载模块");
      const health = deps.health?.();
      if (!health) {
        throw unavailable(
          "模块健康注册表未装配（只读巡检模式 / 内存模式）：请用机器人进程内的管理监听口重试。",
        );
      }
      const moduleKey = key.trim();
      if (!(MODULE_KEYS as readonly string[]).includes(moduleKey)) {
        throw badRequest(
          `未知模块：${moduleKey.length > 0 ? moduleKey : "（空）"}。可用：${MODULE_KEYS.join(" / ")}`,
        );
      }
      const before = health.statusOf(moduleKey as ModuleKey);
      const after = await health.retry(moduleKey as ModuleKey);
      const recovered = after.state === "ready";
      const reason =
        `模块=${after.key}(${after.label}) ${before.state}` +
        `${before.error !== undefined ? `(${truncate(before.error, 80)})` : ""} → ${after.state}` +
        `${after.error !== undefined ? `(${truncate(after.error, 80)})` : ""}`;
      appendAudit({
        groupId: "",
        actorId,
        action: "admin_api:module_retry",
        status: recovered ? AuditStatus.Executed : AuditStatus.Rejected,
        reason,
      });
      log.info("admin api retried module", {
        module: after.key,
        actorId,
        before: before.state,
        after: after.state,
      });
      return {
        module: {
          key: after.key,
          label: after.label,
          state: after.state,
          ...(after.error !== undefined ? { error: after.error } : {}),
        },
        recovered,
        message: recovered
          ? `「${after.label}」已重新加载成功，功能立即恢复，不用重启进程。`
          : `「${after.label}」仍然起不来：${after.error ?? "未知原因"}。修好数据 / 环境后可再试一次。`,
      };
    },

    /**
     * 吊销某个成员手上**全部未用**的登录令牌（平台超管 240）。
     *
     * 用途：`/admin login` 的链接发错了人 —— 不必等 TTL（默认 10 分钟）。
     * 只作用于未兑换的登录令牌；已兑换出来的**会话是签名 cookie**，不受这里影响（回执里写明）。
     * 本来就没有未用令牌时如实回 `revoked: 0`（审计记 rejected），不假装成功。
     */
    revokeTokens: async (input) => {
      requireGlobalSuperAdmin(input.actorId, "吊销登录令牌");
      const repository = deps.adminTokens;
      if (!repository) {
        throw unavailable(
          "登录令牌仓储未装配（内存模式 / 纯测试）：吊销不了。",
        );
      }
      // 目标接受 openid / 已绑定的 QQ号 / #短码（与权限目标同一套解析）
      const userId = resolvePermissionUser(input.userId);
      const revoked = await repository.revokeActiveForUser(userId);
      appendAudit({
        groupId: "",
        actorId: input.actorId,
        action: "admin_api:token_revoke",
        status: revoked > 0 ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: `目标=${userId} 作废未用登录令牌 ${revoked} 张`,
      });
      log.info("admin api revoked login tokens", {
        userId,
        actorId: input.actorId,
        revoked,
      });
      return {
        userId,
        user: entities.user(userId),
        revoked,
        message:
          revoked > 0
            ? `已作废 ${revoked} 张未用的登录令牌（已建立的会话不受影响）。`
            : "该成员没有未用的登录令牌（可能已经兑换或已过期）。",
      };
    },

    // ------------------------------------------------- 定时发言（本群群管 130 自治）
    /**
     * 新建一条定时发言：与 `/announce add` 同一个领域服务、同一份校验。
     *
     * **默认停用**（服务层写死 `enabled: false`），要显式开启才会触发；
     * 审计由领域服务统一写（`announce_create`，actor = 操作人），与指令层同一条记录。
     */
    createAnnouncement: async (input) => {
      requireGroupAdmin(input.actorId, input.groupId, "配置定时发言");
      const created = requireAnnouncements().create({
        groupId: input.groupId,
        cron: input.cron,
        content: input.content,
        actorId: input.actorId,
      });
      if (!created.ok) {
        throw badRequest(created.error);
      }
      log.info("admin api created announcement", {
        groupId: input.groupId,
        actorId: input.actorId,
        cron: created.announcement.cron,
      });
      return {
        ok: true,
        message: "已新建定时发言（默认停用；确认内容与时间表后再启用）。",
        announcement: announcementItemOf({
          task: created.announcement,
          entities,
        }),
        announcements: announcementsView(input.groupId),
      };
    },

    /**
     * 改一条：门槛按**这条任务所属群**判本群 130（不接受客户端传 group，
     * 免得「用 A 群的权限改 B 群的任务」）。
     */
    updateAnnouncement: async (input) => {
      const service = requireAnnouncements();
      const task = service.find(input.id);
      if (!task) {
        throw badRequest("定时发言不存在（可能刚被删掉）。");
      }
      requireGroupAdmin(input.actorId, task.groupId, "修改定时发言");
      const updated = service.update(
        input.id,
        {
          ...(input.cron !== undefined ? { cron: input.cron } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
        },
        input.actorId,
      );
      if (!updated.ok) {
        throw badRequest(updated.error);
      }
      log.info("admin api updated announcement", {
        groupId: task.groupId,
        actorId: input.actorId,
        enabled: updated.announcement.enabled,
      });
      return {
        ok: true,
        message: input.enabled === undefined
          ? "已保存定时发言。"
          : updated.announcement.enabled
            ? "已启用：下一次到点就会发出。"
            : "已停用：不会触发（任务保留）。",
        announcement: announcementItemOf({ task: updated.announcement, entities }),
        announcements: announcementsView(task.groupId),
      };
    },

    /** 删除一条（本群 130）：不可逆，界面要二次确认。 */
    removeAnnouncement: async (input) => {
      const service = requireAnnouncements();
      const task = service.find(input.id);
      if (!task) {
        throw badRequest("定时发言不存在（可能刚被删掉）。");
      }
      requireGroupAdmin(input.actorId, task.groupId, "删除定时发言");
      const removed = service.remove(input.id, input.actorId);
      if (!removed.ok) {
        throw badRequest(removed.error);
      }
      return {
        ok: true,
        message: `已删除定时发言（\`${removed.announcement.cron}\`）。`,
        announcements: announcementsView(task.groupId),
      };
    },

    /**
     * 立即发一条：**真实发送**（群里能看到），同样计入每小时上限。
     *
     * 用途：配完先在群里看一眼效果，别等到点了才发现文案 / 按钮不对。
     */
    sendAnnouncement: async (input) => {
      const service = requireAnnouncements();
      const task = service.find(input.id);
      if (!task) {
        throw badRequest("定时发言不存在（可能刚被删掉）。");
      }
      requireGroupAdmin(input.actorId, task.groupId, "试发定时发言");
      const result = await service.sendNow(input.id, input.actorId);
      if (!result.ok) {
        throw badRequest(result.detail);
      }
      return {
        ok: true,
        message:
          "已立即发一条（这是真实发送，同样计入每小时上限）。" +
          (task.enabled ? "" : " 注意：这条任务还是停用状态。"),
        announcement: announcementItemOf({ task, entities }),
        announcements: announcementsView(task.groupId),
      };
    },

    /**
     * 统计报表 CSV（E5）：与页面同一份装配（`collectReports`），只是输出成长表。
     *
     * 门槛：本群 130 拿**脱敏**长表；`full=1`（追加内部群 ID 列）与不带 `group=` 的
     * 全量都要平台 240 —— CSV 会落到下载目录，暴露面比页面大一档。
     */
    exportReportsCsv: async (actorId, options) => {
      const groupId = options.group;
      if (groupId === undefined) {
        requireGlobalSuperAdmin(actorId, "导出全量报表");
      } else {
        requireGroupAdmin(actorId, groupId, "导出报表");
      }
      if (options.full) {
        requireGlobalSuperAdmin(actorId, "导出含内部群 ID 的报表");
      }
      const view = await collectReports({
        ...(groupId !== undefined ? { group: groupId } : {}),
        days: options.days,
      });
      const csv = buildReportsCsv(view, { full: options.full });
      const rows = csv.trimEnd().split("\n").length - 1;
      appendAudit({
        groupId: groupId ?? "",
        actorId,
        action: "admin_api:report_export",
        status: AuditStatus.Executed,
        reason: `导出统计报表 天数=${view.range.days} 含内部群ID=${options.full ? "是" : "否"} 行=${rows}`,
      });
      log.info("admin api exported reports csv", {
        groupId: groupId ?? "all",
        actorId,
        days: view.range.days,
        full: options.full,
        rows,
      });
      return {
        filename: `report-${groupId ?? "all"}-${view.range.days}d.csv`,
        csv,
        rows,
        full: options.full,
      };
    },

    /**
     * 授予 / 撤销角色（平台超管 240）：与指令层 `/perm grant|revoke` **同一个 `PermissionService`**。
     *
     * 与指令层的差别只有两处（都是管理面独有的护栏）：
     * - 管理员**不能撤销自己的全局超管**（浏览器里点一下就把自己锁死，没有回滚入口）；
     * - 撤销一个本来就没有的授权时**如实回 `changed: false`**（审计记 rejected），
     *   而不是像卡片那样统一说「已更新权限」。
     */
    setPermission: async (input) => {
      requireGlobalSuperAdmin(input.actorId, "配置权限");
      const action = input.action;
      if (action !== "grant" && action !== "revoke") {
        throw badRequest("action 只能是 grant / revoke。");
      }
      const role = input.role.trim();
      if (!PERMISSION_ROLES.includes(role as PermissionRole)) {
        throw badRequest(
          `未知角色：${role || "（空）"}（可用：${PERMISSION_ROLES.join(" / ")}）。`,
        );
      }
      const typedRole = role as PermissionRole;
      const groupId = isGlobalPermissionRole(typedRole)
        ? undefined
        : resolvePermissionGroup(input.group);
      const userId = resolvePermissionUser(input.userId);
      if (action === "revoke" && typedRole === "super" && userId === input.actorId) {
        throw badRequest(
          "不能撤销自己的全局超级管理员：改完你就没有权限再改回来了（要让另一个超管来撤）。",
        );
      }
      const before = listPermissionRole(deps.permissions, typedRole, groupId);
      const had = before.includes(userId);
      if (action === "grant") {
        grantPermissionRole(deps.permissions, typedRole, groupId, userId);
      } else {
        try {
          revokePermissionRole(deps.permissions, typedRole, groupId, userId);
        } catch (error) {
          // 领域层的护栏（例如「不能撤销最后一个超级管理员」）原话给界面
          throw badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      const changed = action === "grant" ? !had : had;
      const roleLabel = PERMISSION_ROLE_LABELS[typedRole];
      const scopeLabel =
        groupId === undefined ? "全局" : entities.group(groupId).label;
      const target = entities.user(userId);
      appendAudit({
        groupId: groupId ?? "",
        actorId: input.actorId,
        action: action === "grant" ? "admin_api:perm_grant" : "admin_api:perm_revoke",
        status: changed ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: `${roleLabel}（${scopeLabel}）${action === "grant" ? "授予" : "撤销"} ${
          target.label
        }${changed ? "" : "（未改动：本来就是这个状态）"}`,
      });
      log.warn("admin api changed permission", {
        action,
        role: typedRole,
        groupId: groupId ?? "all",
        userId,
        actorId: input.actorId,
        changed,
      });
      return {
        action,
        role: typedRole,
        roleLabel,
        ...(groupId !== undefined ? { group: entities.group(groupId) } : {}),
        target,
        changed,
        members: listPermissionRole(deps.permissions, typedRole, groupId).map(
          permissionMember,
        ),
        message: changed
          ? action === "grant"
            ? `已授予 ${target.label} ${roleLabel}（${scopeLabel}）。`
            : `已撤销 ${target.label} 的 ${roleLabel}（${scopeLabel}）。`
          : action === "grant"
            ? `${target.label} 本来就有 ${roleLabel}（${scopeLabel}），未改动。`
            : `${target.label} 本来就没有 ${roleLabel}（${scopeLabel}），未改动。`,
      };
    },

    // ------------------------------------------------------------ P2 写操作

    punish: async (input) => {
      const service = requirePunishments();
      const record = service.get(input.code);
      if (!record) {
        throw notFound(`未找到处罚记录：${input.code}`);
      }
      requireGroupModerator(input.actorId, record.groupId, "处罚管理");
      if (input.action === "blacklist" && (input.scope ?? "group") === "global") {
        requireGlobalSuperAdmin(input.actorId, "全局拉黑");
      }

      const code = record.recordId;
      const actorId = input.actorId;
      let result: { ok: boolean; text: string; record: PunishmentRecord } | undefined;
      if (input.action === "release") {
        result = await service.release({
          code,
          actorId,
          ...(input.note !== undefined && input.note.length > 0
            ? { note: input.note }
            : {}),
        });
      } else if (input.action === "mute") {
        result = await service.setMute({
          code,
          actorId,
          seconds: input.seconds ?? 0,
        });
      } else if (input.action === "kick") {
        result = await service.kick({ code, actorId });
      } else {
        result = await service.blacklistUser({
          code,
          actorId,
          scope: input.scope ?? "group",
          ...(input.reason !== undefined && input.reason.length > 0
            ? { reason: input.reason }
            : {}),
        });
      }
      if (!result) {
        throw notFound(`未找到处罚记录：${input.code}`);
      }

      // 处置即回应申诉：与指令层 `/punish …` 一致，成功后顺手把该处罚下待处理的申诉判定为已通过
      let acceptedAppeals = 0;
      if (result.ok) {
        const decided = await deps.appeals?.acceptByPunishment({
          punishmentId: code,
          reviewerId: actorId,
          note: PUNISH_ACTION_NOTES[input.action],
        });
        acceptedAppeals = decided?.length ?? 0;
      }
      const detail =
        input.action === "mute"
          ? `禁言=${input.seconds ?? 0} 秒`
          : input.action === "blacklist"
            ? `范围=${input.scope ?? "group"}`
            : "";
      appendAudit({
        groupId: record.groupId,
        actorId,
        action: `admin_api:punish_${input.action}`,
        status: result.ok ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: `处罚 ${codeLabel(code)}${detail.length > 0 ? ` ${detail}` : ""}：${truncate(result.text, 120)}`,
        targetUserId: record.userId,
      });
      log.info("admin api punished record", {
        recordId: code,
        action: input.action,
        actorId,
        ok: result.ok,
        acceptedAppeals,
      });
      return {
        ok: result.ok,
        message: result.text,
        punishment: punishmentItem(result.record),
        acceptedAppeals,
      };
    },

    addBlacklist: async (input) => {
      const service = requireBlacklist();
      const scope = input.scope;
      const groupId = scope === "global" ? "" : (input.groupId ?? "");
      if (scope === "global") {
        requireGlobalSuperAdmin(input.actorId, "加入全局黑名单");
      } else {
        requireGroupModerator(input.actorId, groupId, "加入本群黑名单");
      }
      const result = await service.add({
        scope,
        groupId,
        userId: input.userId,
        actorId: input.actorId,
        ...(input.reason !== undefined && input.reason.length > 0
          ? { reason: input.reason }
          : {}),
        source: "manual",
      });
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:blacklist_add",
        status: AuditStatus.Executed,
        reason: `黑名单(${scope}) 加入 ${input.userId}：${truncate(result.detail, 120)}`,
        targetUserId: input.userId,
      });
      log.info("admin api added blacklist entry", {
        scope,
        groupId,
        actorId: input.actorId,
        kicked: result.kicked.length,
      });
      return {
        action: "add",
        ok: result.ok,
        message: `已加入${scope === "global" ? "全局" : "本群"}黑名单。${result.detail}`,
        scope,
        groupId,
        userId: input.userId,
        kickedGroups: result.kicked.length,
      };
    },

    removeBlacklist: async (input) => {
      const service = requireBlacklist();
      const scope = input.scope;
      const groupId = scope === "global" ? "" : (input.groupId ?? "");
      if (scope === "global") {
        requireGlobalSuperAdmin(input.actorId, "解除全局黑名单");
      } else {
        requireGroupModerator(input.actorId, groupId, "解除本群黑名单");
      }
      const removed = await service.remove(scope, groupId, input.userId);
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:blacklist_remove",
        status: removed ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: removed
          ? `黑名单(${scope}) 解除 ${input.userId}`
          : `黑名单(${scope}) 里没有 ${input.userId}`,
        targetUserId: input.userId,
      });
      return {
        action: "remove",
        ok: removed,
        message: removed ? "已解除黑名单。" : "这个人不在该黑名单里。",
        scope,
        groupId,
        userId: input.userId,
        kickedGroups: 0,
      };
    },

    decideAppeal: async (input) => {
      const service = requireAppeals();
      const appeal = service.get(input.code);
      if (!appeal) {
        throw notFound(`未找到申诉记录：${input.code}`);
      }
      requireGroupModerator(input.actorId, appeal.groupId, "处理申诉");
      if (appeal.status !== "pending") {
        throw conflict(
          `该申诉已经处理过了（${appeal.status === "accepted" ? "已通过" : "已驳回"}）。`,
        );
      }
      const punishment = deps.punishments?.get(appeal.punishmentId);
      const actorId = input.actorId;
      let message: string;
      if (input.decision === "accepted") {
        // 通过 = 撤销处罚（与指令层一致：逐项撤销，撤回与踢出不可逆）
        const released = deps.punishments?.get(appeal.punishmentId)
          ? await deps.punishments.release({
              code: appeal.punishmentId,
              actorId,
              note: "通过申诉",
            })
          : undefined;
        message = released?.text ?? "已通过申诉（处罚记录已不存在，只更新申诉状态）";
      } else {
        message = input.note?.trim() ?? "";
        if (message.length === 0) {
          message = "已驳回";
        }
      }
      const updated = await service.decide({
        code: appeal.appealId,
        reviewerId: actorId,
        status: input.decision,
        note: message,
      });
      if (!updated) {
        throw notFound(`未找到申诉记录：${input.code}`);
      }
      // 私信申诉人（与指令层同一条通道；失败只记日志，不影响结论）
      if (deps.moderationNotifier && punishment) {
        const sent = await deps.moderationNotifier.notifyAppealDecision(
          updated,
          punishment,
          input.decision === "accepted",
          actorId,
          message,
        );
        if (!sent.ok) {
          log.warn("appeal decision notify failed", {
            appealId: appeal.appealId,
            detail: sent.detail,
          });
        }
        await deps.moderationNotifier.notifyAppealHandled(
          updated,
          punishment,
          input.decision === "accepted",
          actorId,
        );
      }
      appendAudit({
        groupId: appeal.groupId,
        actorId,
        action: `admin_api:appeal_${input.decision === "accepted" ? "accept" : "reject"}`,
        status: AuditStatus.Executed,
        reason: `申诉 #${appeal.appealId}：${truncate(message, 120)}`,
        targetUserId: appeal.userId,
      });
      log.info("admin api decided appeal", {
        appealId: appeal.appealId,
        decision: input.decision,
        actorId,
      });
      return {
        appeal: appealItem(updated, deps.platform?.get("appealHoldMinutes") ?? 0),
        decision: input.decision,
        message,
      };
    },

    setNotifyLevel: async (input) => {
      requireGlobalSuperAdmin(input.actorId, "改话题门槛");
      const notifications = requireNotifications();
      if (!deps.notifyTopics) {
        throw unavailable(
          "通知话题门槛存储未装配（内存模式 / 只读巡检）：门槛改不了。",
        );
      }
      const topic = input.topic.trim();
      if (!isNotifyChannelName(topic)) {
        throw badRequest(
          `未知话题：${topic}。可用：${NOTIFY_CHANNELS.join(" / ")}`,
        );
      }
      const before = notifications.topicLevel(topic);
      try {
        notifications.setTopicLevel(topic, input.level);
      } catch (error) {
        // 数值范围由领域服务判定（与指令层同一套错误文案），原样回给界面
        throw badRequest(error instanceof Error ? error.message : String(error));
      }
      const after = notifications.topicLevel(topic);
      const message = `已把「${NOTIFY_TOPIC_META[topic].label}」的门槛从 ${describeNotifyLevel(before)} 改为 ${describeNotifyLevel(after)}。`;
      appendAudit({
        groupId: "",
        actorId: input.actorId,
        action: "admin_api:notify_level",
        status: AuditStatus.Executed,
        reason: `话题=${topic} ${before} → ${after}`,
      });
      log.info("admin api set notify level", {
        topic,
        actorId: input.actorId,
        before,
        after,
      });
      return { topics: await notifyTopicViews(), message };
    },

    resetNotifyLevels: async (actorId) => {
      requireGlobalSuperAdmin(actorId, "恢复话题门槛");
      const notifications = requireNotifications();
      notifications.resetTopicLevels();
      appendAudit({
        groupId: "",
        actorId,
        action: "admin_api:notify_level_reset",
        status: AuditStatus.Executed,
        reason: "所有话题门槛恢复默认",
      });
      log.info("admin api reset notify levels", { actorId });
      return {
        topics: await notifyTopicViews(),
        message: "所有话题门槛已恢复默认。",
      };
    },

    sendNotifyTest: async (input) => {
      const notifications = requireNotifications();
      const result = await notifications.sendTestCard(
        input.userId,
        input.groupId,
      );
      appendAudit({
        groupId: input.groupId ?? "",
        actorId: input.userId,
        action: "admin_api:notify_test",
        status: result.ok ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: result.ok ? "给自己发测试卡" : `测试卡发送失败：${truncate(result.text, 100)}`,
      });
      return {
        ok: result.ok,
        message: result.ok
          ? input.groupId
            ? `已把测试卡私信发给你（示例群：${input.groupId}）。`
            : "已把测试卡私信发给你。"
          : `测试卡没发出去：${result.text}（先私聊机器人一次，建立会话）`,
      };
    },

    // ------------------------------------------------- 规则关键词 / 恢复继承

    addRuleKeywords: async (input) => {
      const groupId = requireRuleTarget(input.actorId, input.groupId);
      const config = deps.configStore.get(groupId);
      const added: string[] = [];
      const skipped: Array<{ word: string; reason: string }> = [];
      for (const raw of input.words) {
        const word = raw.trim();
        // 逐词按指令层 `/rules add keyword` 的同一套规则校验（trim / 空 / 超长 / 重复）
        if (word.length === 0) {
          skipped.push({ word: raw, reason: "空词" });
          continue;
        }
        if (word.length > RULE_KEYWORD_MAX_LENGTH) {
          skipped.push({ word, reason: `超过 ${RULE_KEYWORD_MAX_LENGTH} 字` });
          continue;
        }
        if (config.keywords.includes(word) || added.includes(word)) {
          skipped.push({ word, reason: "已存在" });
          continue;
        }
        added.push(word);
      }
      if (added.length > 0) {
        deps.configStore.setOverride({
          groupId,
          keywords: [...config.keywords, ...added],
        });
      }
      const keywords = [...deps.configStore.get(groupId).keywords];
      const message = summarizeKeywordChange("添加", added, skipped, keywords.length);
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:rule_keywords",
        status: added.length > 0 ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: truncate(
          `加词=${added.join(",") || "（无）"} 跳过=${skipped.length}`,
          160,
        ),
      });
      log.info("admin api added rule keywords", {
        groupId,
        actorId: input.actorId,
        added: added.length,
        skipped: skipped.length,
      });
      return { keywords, added, removed: [], skipped, message };
    },

    removeRuleKeywords: async (input) => {
      const groupId = requireRuleTarget(input.actorId, input.groupId);
      const config = deps.configStore.get(groupId);
      const removed: string[] = [];
      const skipped: Array<{ word: string; reason: string }> = [];
      for (const raw of input.words) {
        const word = raw.trim();
        if (word.length === 0) {
          skipped.push({ word: raw, reason: "空词" });
          continue;
        }
        if (!config.keywords.includes(word)) {
          // 与指令层一致：删不存在的词要明确报「不存在」，不静默成功
          skipped.push({ word, reason: "不存在" });
          continue;
        }
        removed.push(word);
      }
      if (removed.length > 0) {
        const removedSet = new Set(removed);
        deps.configStore.setOverride({
          groupId,
          keywords: config.keywords.filter((word) => !removedSet.has(word)),
        });
      }
      const keywords = [...deps.configStore.get(groupId).keywords];
      const message = summarizeKeywordChange("删除", removed, skipped, keywords.length);
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:rule_keywords",
        status: removed.length > 0 ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: truncate(
          `删词=${removed.join(",") || "（无）"} 跳过=${skipped.length}`,
          160,
        ),
      });
      log.info("admin api removed rule keywords", {
        groupId,
        actorId: input.actorId,
        removed: removed.length,
        skipped: skipped.length,
      });
      return { keywords, added: [], removed, skipped, message };
    },

    resetRuleFields: async (input) => {
      const groupId = requireRuleTarget(input.actorId, input.groupId);
      const known = new Set(Object.keys(RULE_FIELD_LABELS));
      const unknown = input.fields.filter((field) => !known.has(field));
      if (unknown.length > 0) {
        throw badRequest(`未知规则字段：${unknown.join(", ")}`);
      }
      deps.configStore.clearFields(
        groupId,
        input.fields as Array<keyof GroupConfigOverride>,
      );
      const overriddenFields = [...deps.configStore.overriddenFields(groupId)].sort();
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:rule_reset",
        status: AuditStatus.Executed,
        reason: `恢复继承（字段）：${input.fields.join(",")}`,
      });
      log.info("admin api reset rule fields", {
        groupId,
        actorId: input.actorId,
        fields: input.fields,
      });
      return {
        groupId,
        scope: "fields",
        fields: [...input.fields],
        overriddenFields,
        message: `已恢复 ${input.fields.length} 个字段的继承（这些字段回落到全局默认）。`,
      };
    },

    resetRuleGroup: async (input) => {
      const groupId = requireRuleTarget(input.actorId, input.groupId);
      deps.configStore.removeOverride(groupId);
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:rule_reset",
        status: AuditStatus.Executed,
        reason: "恢复继承（整群重置）",
      });
      log.warn("admin api reset rule group", {
        groupId,
        actorId: input.actorId,
      });
      return {
        groupId,
        scope: "all",
        fields: [],
        overriddenFields: [],
        message:
          groupId === DEFAULT_GROUP_ID
            ? "全局规则已恢复种子默认（所有字段）。"
            : "本群全部覆盖已清空，所有字段回落到全局默认。",
      };
    },

    // -------------------------------------------------------------- 活动（P2）

    createActivity: async (input) => {
      const groupId = input.groupId.trim();
      requireGroupAdmin(input.actorId, groupId, "新建活动");
      let created;
      try {
        created = deps.activity.createActivity({
          groupId,
          title: input.title,
          createdBy: input.actorId,
        });
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
      }
      appendAudit({
        groupId,
        actorId: input.actorId,
        action: "admin_api:activity_create",
        status: AuditStatus.Executed,
        reason: `活动 ${activityLabel(created)}「${created.title}」（草稿）`,
      });
      log.info("admin api created activity", {
        activityId: created.activityId,
        groupId,
        actorId: input.actorId,
      });
      return {
        activity: activityItem(created.activityId),
        // 与指令层一致：创建活动自动绑定创建群，这里如实回读绑定集合。
        boundGroups: deps.activity
          .listBoundGroups(created.activityId)
          .map((groupId) => entities.group(groupId)),
        message: `已新建活动草稿 ${activityLabel(created)}「${created.title}」。默认只绑定创建群；需要发到别的群请再绑定，点「开放报名」才会广播。`,
      };
    },

    updateActivity: async (input) => {
      const activity = requireActivity(input.code);
      requireGroupAdmin(input.actorId, activity.groupId, "修改活动信息");
      const apply = deps.updateActivitySetting;
      if (!apply) {
        throw unavailable("改活动字段需要机器人进程内的管理监听口（只读巡检模式不提供）。");
      }
      const field = input.field.trim();
      const info = activitySettingField(field);
      if (!info) {
        throw badRequest(ACTIVITY_SET_USAGE);
      }
      const before = describeActivitySetting(activity, info.field);
      const result = await apply(activity.activityId, field, input.value);
      if (!result.ok) {
        // 与 `PUT /api/rules` 同口径：值不合法不落库、不写审计，中文原因原样给界面。
        throw badRequest(result.text);
      }
      const title = describeActivitySetting(activity, "title");
      const after = describeActivitySetting(
        deps.activity.getActivity(activity.activityId),
        info.field,
      );
      appendAudit({
        groupId: activity.groupId,
        actorId: input.actorId,
        action: "admin_api:activity_update",
        status: AuditStatus.Executed,
        reason: `活动 ${activityLabel(activity)}「${title}」${info.label}：${before} → ${after}`,
      });
      log.info("admin api updated activity", {
        activityId: activity.activityId,
        groupId: activity.groupId,
        field: info.field,
        actorId: input.actorId,
      });
      return {
        activity: activityItem(activity.activityId),
        field,
        fieldLabel: info.label,
        before,
        after,
        message: result.text,
      };
    },

    bindActivityGroup: async (input) => {
      const activity = requireActivity(input.code);
      requireGroupAdmin(input.actorId, activity.groupId, "绑定活动发布群");
      const added = deps.activity.bindGroup(activity.activityId, input.groupId);
      const boundGroups = deps.activity
        .listBoundGroups(activity.activityId)
        .map((groupId) => entities.group(groupId));
      appendAudit({
        groupId: activity.groupId,
        actorId: input.actorId,
        action: "admin_api:activity_bind",
        status: AuditStatus.Executed,
        reason: `活动 ${activityLabel(activity)} 绑定发布群 ${input.groupId}${added ? "" : "（已绑定过）"}`,
      });
      log.info("admin api bound activity group", {
        activityId: activity.activityId,
        bound: input.groupId,
        actorId: input.actorId,
        added,
      });
      return {
        activity: activityItem(activity.activityId),
        boundGroups,
        message: added
          ? `已把 ${activityLabel(activity)} 绑定到该群：开放报名时会往它发卡。`
          : "这个群之前就已经绑定了，无需重复绑定。",
      };
    },

    unbindActivityGroup: async (input) => {
      const activity = requireActivity(input.code);
      requireGroupAdmin(input.actorId, activity.groupId, "解绑活动发布群");
      const removed = deps.activity.unbindGroup(
        activity.activityId,
        input.groupId,
      );
      const boundGroups = deps.activity
        .listBoundGroups(activity.activityId)
        .map((groupId) => entities.group(groupId));
      appendAudit({
        groupId: activity.groupId,
        actorId: input.actorId,
        action: "admin_api:activity_unbind",
        status: removed ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: removed
          ? `活动 ${activityLabel(activity)} 解绑发布群 ${input.groupId}`
          : `活动 ${activityLabel(activity)} 本来就没绑这个群：${input.groupId}`,
      });
      return {
        activity: activityItem(activity.activityId),
        boundGroups,
        message: removed
          ? "已解绑：之后再开放报名不会往那个群发卡。"
          : "这个群本来就没绑定，无需解绑。",
      };
    },

    // ---------------------------------------------------------- 别名表（240）

    setAlias: async (input) => {
      requireGlobalSuperAdmin(input.actorId, "维护别名表");
      const service = requireClassAliases();
      let saved;
      try {
        saved = service.set(input.alias, input.target);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
      }
      appendAudit({
        groupId: "",
        actorId: input.actorId,
        action: "admin_api:alias_set",
        status: AuditStatus.Executed,
        reason: `别名 ${saved.alias} → ${saved.target}（${saved.kind}）`,
      });
      log.info("admin api set alias", {
        alias: saved.alias,
        target: saved.target,
        actorId: input.actorId,
      });
      return {
        ok: true,
        message: `已保存别名「${saved.alias}」→「${saved.target}」（${aliasKindLabel(saved.kind)}）。`,
        aliases: aliasItems(),
      };
    },

    removeAlias: async (input) => {
      requireGlobalSuperAdmin(input.actorId, "维护别名表");
      const service = requireClassAliases();
      const removed = service.remove(input.alias);
      appendAudit({
        groupId: "",
        actorId: input.actorId,
        action: "admin_api:alias_remove",
        status: removed ? AuditStatus.Executed : AuditStatus.Rejected,
        reason: removed ? `删除别名 ${input.alias}` : `别名不存在：${input.alias}`,
      });
      return {
        ok: removed,
        message: removed
          ? `已删除别名「${input.alias}」。`
          : `别名表里没有「${input.alias}」。`,
        aliases: aliasItems(),
      };
    },
  };
}

/** 处罚动作成功后写进申诉备注的话术（与指令层逐条一致）。 */
const PUNISH_ACTION_NOTES: Record<
  "release" | "mute" | "kick" | "blacklist",
  string
> = {
  release: "已解除处罚",
  mute: "已调整禁言时长",
  kick: "已移出群",
  blacklist: "已拉黑",
};

/**
 * 话题订阅计数（`/api/notify/topics`）。
 *
 * 与只读巡检模式共用同一份实现，避免两处口径漂移；计数口径：`<话题>:__all__`
 * 记一行「全部群」，其余同前缀行按群计数。
 */
export function buildNotifyTopicViews(
  rows: readonly { userId: string; scope: string }[],
  /** 当前生效门槛（`NotificationService.topicLevel`）；不传就只回默认值。 */
  levelOf?: ((topic: NotifyChannel) => number) | undefined,
): AdminApiNotifyTopic[] {
  return Object.entries(NOTIFY_TOPIC_META).map(([topic, meta]) => {
    const prefix = `${topic}:`;
    let allScope = 0;
    let groupScopes = 0;
    for (const row of rows) {
      if (!row.scope.startsWith(prefix)) {
        continue;
      }
      if (row.scope === `${prefix}__all__`) {
        allScope += 1;
      } else {
        groupScopes += 1;
      }
    }
    return {
      topic,
      label: meta.label,
      hint: meta.hint,
      defaultLevel: meta.defaultLevel,
      level: levelOf ? levelOf(topic as NotifyChannel) : meta.defaultLevel,
      allScope,
      groupScopes,
    };
  });
}

/**
 * 未用登录令牌 → 按成员聚合的列表（`/api/tokens`；机器人进程与只读巡检共用同一份口径）。
 *
 * 为什么按成员聚合而不是一张一张列：**不暴露任何哈希/凭据**（库里只有 `sha256(明文)`，
 * 那是凭证材料，不出进程）—— 所以没有「单张的列表 id」；而「发错人」的语义正好是把
 * 那个人手上的链接一起作废。同一个人多张时给「张数 + 最早签发 + 最晚到期」。
 * 排序按**最晚到期**升序（最快失效的在最前）。
 */
export function aggregateActiveAdminTokens(
  rows: readonly ActiveAdminToken[],
  entities: AdminApiEntities,
): { total: number; items: AdminApiTokenItem[] } {
  const byUser = new Map<
    string,
    { count: number; createdAt: Date; expiresAt: Date }
  >();
  for (const row of rows) {
    const current = byUser.get(row.userId);
    if (!current) {
      byUser.set(row.userId, {
        count: 1,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
      continue;
    }
    current.count += 1;
    if (row.createdAt.getTime() < current.createdAt.getTime()) {
      current.createdAt = row.createdAt;
    }
    if (row.expiresAt.getTime() > current.expiresAt.getTime()) {
      current.expiresAt = row.expiresAt;
    }
  }
  const items = [...byUser.entries()].map(([userId, aggregate]) => ({
    userId,
    user: entities.user(userId),
    count: aggregate.count,
    createdAt: aggregate.createdAt.toISOString(),
    expiresAt: aggregate.expiresAt.toISOString(),
  }));
  items.sort((left, right) => left.expiresAt.localeCompare(right.expiresAt));
  return { total: rows.length, items };
}

/**
 * 一条定时发言 → API 形状（`/api/scheduled-announcements` 与只读巡检共用同一份换算）。
 *
 * 展示口径与其他列表一致：配置者 / 修改者出「QQ号 → 短码 → 截断 id」，长 id 留给详情；
 * 每次换算都顺带算**后五次执行时间**（`nextTimesOfCron`，与 `/announce show` 同一个函数）。
 */
export function announcementItemOf(options: {
  task: ScheduledAnnouncement;
  entities: AdminApiEntities;
  now?: Date;
}): AdminApiAnnouncementItem {
  const { task, entities } = options;
  const now = options.now ?? new Date();
  const parsed = parseCronExpression(task.cron);
  return {
    id: task.id,
    groupId: task.groupId,
    group: entities.group(task.groupId),
    cron: task.cron,
    ...(parsed.ok ? {} : { cronError: parsed.error }),
    enabled: task.enabled,
    mode: task.content.mode,
    title: task.content.title,
    text: task.content.text,
    ...(task.content.quote !== undefined ? { quote: task.content.quote } : {}),
    buttons: task.content.buttons.map((button) => ({
      label: button.label,
      command: button.command,
      reply: button.reply === true,
    })),
    reference: task.content.reference,
    nextTimes: nextTimesOfCron(task.cron, now, ANNOUNCEMENT_NEXT_TIMES).map(
      minuteKeyOf,
    ),
    ...(task.lastFiredAt !== undefined ? { lastFiredAt: task.lastFiredAt } : {}),
    createdBy: entities.user(task.createdBy),
    createdAt: task.createdAt,
    ...(task.updatedBy !== undefined
      ? { updatedBy: entities.user(task.updatedBy) }
      : {}),
    updatedAt: task.updatedAt,
  };
}

/** 定时发言列表视图：条目 + 总数 + 总开关 / 每小时上限（热配置，页面据此提示）。 */
export function announcementsViewOf(options: {
  tasks: readonly ScheduledAnnouncement[];
  entities: AdminApiEntities;
  enabled: boolean;
  hourlyLimit: number;
  now?: Date;
}): AdminApiAnnouncementsView {
  const items = options.tasks.map((task) =>
    announcementItemOf({
      task,
      entities: options.entities,
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
  );
  return {
    items,
    total: items.length,
    enabled: options.enabled,
    hourlyLimit: options.hourlyLimit,
  };
}

/** 规则值在界面上的「当前值」口径（与 `RulesView.currentValue` 一致：覆盖优先，其次生效值）。 */function ruleValueOf(view: AdminApiRulesView, field: string): unknown {
  const own = view.override?.[field];
  return own !== undefined ? own : view.effective?.[field];
}

/** 规则值的人话（数组按「、」连接；缺省「（未设置）」）。 */
function describeRuleValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "（未设置）";
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join("、");
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** 活动在审计与回执里的标签（`#活动短码`）。 */
function activityLabel(activity: { code: string }): string {
  return `#${activity.code}`;
}

/** 别名类型的展示名（与机器人 `/alias` 卡片同一套文案）。 */
function aliasKindLabel(kind: string): string {
  return CLASS_ALIAS_KIND_LABELS[kind as ClassAliasKind] ?? kind;
}

/** 关键词批量增删的人话摘要：说清「加了几个、跳过几个以及为什么跳过」。 */
function summarizeKeywordChange(
  verb: string,
  changed: readonly string[],
  skipped: readonly { word: string; reason: string }[],
  total: number,
): string {
  const parts = [`已${verb} ${changed.length} 个关键词`];
  if (skipped.length > 0) {
    parts.push(
      `跳过 ${skipped.length} 个（${skipped
        .map((item) => `${item.word}：${item.reason}`)
        .join("；")}）`,
    );
  }
  parts.push(`当前共 ${total} 条`);
  return `${parts.join("，")}。`;
}

/** 话题名是否是已知话题（与指令层同一个判据，只是这里不做类型收窄）。 */
function isNotifyChannelName(value: string): value is NotifyChannel {
  return (NOTIFY_CHANNELS as readonly string[]).includes(value);
}

/** 门槛数值的人话（与指令层 `/notify level` 的展示口径一致：`-1` = 不限）。 */
function describeNotifyLevel(level: number): string {
  if (level <= 0) {
    return "不限";
  }
  return `门槛 ${level}`;
}

/** 审计理由里的自由文本压成单行并截断（审计表不该被一坨长值撑爆）。 */
function truncate(value: string, max: number): string {
  const compact = value.split("\n").join(" ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/**
 * 处罚动作摘要（用词与指令层卡片一致：`messageGuard.ts` 的 `punishLabel`）。
 *
 * 顺序固定「撤回 → 禁言 → 移出群 → 拉黑」，空则「仅警告」——后台表格里一眼能比。
 */
function punishmentActionsLabel(
  actions: PunishmentRecord["actions"],
): string {
  const parts: string[] = [];
  if (actions.recalled) {
    parts.push("撤回消息");
  }
  if (actions.muted) {
    parts.push(`禁言 ${actions.muteDurationSeconds} 秒`);
  }
  if (actions.kicked) {
    parts.push("移出群");
  }
  if (actions.blacklist === "global") {
    parts.push("拉黑（全局）");
  } else if (actions.blacklist === "group") {
    parts.push("拉黑（本群）");
  }
  return parts.length > 0 ? parts.join(" + ") : "仅警告";
}

/**
 * 学号脱敏：留前 4 位与后 2 位，中间打码（`2212***89`）。
 *
 * 为什么默认脱敏：审批要看的是「是不是本人 / 哪个班」，完整学号属于个人信息，
 * 名单导出那条路（`?full=1`）已经有明确门槛与审计，列表页不必再摊一份。
 */
function maskStudentId(studentId: string): string {
  const trimmed = studentId.trim();
  if (trimmed.length <= 6) {
    return "*".repeat(trimmed.length);
  }
  return `${trimmed.slice(0, 4)}${"*".repeat(trimmed.length - 6)}${trimmed.slice(-2)}`;
}
