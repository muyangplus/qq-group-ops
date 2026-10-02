import { randomUUID } from "node:crypto";

import {
  AuditStatus,
  JoinRequestStatus,
  PermissionLevel,
  PlatformLevel,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import type { GroupSettingsRepository } from "../db/groupSettingsRepository.js";
import type { NotificationSubscriptionRepository } from "../db/notificationRepository.js";
import type { ActivityService } from "../services/activity.js";
import type { ActivityExportService } from "../services/activityExport.js";
import type { AuditLogStore } from "../services/audit.js";
import { parseRuleSetting } from "../services/commands/support.js";
import { DEFAULT_GROUP_ID, type GroupConfigStore } from "../services/groupConfig.js";
import type { JoinApprovalService } from "../services/joinApproval.js";
import type { JoinAuditService, JoinRequest } from "../services/joinAudit.js";
import { NOTIFY_TOPIC_META } from "../services/notifyTopics.js";
import type { PermissionService } from "../services/permissions.js";
import type { ShortCodeService } from "../services/shortCodes.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import {
  describePermissions,
  type AdminApiPermissionsView,
} from "./permissions.js";
import type {
  AdminApiActivityItem,
  AdminApiAuditRecord,
  AdminApiDeniedInput,
  AdminApiNotifyTopic,
  AdminApiPendingItem,
  AdminApiReaders,
  AdminApiRulesView,
  AdminApiStatusExtra,
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
  /** 数据库类型（`/api/status`）。 */
  database?: string | undefined;
  /** 启动期迁移问题数（`/api/status`）。 */
  migrationIssues?: number | undefined;
  now?: (() => Date) | undefined;
}

/** 读 + 写：真实服务图上的管理 API 后端。 */
export interface AdminApiBackend extends AdminApiReaders, AdminApiWriters {
  status(): Promise<AdminApiStatusExtra>;
  audit(): Promise<AdminApiAuditRecord[]>;
  permissionsOf(userId: string): Promise<AdminApiPermissionsView>;
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
  }): void => {
    deps.auditLog.append({
      recordId: randomUUID(),
      groupId: input.groupId,
      actorId: input.actorId,
      action: input.action,
      status: input.status,
      reason: input.reason,
      createdAt: now(),
    });
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
        })),

    pending: async (): Promise<AdminApiPendingItem[]> =>
      [...deps.joinAudit.listPending()]
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((request) => ({
          requestId: request.requestId,
          groupId: request.groupId,
          userId: request.userId,
          reason: request.reason,
          createdAt: request.createdAt.toISOString(),
        })),

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
        override:
          (override as unknown as Record<string, unknown> | undefined) ?? null,
        settings,
        effective: deps.configStore.get(groupId) as unknown as Record<
          string,
          unknown
        >,
      };
    },

    notifyTopics: async () =>
      buildNotifyTopicViews(
        (await deps.notificationSubscriptions?.findAll()) ?? [],
      ),

    activities: async () =>
      deps.activity.listAllActivities().map((activity) => activityItem(activity.activityId)),

    permissionsOf: async (userId: string): Promise<AdminApiPermissionsView> => {
      // 群集合 = 有授权行的群 ∪ 有规则覆盖的群；与只读巡检模式口径一致
      // （后者额外从 `group_configs` 取，这里内存态 `configStore` 就是同一批群的权威来源）
      const groupIds = new Set<string>([
        ...deps.permissions.listModeratedGroups(userId),
        ...deps.configStore.listOverrideSummaries().map((row) => row.groupId),
      ]);
      return describePermissions(deps.permissions, userId, [...groupIds]);
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
  };
}

/**
 * 话题订阅计数（`/api/notify/topics`）。
 *
 * 与只读巡检模式共用同一份实现，避免两处口径漂移；计数口径：`<话题>:__all__`
 * 记一行「全部群」，其余同前缀行按群计数。
 */
export function buildNotifyTopicViews(
  rows: readonly { userId: string; scope: string }[],
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
      defaultLevel: meta.defaultLevel,
      allScope,
      groupScopes,
    };
  });
}

/** 审计理由里的自由文本压成单行并截断（审计表不该被一坨长值撑爆）。 */
function truncate(value: string, max: number): string {
  const compact = value.split("\n").join(" ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}
