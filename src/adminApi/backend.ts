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
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import type { NotificationDeliveryRepository } from "../db/notificationRepository.js";
import type { NotificationSubscriptionRepository } from "../db/notificationRepository.js";
import type { PunishmentRecord } from "../db/punishmentRepository.js";
import type { AppealRecord } from "../db/appealRepository.js";
import type { BlacklistEntry } from "../db/blacklistRepository.js";
import type { NotificationDelivery } from "../db/notificationRepository.js";
import type { WriteQueue } from "../db/writeQueue.js";
import type { ActivityService } from "../services/activity.js";
import type { ActivityExportService } from "../services/activityExport.js";
import type { AppealService } from "../services/appeals.js";
import type { AuditLogStore } from "../services/audit.js";
import type { BlacklistService } from "../services/blacklist.js";
import { parseRuleSetting } from "../services/commands/support.js";
import {
  DIST_BROKEN_DIR,
  readRollbackNotice,
} from "../services/distSnapshot.js";
import type { ExportService } from "../services/export.js";
import { DEFAULT_GROUP_ID, type GroupConfigStore } from "../services/groupConfig.js";
import type { HealthRegistry } from "../services/health.js";
import type { JoinApprovalService } from "../services/joinApproval.js";
import type { JoinAuditService, JoinRequest } from "../services/joinAudit.js";
import type { JoinRequestSyncService } from "../services/joinAuditSync.js";
import type { MigrationResult } from "../db/migrate.js";
import type { ModerationNotifier } from "../services/moderationNotifier.js";
import type { NotifyTopicLevelStore } from "../services/notifyTopics.js";
import type { NotifyChannel } from "../services/notifyTopics.js";
import type { NotificationService } from "../services/notifications.js";
import {
  NOTIFY_CHANNELS,
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
} from "./entityRef.js";
import { buildSettingsView, toSettingItem } from "./settings.js";
import {
  describePermissions,
  type AdminApiPermissionsView,
} from "./permissions.js";
import type {
  AdminApiActivityItem,
  AdminApiAppealItem,
  AdminApiAuditRecord,
  AdminApiBlacklistEntry,
  AdminApiDeliveryItem,
  AdminApiDeniedInput,
  AdminApiHealthView,
  AdminApiNotifyTopic,
  AdminApiNotifyLevelResult,
  AdminApiNotifyTestResult,
  AdminApiPendingItem,
  AdminApiProfileSummary,
  AdminApiPunishmentItem,
  AdminApiReaders,
  AdminApiRulesView,
  AdminApiStatusExtra,
  AdminApiSettingsView,
  AdminApiTasksView,
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
  /** 登录令牌仓储（`/api/status` 的 `activeTokens`）；内存模式为 undefined。 */
  adminTokens?: AdminTokenRepository | undefined;
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
  /** 审计导出（`/api/audit/export.csv`，与指令层 `/export audit` 同一实现）。 */
  exportService?: ExportService | undefined;
}

/** 读 + 写：真实服务图上的管理 API 后端。 */
export interface AdminApiBackend extends AdminApiReaders, AdminApiWriters {
  status(): Promise<AdminApiStatusExtra>;
  audit(): Promise<AdminApiAuditRecord[]>;
  permissionsOf(userId: string): Promise<AdminApiPermissionsView>;
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

    rules: async (groupId: string): Promise<AdminApiRulesView> => {
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
    },

    notifyTopics: notifyTopicViews,

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
      // 群集合 = 有授权行的群 ∪ 有规则覆盖的群；与只读巡检模式口径一致
      // （后者额外从 `group_configs` 取，这里内存态 `configStore` 就是同一批群的权威来源）
      const groupIds = new Set<string>([
        ...deps.permissions.listModeratedGroups(userId),
        ...deps.configStore.listOverrideSummaries().map((row) => row.groupId),
      ]);
      return describePermissions(deps.permissions, userId, [...groupIds], entities);
    },

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

    updateRule: async (rawGroupId, field, value, actorId) => {
      const groupId = rawGroupId.trim();
      if (groupId.length === 0) {
        throw badRequest("缺少 group（群 ID / #群短码 / 全局用 __default__）。");
      }
      const trimmedField = field.trim();
      if (trimmedField.length === 0) {
        throw badRequest("缺少 field（规则字段名）。");
      }
      // 与指令层 `canManageRules` 同口径：全局规则只有平台超管能改
      if (groupId === DEFAULT_GROUP_ID) {
        requireGlobalSuperAdmin(actorId, "修改全局规则");
      } else {
        requireGroupAdmin(actorId, groupId, "修改群规则");
      }
      let override;
      try {
        override = parseRuleSetting(groupId, trimmedField, value, deps.configStore);
      } catch (error) {
        appendAudit({
          groupId,
          actorId,
          action: "admin_api:rule_update",
          status: AuditStatus.Rejected,
          reason: `字段=${trimmedField} 解析失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        throw badRequest(
          `规则值不合法：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      deps.configStore.setOverride(override);
      const fields = Object.keys(override).filter((key) => key !== "groupId");
      appendAudit({
        groupId,
        actorId,
        action: "admin_api:rule_update",
        status: AuditStatus.Executed,
        reason: `字段=${fields.join(",")} 值=${truncate(value, 120)}`,
      });
      log.info("admin api rule updated", {
        groupId,
        actorId,
        fields: fields.join(","),
      });
      return {
        groupId,
        locale: groupId === DEFAULT_GROUP_ID ? "global" : "group",
        fields,
        message:
          groupId === DEFAULT_GROUP_ID
            ? "已更新全局规则（影响所有未单独覆盖的群）。"
            : "已更新群规则。",
      };
    },

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
