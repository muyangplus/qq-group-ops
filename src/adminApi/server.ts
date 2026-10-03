import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";

import { PermissionLevel, PlatformLevel } from "../core/enums.js";
import { getLogger, type Logger } from "../core/logger.js";
import type { AdminTokenRepository } from "../db/adminTokenRepository.js";
import { DEFAULT_GROUP_ID } from "../services/groupConfig.js";
import { ACTIVITY_SETTING_FIELDS } from "../services/activitySettings.js";
import { normalizeReportDays } from "./reports.js";
import type { AdminApiReportsView } from "./reports.js";
import { requiredScopeFor } from "./scopes.js";
import { filterAuditRecords, parseAuditBound } from "./auditFilters.js";
import {
  adminLoginUrl,
  machineTokenAllows,
  machineTokenUsable,
  type AdminApiConfig,
  type AdminApiMachineToken,
} from "./config.js";
import type { AdminApiEntityRef } from "./entityRef.js";
import { AdminApiRequestError } from "./errors.js";
import type {
  AdminApiSettingItem,
  AdminApiSettingsView,
} from "./settings.js";

export type { AdminApiSettingItem, AdminApiSettingsView };
export type {
  AdminApiReportActivityRow,
  AdminApiReportDailyPoint,
  AdminApiReportGroupRow,
  AdminApiReportTotals,
  AdminApiReportsView,
} from "./reports.js";
import { WindowRateLimiter } from "./rateLimit.js";
import type { AdminApiPermissionsView } from "./permissions.js";
import { SessionStore, type AdminSession } from "./session.js";
import { registerWebUi } from "./webUi.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 通过会话鉴权后挂上的会话（`preHandler` 里注入）。 */
    adminSession?: AdminSession | undefined;
    /** 通过机器令牌鉴权时挂上的 scope（E1-e）。 */
    adminMachineScopes?: readonly string[] | undefined;
    /** 通过机器令牌鉴权时的审计 actor（`machine:<前缀>`，不暴露完整令牌）。 */
    adminMachineActor?: string | undefined;
  }
}

export const ADMIN_SESSION_COOKIE = "admin_session";
/** 兑换端点按 IP 的限流（防探测；比会话限流更严）。 */
export const TOKEN_EXCHANGE_PER_MINUTE = 10;

export interface AdminApiServerOptions {
  config: AdminApiConfig;
  tokens: AdminTokenRepository;
  sessions?: SessionStore | undefined;
  limiter?: WindowRateLimiter | undefined;
  exchangeLimiter?: WindowRateLimiter | undefined;
  now?: (() => Date) | undefined;
  logger?: Logger | undefined;
  version?: string | undefined;
  uptimeMs?: (() => number) | undefined;
  /**
   * 只读状态来源（E1-c）：数据库类型与启动期迁移问题数由入口注入；
   * 会话数等本进程信息由 server 自己补。
   */
  statusProvider?: (() => Promise<AdminApiStatusExtra> | AdminApiStatusExtra) | undefined;
  /**
   * 周期任务监测（`/api/tasks`，平台级只读）：统一扫描周期 + 每个任务的上次/下次执行。
   *
   * 只读巡检模式（`pnpm admin:api`）没有调度器，不装配 → 该端点回 503 并说明原因。
   */
  tasksProvider?: (() => AdminApiTasksView | undefined) | undefined;
  /**
   * 配置视图（`/api/settings`）：可改的热改项 + `.env` 只读项（密钥类不回传值）。
   *
   * 只读巡检进程没有内存态配置存储，不装配 → 该端点回 503。
   */
  settingsProvider?: (() => AdminApiSettingsView | undefined) | undefined;
  /** 审计记录读取器（E1-c `/api/audit`）；未装配时该端点回 503。 */
  auditReader?: AdminApiAuditReader | undefined;
  /** 只读数据源（E1-c）：待审批与规则覆盖。未装配时对应端点回 503。 */
  readers?: AdminApiReaders | undefined;
  /**
   * 管理前台静态资源目录（E2-e）：给了就由本服务托管 `web/dist`（`/`、`/login` 等页面），
   * 目录不存在时自动跳过；留空/不传则完全交给 nginx 等外部托管。
   */
  webRoot?: string | undefined;
  /**
   * 写端点（E1-d）：审批 / 规则 / 活动状态 / 名单导出。未装配时对应端点回 503。
   *
   * 只有机器人进程内的回环监听口会装配它；`pnpm admin:api` 只读巡检模式不装配。
   */
  writers?: AdminApiWriters | undefined;
  /** 权限画像（E2-d）：给 `/auth/me` 附带，前端据此隐藏入口（服务端仍强校验）。 */
  permissionsOf?: ((userId: string) => Promise<AdminApiPermissionsView>) | undefined;
  /**
   * 登录账号的**展示信息**（E2-f）：给 `/auth/me` 附带 `user`（`AdminApiEntityRef`），
   * 顶栏因此能显示「QQ号 → 短码 → 完整 openid」而不是把 32 位 openid 摊在页头。
   *
   * 未装配时前端退回 `userId` 原文（与其它展示点的兜底一致）。
   */
  userRefOf?:
    | ((userId: string) => Promise<AdminApiEntityRef | undefined> | AdminApiEntityRef | undefined)
    | undefined;
  /**
   * 只读端点的门槛（E1-g）：取该账号的只读范围。未装配时按「已登录管理员」全量放行
   * （只读巡检模式与单元测试走这条路），装配后每个只读端点都按下面的口径裁剪或 403。
   */
  readAccessOf?: ((userId: string) => Promise<AdminApiReadAccess>) | undefined;
  /** 只读权限被拒时写审计（E1-b 第 9 条）；未装配时只留日志。 */
  auditDenied?: ((input: AdminApiDeniedInput) => void) | undefined;
}

/** 只读范围：平台档 + 各群的生效档位（`describePermissions` 的输出形状）。 */
export interface AdminApiReadAccess {
  platformLevel: number;
  groups: Array<{ groupId: string; level: number }>;
}

/** 周期任务监测里的一个任务（`/api/tasks`）。 */
export interface AdminApiTaskItem {
  name: string;
  /** 自己的工作间隔（毫秒）；`0` = 每轮都跑。 */
  minIntervalMs: number;
  /** 启动时那一次是否也跑（`false` = 等一个周期才上场）。 */
  runOnStart: boolean;
  /** 依赖模块是否可用；`false` = 这一轮会被整轮跳过（降级闸门）。 */
  enabled: boolean;
  /** 上次执行时刻（ISO）；从没跑过缺省。 */
  lastRunAt?: string | undefined;
  /** 下次最早可能执行的时刻（ISO）；调度器停着时缺省。 */
  nextRunAt?: string | undefined;
}

/** 周期任务监测视图（`/api/tasks`）：统一节拍 + 全部任务 + 部署监测的待重启状态。 */
export interface AdminApiTasksView {
  /** 统一扫描周期（毫秒）；`0` = 所有周期任务都停着。 */
  intervalMs: number;
  /** 定时器是否在跑。 */
  started: boolean;
  tasks: AdminApiTaskItem[];
  /** 待生效的部署（发现新版本、宽限期内）；没有就不带这个字段。 */
  deploy?:
    | {
        targetVersion: string;
        currentVersion: string;
        detectedAt: string;
        deadlineAt: string;
      }
    | undefined;
}

/** 权限拒绝的审计输入（只读端点与写端点共用一种形状）。 */
export interface AdminApiDeniedInput {
  actorId: string;
  /** 路由模板，例如 `GET /api/audit`。 */
  route: string;
  reason: string;
  /** 相关群；平台级动作为空串。 */
  groupId: string;
}

/** 处罚记录（`/api/punishments`，P1 只读）：与指令层 `/punish list` 同一份数据。 */
export interface AdminApiPunishmentItem {
  /** 内部 id。 */
  recordId: string;
  /** 短码（含 `#`）：指令层说的「处罚短码」就是它。 */
  code: string;
  groupId: string;
  group: AdminApiEntityRef;
  /** 被处罚人 openid；展示用 `target`。 */
  userId: string;
  target: AdminApiEntityRef;
  /** 执行者：`bot` / `bot:auto` / 审核员 userId；展示用 `actor`。 */
  actorId: string;
  actor: AdminApiEntityRef;
  /** 来源：`keyword` / `manual` / `card`。 */
  source: string;
  ruleReason: string;
  /** 触发消息原文（已压成单行并截断）；空串 = 未保留原文。 */
  messageExcerpt: string;
  /** 动作摘要（人看的）：`撤回+禁言 600 秒`、`警告` … */
  actions: string;
  /** 各动作执行结果（`recall+mute+warn`、`mute_failed` …）。 */
  detail: string;
  status: "active" | "released";
  createdAt: string;
  updatedAt: string;
}

/** 黑名单条目（`/api/blacklist`，P1 只读）。 */
export interface AdminApiBlacklistEntry {
  scope: "group" | "global";
  /** `scope=global` 时为空串。 */
  groupId: string;
  /** `scope=global` 时不带。 */
  group?: AdminApiEntityRef | undefined;
  userId: string;
  user: AdminApiEntityRef;
  reason: string;
  actorId: string;
  actor: AdminApiEntityRef;
  /** `manual` / `keyword` / `card`。 */
  source: string;
  createdAt: string;
}

/** 黑名单视图：本群一组、全局一组（非平台超管看不到全局那组）。 */
export interface AdminApiBlacklistView {
  groupId: string;
  group: AdminApiEntityRef;
  entries: AdminApiBlacklistEntry[];
  globalEntries: AdminApiBlacklistEntry[];
  /** `false` = 没给全局列表（权限不够），界面要说明而不是显示成「全局没人」。 */
  globalVisible: boolean;
}

/** 申诉记录（`/api/appeals`，P1 只读）。 */
export interface AdminApiAppealItem {
  appealId: string;
  /** 申诉短码（含 `#`）。 */
  code: string;
  /** 关联处罚的内部 id 与短码。 */
  punishmentId: string;
  punishmentCode: string;
  groupId: string;
  group: AdminApiEntityRef;
  /** 申诉人（被处罚人）openid；展示用 `appellant`。 */
  userId: string;
  appellant: AdminApiEntityRef;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  /** 处理人；未处理为空串。 */
  reviewerId: string;
  reviewer?: AdminApiEntityRef | undefined;
  note: string;
  createdAt: string;
  reviewedAt?: string | undefined;
  /** 仅 `pending` 有意义：距离超时转派还有多少分钟（负数 = 已超时）。 */
  holdRemainingMinutes?: number | undefined;
  overdue: boolean;
}

export interface AdminApiAppealsView {
  items: AdminApiAppealItem[];
  /** 申诉超时转派的时限（`APPEAL_HOLD_MINUTES`）。 */
  holdMinutes: number;
  pendingCount: number;
}

/** 申请人资料摘要（`/api/pending` 每项附带；学号默认脱敏）。 */
export interface AdminApiProfileSummary {
  name: string;
  /** 脱敏后的学号（中间几位用 `*`）。 */
  studentId: string;
  className: string;
  college: string;
  year: string;
}

/** 入群申请同步结果（`POST /api/join/sync`）。 */
export interface AdminApiJoinSyncResult {
  groupId: string;
  group: AdminApiEntityRef;
  /** 官方返回的申请条数。 */
  fetched: number;
  /** 同步后本群待审批条数。 */
  pending: number;
  message: string;
}

/** 通知投递记录的一条（`/api/notify/deliveries`，P1 只读）。 */
export interface AdminApiDeliveryItem {
  groupId: string;
  group: AdminApiEntityRef;
  /** 通知请求 id（一次通知一行）。 */
  requestId: string;
  /** 收件人 openid；展示用 `recipient`。 */
  userId: string;
  recipient: AdminApiEntityRef;
  status: string;
  /** 降级 / 失败说明（`text_fallback` 或错误信息）。 */
  detail: string;
  createdAt: string;
}

export interface AdminApiDeliveriesView {
  total: number;
  page: number;
  pageSize: number;
  items: AdminApiDeliveryItem[];
  /** 按状态汇总（一眼看「失败多少」）。 */
  counts: Array<{ status: string; count: number }>;
}

/** 运维只读（`/api/health`，P1）：把 `/status proc` 的内容接进后台。 */export interface AdminApiHealthView {
  process: {
    /** 本进程运行的版本（`runningVersionOf()`）。 */
    runningVersion: string;
    /** 磁盘上的版本（部署后可能已经更新）。 */
    diskVersion: string;
    uptimeMs: number;
    startedAt: string;
    pid: number;
    node: string;
    platform: string;
    arch: string;
    rss: number;
    heapUsed: number;
    heapTotal: number;
    /** 运行模式：`official` / `fake`。 */
    mode: string;
  };
  database: {
    driver: string;
    migrationIssues: Array<{ step: string; error: string }>;
  };
  queue: {
    pending: number;
    failures: number;
    lastError?: string | undefined;
  };
  notify: {
    subscribers: number;
    deliveries: number;
  };
  modules: Array<{
    key: string;
    label: string;
    state: string;
    error?: string | undefined;
  }>;
  /** 恢复现场：最近一次重启失败 / 回滚留下的证据（只读，文件在就报）。 */
  restart: {
    failure?:
      | { reason: string; at?: string | undefined; code?: number | undefined }
      | undefined;
    rollback?: { reason: string; at: string } | undefined;
    /** `data/dist-broken/` 是否存在（说明历史上换过一次坏构建）。 */
    brokenBuild: boolean;
  };
}

/** 「订阅关系」只读视图里的一行（`GET /api/notify/subscriptions`，平台超管 240）。 */
export interface AdminApiNotifySubscriptionItem {
  userId: string;
  user: AdminApiEntityRef;
  topic: string;
  topicLabel: string;
  /** `all` = 「我担任审核员的所有群」（`__all__`）；`group` = 某个具体群。 */
  scope: "all" | "group";
  groupId?: string | undefined;
  group?: AdminApiEntityRef | undefined;
  /**
   * 现在的角色还够不够这个门槛：**订阅了也可能收不到**
   * （判据与推送同一份：`NotificationService.checkTopicReach`）。
   */
  eligible: boolean;
  /** 不够门槛时的人话原因（例如「订阅『全部群』的活动通知需要先绑定 QQ 号」）；够的话是空串。 */
  reason: string;
}

export interface AdminApiNotifySubscriptionsView {
  items: AdminApiNotifySubscriptionItem[];
  total: number;
  /** 每个话题的订阅计数（订「全部群」的人数 / 按群的条数），与 `/api/notify/topics` 同一口径。 */
  counts: AdminApiNotifyTopic[];
}

/**
 * 降级模块「重试加载」的结果（运维写，平台超管 240）。
 *
 * 与机器人 `/status proc` 里那个「重试加载」按钮**同一个领域入口**（`HealthRegistry.retry`）：
 * 只重跑该模块的 `load()`（幂等），不动业务数据、不重启进程。
 */
export interface AdminApiModuleRetryResult {
  module: {
    key: string;
    label: string;
    state: string;
    error?: string | undefined;
  };
  /** 重试后是否恢复（`state === "ready"`）。仍失败时为 `false`，原因在 `module.error` 与 `message`。 */
  recovered: boolean;
  message: string;
}

/**
 * 处罚动作的结果（P2 写）。
 *
 * 动作本身与指令层 `/punish release|mute|kick|blacklist` 完全同源（同一个领域服务），
 * 因此**通知话术、官方调用、审计口径都一致**；这里只把结果整理成结构化响应。
 */
export interface AdminApiPunishmentActionResult {
  ok: boolean;
  /** 领域服务给的人话结果（成功摘要或失败原因）。 */
  message: string;
  punishment: AdminApiPunishmentItem;
  /** 拉黑动作：被一并移出的群数（全局拉黑会影响所有绑定群）。 */
  kickedGroups?: number | undefined;
  /** 处置即回应申诉：本次连带判定为「已通过」的申诉条数。 */
  acceptedAppeals: number;
}

/** 黑名单增删的结果（P2 写）。 */
export interface AdminApiBlacklistResult {
  action: "add" | "remove";
  ok: boolean;
  message: string;
  scope: "group" | "global";
  /** 落库的群 id；全局为 `""`。 */
  groupId: string;
  userId: string;
  /** 被移出的群数（本群 0/1，全局可能多个）。 */
  kickedGroups: number;
}

/** 申诉复核的结果（P2 写）。 */
export interface AdminApiAppealDecisionResult {
  appeal: AdminApiAppealItem;
  decision: "accepted" | "rejected";
  /** 人话摘要：通过时说明对处罚做了什么（撤销了哪几项）。 */
  message: string;
}

export interface AdminApiAuditRecord {
  recordId: string;
  /** 内部群 id（过滤器用的就是它）；展示请用 `group`。 */
  groupId: string;
  /** 操作人内部 id；展示请用 `actor`。 */
  actorId: string;
  action: string;
  status: string;
  reason: string;
  createdAt: string;
  /** 操作对象（处罚 / 审批的目标）；平台级动作没有。 */
  targetUserId?: string | undefined;
  group: AdminApiEntityRef;
  actor: AdminApiEntityRef;
  target?: AdminApiEntityRef | undefined;
}

/** 审计数据源：入口用仓储实现（`persistence.audit.findAll()`）。 */
export interface AdminApiAuditReader {
  list(): Promise<AdminApiAuditRecord[]>;
}

/** 待审批申请（`/api/pending`）。 */
export interface AdminApiPendingItem {
  requestId: string;
  /** 内部群 id（过滤器用的就是它）；展示请用 `group`。 */
  groupId: string;
  /** 申请人内部 openid；展示请用 `applicant`。 */
  userId: string;
  reason: string;
  createdAt: string;
  group: AdminApiEntityRef;
  applicant: AdminApiEntityRef;
  /** 申请短码（`#XXXXXX`）：一律有（申请卡发送时就分配了）。 */
  request: AdminApiEntityRef;
}

/** 某个群的规则覆盖（`/api/rules`）：原始覆盖行，合并生效值的逻辑在机器人侧。 */
export interface AdminApiRulesView {
  groupId: string;
  /** 群展示信息（群号 → 短码 → 截断 id）；全局默认群的 `officialId` 是 `__default__`。 */
  group: AdminApiEntityRef;
  /** `group_configs` + `group_settings` 合并出的**覆盖字段**（没有覆盖时为 null）。 */
  override: Record<string, unknown> | null;
  /** `group_settings` 的键值覆盖（关键词等扩展字段）。 */
  settings: Array<{ key: string; value: string }>;
  /**
   * 合并全局默认后的**生效配置**（只读巡检模式不提供：它没有内存态服务）。
   *
   * 写端点校验「我改的到底生效成什么」要靠它；缺省时前端只展示覆盖字段。
   */
  effective?: Record<string, unknown> | undefined;
}

export interface AdminApiReaders {
  pending(): Promise<AdminApiPendingItem[]>;
  rules(groupId: string): Promise<AdminApiRulesView>;
  /** 通知话题：默认门槛 + 订阅人数（订「全部群」与按群订阅分开）。 */
  notifyTopics(): Promise<AdminApiNotifyTopic[]>;
  /** 活动列表（含报名人数；群卡片广播目标在机器人侧管理）。 */
  activities(): Promise<AdminApiActivityItem[]>;
  /**
   * P1 只读补齐（未装配时对应端点回 503；只读巡检模式下部分实现）。
   *
   * 口径统一：**平台超管不传 `group` 看全量，其余人必须带 `group` 且按本群档位判**。
   */
  punishments?:
    | ((options: {
        group?: string | undefined;
        status?: string | undefined;
      }) => Promise<AdminApiPunishmentItem[]>)
    | undefined;
  blacklist?:
    | ((groupId: string, options: { includeGlobal: boolean }) => Promise<AdminApiBlacklistView>)
    | undefined;
  appeals?:
    | ((options: {
        group?: string | undefined;
        status?: string | undefined;
      }) => Promise<AdminApiAppealsView>)
    | undefined;
  deliveries?:
    | ((options: {
        group?: string | undefined;
        status?: string | undefined;
      }) => Promise<AdminApiDeliveryItem[]>)
    | undefined;
  /**
   * 订阅关系只读（`GET /api/notify/subscriptions`，平台超管 240）：
   * 谁订了哪些话题、订的是哪个范围、**现在的角色还够不够门槛**。
   *
   * 订阅是个人偏好，这里只读；服务端回全量再由 HTTP 层分页。
   */
  notifySubscriptions?:
    | ((options: {
        topic?: string | undefined;
        group?: string | undefined;
        userId?: string | undefined;
        ineligibleOnly?: boolean | undefined;
      }) => Promise<AdminApiNotifySubscriptionsView>)
    | undefined;
  /** 运维只读（`/api/health`）：只读巡检模式没有进程内状态，不装配。 */
  health?: (() => Promise<AdminApiHealthView>) | undefined;
  /** 别名表（`/api/aliases`，平台超管 240）。 */
  aliases?: (() => Promise<AdminApiAliasItem[]>) | undefined;
  /** 统计报表（E5）：按天/按群聚合，只读巡检模式没有内存态，不装配 → 503。 */
  reports?:
    | ((options: {
        group?: string | undefined;
        days: number;
      }) => Promise<AdminApiReportsView>)
    | undefined;
  /** 权限授权总览（`GET /api/permissions`，平台超管 240）。 */
  permissions?:
    | ((options: {
        group?: string | undefined;
      }) => Promise<AdminApiPermissionGrantsView>)
    | undefined;
  /** 身份映射只读（`GET /api/identities`，平台超管 240）。 */
  identities?: (() => Promise<AdminApiIdentitiesView>) | undefined;
}

/** 通过 / 拒绝入群申请后的回执。 */
export interface AdminApiJoinDecision {
  requestId: string;
  groupId: string;
  status: string;
  message: string;
}

/** 规则写回执。 */
export interface AdminApiRuleUpdateResult {
  groupId: string;
  /** `global` = 写的是全局默认规则（`__default__`）。 */
  locale: "global" | "group";
  fields: string[];
  message: string;
}

/** 活动状态变更回执。 */
export interface AdminApiActivityResult {
  activityId: string;
  code: string;
  groupId: string;
  status: string;
  message: string;
}

/** 活动名单 CSV。 */
export interface AdminApiCsvExport {
  filename: string;
  csv: string;
  rows: number;
  /** 是否含学号 / 班级 / 学院等隐私列。 */
  full: boolean;
}

/** 活动状态写动作。 */
export type AdminApiActivityAction = "open" | "close" | "cancel";

/**
 * 写端点（E1-d）。
 *
 * HTTP 层只做「取参数 → 调 writer → 序列化」，权限判据、领域服务调用与审计都在
 * writer 里（见 `backend.ts`）：这条边界让 HTTP 层不必重复实现业务规则，
 * 也让「只读巡检模式」（不装 writers）天然写不了任何东西。
 */
export interface AdminApiWriters {
  approveJoin(requestId: string, actorId: string): Promise<AdminApiJoinDecision>;
  rejectJoin(
    requestId: string,
    actorId: string,
    reason: string,
  ): Promise<AdminApiJoinDecision>;
  updateRule(
    groupId: string,
    field: string,
    value: string,
    actorId: string,
  ): Promise<AdminApiRuleUpdateResult>;
  setActivityStatus(
    code: string,
    action: AdminApiActivityAction,
    actorId: string,
  ): Promise<AdminApiActivityResult>;
  exportActivityCsv(
    code: string,
    actorId: string,
    options: { full: boolean },
  ): Promise<AdminApiCsvExport>;
  /**
   * 改一项**热改配置**（平台级，240）。
   *
   * 走的仍然是机器人 `/config` 那一套（`PlatformSettingsStore.set`：校验 → 落库 → 立即生效），
   * 管理 API 只是把它搬到网页上；密钥类 `.env` 项不在可改范围内（只读展示）。
   */
  updateSetting(
    key: string,
    value: string,
    actorId: string,
  ): Promise<AdminApiSettingItem>;
  /**
   * 把一项热改配置恢复成 `.env` 默认值（只有确实覆盖过才动库）。
   */
  clearSetting(key: string, actorId: string): Promise<AdminApiSettingItem>;
  /**
   * 同步官方入群申请队列（与指令层 `/sync` 同一服务）。
   *
   * 门槛与 `/sync` 一致：**本群审核员 120**（不是 130）—— 它只把官方队列拉下来写进待审批，
   * 不改变任何人的状态，所以比审批本身低一档。
   */
  syncJoinRequests(groupId: string, actorId: string): Promise<AdminApiJoinSyncResult>;
  /** 导出审计记录 CSV（与 `/export audit` 同口径：本群 130；平台 240 可导出全量）。 */
  exportAuditCsv(
    actorId: string,
    options: { group?: string | undefined; full: boolean },
  ): Promise<AdminApiCsvExport>;
  /**
   * 重试加载一个降级模块（平台超管 240；幂等，只重跑该模块的 `load()`）。
   *
   * 与机器人 `/status proc` 的「重试加载」同一入口 —— 修好数据 / 环境后不用重启进程。
   * 只读巡检模式没有健康注册表，writer 抛 `unavailable`。
   */
  retryModule(key: string, actorId: string): Promise<AdminApiModuleRetryResult>;

  // ---------------------------------------------------------------- P2 写操作
  /**
   * 处罚动作（与指令层 `/punish release|mute|kick|blacklist` 同一服务、同一门槛 120）。
   *
   * 成功后**连带把该处罚下待处理的申诉标为已通过**（与指令层一致：处置即回应申诉）；
   * `scope=global` 的拉黑要平台超管 240。
   */
  punish(input: {
    code: string;
    action: "release" | "mute" | "kick" | "blacklist";
    actorId: string;
    note?: string | undefined;
    seconds?: number | undefined;
    scope?: "group" | "global" | undefined;
    reason?: string | undefined;
  }): Promise<AdminApiPunishmentActionResult>;
  /** 加入黑名单（本群 120 / 全局 240）；默认同时把人移出群（与 `/blacklist add` 一致）。 */
  addBlacklist(input: {
    scope: "group" | "global";
    groupId?: string | undefined;
    userId: string;
    actorId: string;
    reason?: string | undefined;
  }): Promise<AdminApiBlacklistResult>;
  /** 解除黑名单（本群 120 / 全局 240）。 */
  removeBlacklist(input: {
    scope: "group" | "global";
    groupId?: string | undefined;
    userId: string;
    actorId: string;
  }): Promise<AdminApiBlacklistResult>;
  /**
   * 申诉复核（本群 120）。
   *
   * **通过 = 撤销该处罚**（`PunishmentService.release`，逐项撤销：禁言解除 / 拉黑解除等，
   * 撤回与踢出不可逆）；通过或驳回都会私信申诉人（`ModerationNotifier`，与指令层同一条通道）。
   */
  decideAppeal(input: {
    code: string;
    decision: "accepted" | "rejected";
    actorId: string;
    note?: string | undefined;
  }): Promise<AdminApiAppealDecisionResult>;
  /**
   * 改话题门槛（平台超管 240；与指令层 `/notify level <话题> <数值>` 同一份存储）。
   *
   * 门槛是**全局一套**，改一次所有群生效 —— 这是它必须 240 的原因。
   */
  setNotifyLevel(input: {
    topic: string;
    level: number;
    actorId: string;
  }): Promise<AdminApiNotifyLevelResult>;
  /** 所有话题门槛恢复默认（平台超管 240）。 */
  resetNotifyLevels(actorId: string): Promise<AdminApiNotifyLevelResult>;
  /** 给自己发一张测试卡（自助；测的是私聊推送通道，不依赖具体群）。 */
  sendNotifyTest(input: {
    userId: string;
    groupId?: string | undefined;
  }): Promise<AdminApiNotifyTestResult>;
  /**
   * 规则关键词**逐条**增删（可批量提交，逐词按指令层同一套规则校验）。
   *
   * 单个词失败（已存在 / 不存在 / 超长）**不整批失败**，而是进 `skipped` 并如实回给界面 ——
   * 批量操作里因为一个重复词整批回滚更难用。门槛同 `PUT /api/rules`：本群 130 / 全局 240。
   */
  addRuleKeywords(input: {
    groupId: string;
    words: string[];
    actorId: string;
  }): Promise<AdminApiRuleKeywordsResult>;
  removeRuleKeywords(input: {
    groupId: string;
    words: string[];
    actorId: string;
  }): Promise<AdminApiRuleKeywordsResult>;
  /**
   * 恢复继承：只清指定字段的覆盖（`clearFields`），或整群重置（`removeOverride`）。
   *
   * 与指令层「恢复本页继承 / 恢复全部继承」同一套存储方法；**不可逆**（覆盖行被清掉），
   * 界面必须二次确认。门槛同 `PUT /api/rules`。
   */
  resetRuleFields(input: {
    groupId: string;
    fields: string[];
    actorId: string;
  }): Promise<AdminApiRuleResetResult>;
  resetRuleGroup(input: {
    groupId: string;
    actorId: string;
  }): Promise<AdminApiRuleResetResult>;
  /**
   * 新建活动（本群群管理员 130）：只建**草稿**，与 `/activity create <标题>` 一致 ——
   * 绑定发布群之后再用 `open` 广播。
   */
  createActivity(input: {
    groupId: string;
    title: string;
    actorId: string;
  }): Promise<AdminApiActivityBindResult>;
  /**
   * 改活动字段（本群 130）：`field` / `value` 的写法与 `/activity set <短码> <字段> <值>`
   * **完全一致**（同一套解析），所以「名额调小到满员要广播」「改完私信已报名 / 候补者」
   * 这些连带效果也一样。
   */
  updateActivity(input: {
    code: string;
    field: string;
    value: string;
    actorId: string;
  }): Promise<AdminApiActivityUpdateResult>;
  /** 绑定 / 解绑发布群（与 `/activity bind|unbind` 同一服务方法）。 */
  bindActivityGroup(input: {
    code: string;
    groupId: string;
    actorId: string;
  }): Promise<AdminApiActivityBindResult>;
  unbindActivityGroup(input: {
    code: string;
    groupId: string;
    actorId: string;
  }): Promise<AdminApiActivityBindResult>;
  /** 维护别名表（平台超管 240；类型由服务自动判定，与 `/alias set` 一致）。 */
  setAlias(input: {
    alias: string;
    target: string;
    actorId: string;
  }): Promise<AdminApiAliasResult>;
  /** 删除别名（平台超管 240）；不存在时按「没这条」如实回。 */
  removeAlias(input: { alias: string; actorId: string }): Promise<AdminApiAliasResult>;
  /**
   * 导出统计报表 CSV（E5）：本群 130 拿**脱敏**长表（群只出展示标签），
   * `full=1`（追加内部群 ID 列）与不带 `group=` 的全量都要平台超管 240，
   * 两种都写 `admin_api:report_export` 审计（与审计导出口径一致）。
   */
  exportReportsCsv(
    actorId: string,
    options: { group?: string | undefined; days: number; full: boolean },
  ): Promise<AdminApiReportCsvResult>;
  /**
   * 授予 / 撤销角色（**平台超管 240**，与指令层 `/perm` 同一个 `PermissionService`）：
   * 这是「权限的权限」，所以门槛最高、界面必须二次确认并展示「改完谁失去了什么」。
   * 额外一条护栏：**不能撤销自己的全局超管**（改完就没权限改回来了，要让别人撤）。
   */
  setPermission(input: {
    action: "grant" | "revoke";
    role: string;
    group?: string | undefined;
    userId: string;
    actorId: string;
  }): Promise<AdminApiPermissionChangeResult>;
}

export interface AdminApiActivityItem {
  activityId: string;
  /** 活动短码（展示用）。 */
  code: string;
  title: string;
  /** 内部群 id（过滤器用的就是它）；展示请用 `group`。 */
  groupId: string;
  status: string;
  capacity?: number | undefined;
  registered: number;
  createdAt: string;
  group: AdminApiEntityRef;
  /** 已绑定的**发布 / 广播**目标群（`open` 时往这些群发卡）。 */
  boundGroups: AdminApiEntityRef[];
  /** 报名截止时间（ISO）；没设就不带。 */
  closeAt?: string | undefined;
}

/** 活动创建 / 绑定群的结果（P2 写）。 */
export interface AdminApiActivityBindResult {
  activity: AdminApiActivityItem;
  /** 变更之后仍然绑定的群（界面直接替换）。 */
  boundGroups: AdminApiEntityRef[];
  message: string;
}

/** 活动字段修改的结果（P2 写）：带回「改哪个字段、旧值 → 新值」的人话摘要。 */
export interface AdminApiActivityUpdateResult {
  activity: AdminApiActivityItem;
  /** 本次请求用的原始字段名（回执里显示的就是它）。 */
  field: string;
  /** 规范字段名 + 中文名（界面显示 / 审计用）。 */
  fieldLabel: string;
  /** 改动前的人话值。 */
  before: string;
  /** 改动后的人话值。 */
  after: string;
  message: string;
}

/** 报表 CSV 的回执（与审计导出同一形状：文件名 / 内容 / 行数 / 是否含内部 ID）。 */
export interface AdminApiReportCsvResult {
  filename: string;
  csv: string;
  rows: number;
  full: boolean;
}

/** 权限成员（一条授权指向的人；展示信息走 `AdminApiEntityRef`）。 */
export interface AdminApiPermissionMember {
  userId: string;
  user: AdminApiEntityRef;
}

/** 一个角色在某个范围内的成员（全局超管没有群）。 */
export interface AdminApiPermissionRoleList {
  role: string;
  roleLabel: string;
  members: AdminApiPermissionMember[];
}

/** 有授权（或本次查询指定）的群，用于「权限」页的群选择器。 */
export interface AdminApiPermissionGroupSummary {
  groupId: string;
  group: AdminApiEntityRef;
}

/** 一条身份映射（`GET /api/identities`，平台超管 240）。 */
export interface AdminApiIdentityItem {
  /** 内部 ID（openid / group_openid）。 */
  officialId: string;
  /** 展示信息：QQ号 / 群号（`externalId` 与它同源，另给一份方便脚本直接读）。 */
  entity: AdminApiEntityRef;
  externalId: string;
  /** 首次绑定 / 最近改绑；老库或纯内存实现没有这两列时缺省。 */
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

/** 身份映射总览（只读；`/bind user|groupid` 的**写**不搬）。 */
export interface AdminApiIdentitiesView {
  users: AdminApiIdentityItem[];
  groups: AdminApiIdentityItem[];
}

/** 权限总览（`GET /api/permissions`，平台超管 240）。 */export interface AdminApiPermissionGrantsView {
  /** 有任何群内授权的群；选了群时至少包含该群。 */
  groups: AdminApiPermissionGroupSummary[];
  /** 全局角色（当前只有 `super`）。 */
  global: AdminApiPermissionRoleList[];
  /** 选了群时的三个群内角色。 */
  group?: { group: AdminApiEntityRef; roles: AdminApiPermissionRoleList[] };
}

/** 授予 / 撤销的回执（`POST /api/permissions`，平台超管 240）。 */
export interface AdminApiPermissionChangeResult {
  action: "grant" | "revoke";
  role: string;
  roleLabel: string;
  group?: AdminApiEntityRef | undefined;
  target: AdminApiEntityRef;
  /** 是否真的改动了（重复授予 / 撤销本来就没有的授权 → `false`）。 */
  changed: boolean;
  /** 改完之后该角色在范围内的成员（界面直接替换）。 */
  members: AdminApiPermissionMember[];
  message: string;
}

export interface AdminApiNotifyTopic {
  topic: string;
  label: string;
  /** 一句话说明这个话题什么时候推（来自 `NOTIFY_TOPIC_META`，与机器人卡片同一份文案）。 */
  hint: string;
  /** 全局默认门槛（实际门槛可能被 `__default__.notifyTopicLevels` 覆盖）。 */
  defaultLevel: number;
  /** **当前生效**门槛（`/notify level` 改的就是它）。 */
  level: number;
  /** 订「全部群」的人数。 */
  allScope: number;
  /** 按具体群订阅的行数（同一人可订多个群）。 */
  groupScopes: number;
}

/** 通知话题门槛的写结果（P2 写）。 */
export interface AdminApiNotifyLevelResult {
  /** 改完之后**全部**话题的当前状态（与只读视图同一形状，界面直接整体替换）。 */
  topics: AdminApiNotifyTopic[];
  /** 人话摘要（改了哪个、从多少到多少）。 */
  message: string;
}

/** 「给自己发测试卡」的结果。 */
export interface AdminApiNotifyTestResult {
  ok: boolean;
  message: string;
}

/** 规则关键词批量增删的结果（P2 写）。 */
export interface AdminApiRuleKeywordsResult {
  /** 改完之后的**完整**关键词表（与 `/rules` 显示的是同一份：已 trim、去重、排序）。 */
  keywords: string[];
  added: string[];
  removed: string[];
  /** 被跳过的词与原因（已存在 / 不存在 / 超长 / 空）—— **不静默**，界面要如实显示。 */
  skipped: Array<{ word: string; reason: string }>;
  message: string;
}

/** 恢复继承（字段级 / 整群）的结果（P2 写）。 */
export interface AdminApiRuleResetResult {
  groupId: string;
  /** `fields` = 只清了这些字段；`all` = 整群覆盖全部重置。 */
  scope: "fields" | "all";
  fields: string[];
  /** 清完之后**仍在覆盖**的字段（界面据此刷新「覆盖中」标记）。 */
  overriddenFields: string[];
  message: string;
}

/** 别名表条目（P2 写，平台超管 240）。 */
export interface AdminApiAliasItem {
  alias: string;
  target: string;
  /** 自动判定的类型：`class` 班级 / `college` 学院 / `major` 专业。 */
  kind: string;
}

/** 别名表写操作的结果（回整表，界面直接替换）。 */
export interface AdminApiAliasResult {
  ok: boolean;
  message: string;
  aliases: AdminApiAliasItem[];
}

/** 入口能提供、server 自己算不出来的那部分状态。 */
export interface AdminApiStatusExtra {
  database: string;
  migrationIssues: number;
  /** 当前未用且未过期的登录令牌数。 */
  activeTokens?: number | undefined;
}

export interface AdminApiServer {
  app: FastifyInstance;
  sessions: SessionStore;
  limiter: WindowRateLimiter;
  /** 拼登录链接（`PUBLIC_BASE_URL` 未配置时 undefined，只给令牌）。 */
  loginUrl: (token: string) => string | undefined;
}

/**
 * 管理 API 的 HTTP 层（E1-a，认证方案 B2）。
 *
 * 公开端点只有两个：`GET /healthz` 与 `POST /auth/token`（兑换一次性令牌），
 * 其余一律要求会话 cookie；写操作额外要求 `X-Admin-Request: 1`（CSRF）。
 * 日志只记方法 / 路由 / 状态 / 耗时 / actor，**不记 cookie 与令牌**。
 */
export function buildAdminApiServer(options: AdminApiServerOptions): AdminApiServer {
  const log = options.logger ?? getLogger("admin-api");
  const config = options.config;
  const sessions =
    options.sessions ??
    new SessionStore({ secret: config.sessionSecret, ttlMs: config.sessionTtlMs });
  const limiter =
    options.limiter ??
    new WindowRateLimiter({ limitPerWindow: config.rateLimitPerMinute });
  const exchangeLimiter =
    options.exchangeLimiter ??
    new WindowRateLimiter({ limitPerWindow: TOKEN_EXCHANGE_PER_MINUTE });
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();

  const app = Fastify({
    logger: false,
    // 路由级日志由下面的 onResponse 统一打（Fastify 自带的会打全量请求体）
    disableRequestLogging: true,
    // 反代后面才拿得到真实 IP；默认部署本来就在 127.0.0.1，trustProxy 只影响 IP 判定
    trustProxy: true,
  });

  app.addHook("onResponse", async (request, reply) => {
    log.info("admin api request", {
      method: request.method,
      route: (request.routeOptions?.url ?? request.url).split("?")[0],
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      actor: request.adminSession?.userId ?? null,
    });
  });

  app.get("/healthz", async () => ({
    ok: true,
    version: options.version ?? "unknown",
    uptimeMs: options.uptimeMs?.() ?? Date.now() - startedAt,
  }));

  app.post("/auth/token", async (request, reply) => {
    if (!exchangeLimiter.allow(`ip:${request.ip}`)) {
      return reply
        .code(429)
        .send(errorBody("rate_limited", "请求过于频繁，请稍后再试。"));
    }
    if (!hasCsrfHeader(request)) {
      return reply
        .code(403)
        .send(errorBody("csrf", "缺少 X-Admin-Request: 1 请求头。"));
    }
    const body = (request.body ?? {}) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    const userId = await options.tokens.redeem(token, now());
    if (!userId) {
      log.warn("admin api token rejected", { ip: request.ip });
      return reply.code(401).send(
        errorBody(
          "invalid_token",
          "令牌无效、已使用或已过期；请在机器人私信里重新用 /admin login 获取。",
        ),
      );
    }
    const { cookieValue, session } = sessions.create(userId);
    reply.header("set-cookie", sessionCookie(cookieValue, config));
    log.info("admin api login", { userId, ip: request.ip });
    return {
      userId: session.userId,
      expiresAt: new Date(session.createdAt + config.sessionTtlMs).toISOString(),
    };
  });

  app.addHook("preHandler", async (request, reply) => {
    const route = (request.routeOptions?.url ?? request.url).split("?")[0] ?? "";
    // 公开端点：健康检查与令牌兑换
    if (route === "/healthz" || route === "/auth/token") {
      return;
    }
    // 只守**我们自己的接口**。其它路径（`/`、`/login`、静态资源…）不是管理 API 的职责：
    // 以前这里一律 401「请先登录」，结果是「把 /login 反代到 8787」这种配错
    // 在浏览器里表现为「登录页要求先登录」，极难排查。现在直接落到 404 处理器。
    if (!isAdminApiRoute(route)) {
      return;
    }
    const session = sessions.touch(
      readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE),
    );
    if (!session) {
      // 没有会话 cookie：试机器令牌（E1-e）——`Authorization: Bearer <token>`
      const bearer = readBearerToken(request.headers.authorization);
      const machine = bearer === undefined
        ? undefined
        : findMachineToken(config.machineTokens, bearer, now());
      if (!machine) {
        return reply.code(401).send(
          errorBody("unauthorized", "请先登录：在机器人私信里发送 /admin login。"),
        );
      }
      // 按端点要求的 scope 判定（细粒度，见 scopes.ts）：每个端点声明自己的域，
      // 没登记的端点回落到 read / write —— 细粒度 token 因此访问不了没登记的端点（fail-closed）。
      const requiredScope = requiredScopeFor(request.method, route);
      if (!machineTokenAllows(machine, requiredScope, now())) {
        log.warn("admin api machine token scope denied", {
          scope: requiredScope,
          route,
        });
        return reply.code(403).send(
          errorBody(
            "forbidden",
            `这个机器令牌没有 \`${requiredScope}\` 权限（当前：${machine.scopes.join("|")}）。`,
          ),
        );
      }
      if (!limiter.allow(`token:${machine.token.slice(0, 8)}`)) {
        return reply
          .code(429)
          .send(errorBody("rate_limited", "请求过于频繁，请稍后再试。"));
      }
      request.adminMachineScopes = machine.scopes;
      // 审计 actor：机器令牌用前缀（完整令牌绝不进审计 / 日志 / 数据库）
      request.adminMachineActor = `machine:${machine.token.slice(0, 8)}`;
      // 机器令牌不涉及 cookie，因此不需要 CSRF 头
      return;
    }
    if (!limiter.allow(session.id)) {
      return reply
        .code(429)
        .send(errorBody("rate_limited", "请求过于频繁，请稍后再试。"));
    }
    if (isWriteMethod(request.method) && !hasCsrfHeader(request)) {
      return reply
        .code(403)
        .send(errorBody("csrf", "写操作必须带 X-Admin-Request: 1 请求头。"));
    }
    (request as FastifyRequest).adminSession = session;
  });

  app.get("/auth/me", async (request) => {
    const userId = request.adminSession?.userId ?? null;
    const permissions =
      userId !== null && options.permissionsOf
        ? await options.permissionsOf(userId)
        : undefined;
    // 顶栏的展示名：优先 QQ号 → 短码，完整 openid 收进「详情」（E2-f 的统一口径）
    const user =
      userId !== null && options.userRefOf
        ? await options.userRefOf(userId)
        : undefined;
    return {
      userId,
      expiresAt: new Date(
        (request.adminSession?.lastSeenAt ?? now().getTime()) + config.sessionTtlMs,
      ).toISOString(),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(user !== undefined ? { user } : {}),
    };
  });

  // ------------------------------------------------------------------ 只读端点（E1-c）
  //
  // 只读门槛（E1-g）：平台级信息要平台超管 240；群级数据按「本群档位」裁剪或拒绝
  // （审核员 120 = 能看，群管理员 130 = 能改）。机器令牌（运维自己配的服务凭据）视为
  // 平台级只读；未装配 `readAccessOf` 时全量放行（只读巡检模式与单测）。

  /** 审计 actor：会话用户；机器令牌用 `machine:<前缀>`（完整令牌不进日志 / 数据库）。 */
  const actorOf = (request: FastifyRequest): string =>
    request.adminSession?.userId ?? request.adminMachineActor ?? "unknown";

  /** 取本次请求的只读范围；`undefined` = 不限制（机器令牌 / 未装配）。 */
  const readAccessOf = async (
    request: FastifyRequest,
  ): Promise<AdminApiReadAccess | undefined> => {
    if (request.adminMachineScopes !== undefined || !options.readAccessOf) {
      return undefined;
    }
    const userId = request.adminSession?.userId;
    return userId ? await options.readAccessOf(userId) : undefined;
  };

  const levelIn = (access: AdminApiReadAccess, groupId: string): number =>
    access.groups.find((group) => group.groupId === groupId)?.level ?? 0;

  /** 平台超管（或未装配）→ 不裁剪；否则返回裁剪依据。 */
  const scopeOf = (
    access: AdminApiReadAccess | undefined,
  ): AdminApiReadAccess | undefined =>
    access && access.platformLevel < PlatformLevel.GlobalSuperAdmin
      ? access
      : undefined;

  const denyRead = (
    request: FastifyRequest,
    route: string,
    reason: string,
    groupId = "",
  ): void => {
    const actorId = actorOf(request);
    log.warn("admin api read denied", { actorId, route, reason, groupId });
    options.auditDenied?.({ actorId, route, reason, groupId });
  };

  /** 平台级只读端点：非平台超管 403（返回 false = 已回过响应）。 */
  const allowPlatformRead = async (
    request: FastifyRequest,
    reply: FastifyReply,
    route: string,
  ): Promise<boolean> => {
    const access = await readAccessOf(request);
    if (!access || access.platformLevel >= PlatformLevel.GlobalSuperAdmin) {
      return true;
    }
    denyRead(request, route, "需要平台超级管理员（240）");
    await reply
      .code(403)
      .send(errorBody("forbidden", "权限不足：需要平台超级管理员。"));
    return false;
  };

  /** 群级只读端点：本群档位不够 403（返回 false = 已回过响应）。 */
  const allowGroupRead = async (
    request: FastifyRequest,
    reply: FastifyReply,
    route: string,
    groupId: string,
    required: number,
  ): Promise<boolean> => {
    const access = await readAccessOf(request);
    if (!access || levelIn(access, groupId) >= required) {
      return true;
    }
    denyRead(request, route, `需要本群档位 ${required}`, groupId);
    await reply
      .code(403)
      .send(errorBody("forbidden", "权限不足：本群权限不够。"));
    return false;
  };

  /**
   * 周期任务监测（`/api/tasks`）：统一扫描周期 + 每个任务的上次/下次执行 + 部署监测的待重启状态。
   *
   * 门槛与 `/api/status` 一致（平台超管 240）：这是运维面板，会暴露内部节拍与降级情况。
   * 只读巡检进程没有调度器 → 503 并说明「去机器人进程那口看」。
   */
  app.get("/api/tasks", async (request, reply) => {
    if (!(await allowPlatformRead(request, reply, "GET /api/tasks"))) {
      return reply;
    }
    const view = options.tasksProvider?.();
    if (!view) {
      return reply
        .code(503)
        .send(
          errorBody(
            "unavailable",
            "本进程没有周期任务调度器（只读巡检模式 / 未装配）：请用机器人进程内的管理监听口查看。",
          ),
        );
    }
    return view;
  });


  /**
   * 配置视图（`/api/settings`）：可改的热改项（含当前生效值与来源）+ `.env` 只读项。
   *
   * 门槛与 `/api/status` 一致（平台超管 240）。密钥类 `.env` 项**只回「配没配」**，
   * 值永远不经过浏览器。
   */
  app.get("/api/settings", async (request, reply) => {
    if (!(await allowPlatformRead(request, reply, "GET /api/settings"))) {
      return reply;
    }
    const view = options.settingsProvider?.();
    if (!view) {
      return reply
        .code(503)
        .send(
          errorBody(
            "unavailable",
            "本进程没有内存态配置存储（只读巡检模式 / 未装配）：请用机器人进程内的管理监听口查看。",
          ),
        );
    }
    return view;
  });

  /** 改一项热改配置（平台级 240）：校验 → 落库 → 立即生效，并写审计。 */
  app.put("/api/settings", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (key.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 key（配置项名，见 GET /api/settings）。"));
    }
    if (typeof body.value !== "string" && typeof body.value !== "number" && typeof body.value !== "boolean") {
      return reply
        .code(400)
        .send(errorBody("bad_request", "value 必须是字符串 / 数字 / 布尔。"));
    }
    const item = await writers.updateSetting(key, String(body.value), actorOf(request));
    return { ok: true, setting: item };
  });

  /** 把一项热改配置恢复成 `.env` 默认值（平台级 240）。 */
  app.delete("/api/settings/:key", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { key } = request.params as { key: string };
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要配置项名。"));
    }
    const item = await writers.clearSetting(trimmed, actorOf(request));
    return { ok: true, setting: item };
  });

  /**
   * 处罚记录（`/api/punishments`，P1 只读）：与 `/punish list` 同一份数据。
   *
   * 门槛：平台超管 240 不传 `group` 看全量；其余人必须带 `group=` 且本群 ≥120（与指令层一致）。
   */
  app.get("/api/punishments", async (request, reply) => {
    const reader = options.readers?.punishments;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "处罚数据源未装配（只读巡检模式 / 缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    const status = queryString(query.status);
    const scope = scopeOf(await readAccessOf(request));
    if (scope) {
      if (group === undefined) {
        return reply
          .code(400)
          .send(
            errorBody(
              "bad_request",
              "需要 ?group=<群 ID>：只有平台超级管理员能看全量处罚记录。",
            ),
          );
      }
      if (
        !(await allowGroupRead(
          request,
          reply,
          "GET /api/punishments",
          group,
          PermissionLevel.Moderator,
        ))
      ) {
        return reply;
      }
    }
    const all = await reader({
      ...(group !== undefined ? { group } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const start = (page - 1) * pageSize;
    return {
      total: all.length,
      page,
      pageSize,
      items: all.slice(start, start + pageSize),
    };
  });

  /**
   * 黑名单（`/api/blacklist?group=`，P1 只读）：本群一组 + 全局一组。
   *
   * 门槛：本群列表 ≥120（与 `/blacklist` 一致）；**全局那组只有平台 240 能看到**，
   * 看不到时返回 `globalVisible: false`（界面据此说明「权限不够」，而不是显示成「全局没人」）。
   */
  app.get("/api/blacklist", async (request, reply) => {
    const reader = options.readers?.blacklist;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "黑名单数据源未装配（只读巡检模式 / 缺少数据库）。"));
    }
    const group = queryString((request.query as Record<string, unknown>).group);
    if (group === undefined) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 ?group=<群 ID>（黑名单是群维度的）。"));
    }
    if (
      !(await allowGroupRead(
        request,
        reply,
        "GET /api/blacklist",
        group,
        PermissionLevel.Moderator,
      ))
    ) {
      return reply;
    }
    const access = await readAccessOf(request);
    const includeGlobal =
      !access || access.platformLevel >= PlatformLevel.GlobalSuperAdmin;
    return reader(group, { includeGlobal });
  });

  /** 申诉队列（`/api/appeals`，P1 只读）：门槛与 `/api/punishments` 相同。 */
  app.get("/api/appeals", async (request, reply) => {
    const reader = options.readers?.appeals;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "申诉数据源未装配（只读巡检模式 / 缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    const status = queryString(query.status);
    const scope = scopeOf(await readAccessOf(request));
    if (scope) {
      if (group === undefined) {
        return reply
          .code(400)
          .send(
            errorBody(
              "bad_request",
              "需要 ?group=<群 ID>：只有平台超级管理员能看全量申诉。",
            ),
          );
      }
      if (
        !(await allowGroupRead(
          request,
          reply,
          "GET /api/appeals",
          group,
          PermissionLevel.Moderator,
        ))
      ) {
        return reply;
      }
    }
    return reader({
      ...(group !== undefined ? { group } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  });

  /**
   * 通知投递记录（`/api/notify/deliveries`，P1 只读）：排查「我说了怎么没通知」。
   *
   * 门槛与处罚 / 申诉一致：平台 240 看全量，其余人带 `group=` 且本群 ≥120。
   */
  app.get("/api/notify/deliveries", async (request, reply) => {
    const reader = options.readers?.deliveries;
    if (!reader) {
      return reply
        .code(503)
        .send(
          errorBody("unavailable", "投递记录数据源未装配（只读巡检模式 / 缺少数据库）。"),
        );
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    const status = queryString(query.status);
    const scope = scopeOf(await readAccessOf(request));
    if (scope) {
      if (group === undefined) {
        return reply
          .code(400)
          .send(
            errorBody(
              "bad_request",
              "需要 ?group=<群 ID>：只有平台超级管理员能看全量投递记录。",
            ),
          );
      }
      if (
        !(await allowGroupRead(
          request,
          reply,
          "GET /api/notify/deliveries",
          group,
          PermissionLevel.Moderator,
        ))
      ) {
        return reply;
      }
    }
    const all = await reader({
      ...(group !== undefined ? { group } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    const counts = new Map<string, number>();
    for (const item of all) {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    }
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const start = (page - 1) * pageSize;
    return {
      total: all.length,
      page,
      pageSize,
      items: all.slice(start, start + pageSize),
      counts: [...counts.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((left, right) => right.count - left.count),
    };
  });

  /**
   * 订阅关系只读（`GET /api/notify/subscriptions`，平台超管 240）。
   *
   * 回答「我说了怎么没通知」的另一半：**他到底订没订、订的哪个范围、现在够不够门槛**
   * （订阅了但角色掉下来也会被推送跳过 —— 判据与推送同一份 `checkTopicReach`）。
   * 订阅是个人偏好：这里**只读**，改仍在机器人里用 `/notify`。
   */
  app.get("/api/notify/subscriptions", async (request, reply) => {
    if (
      !(await allowPlatformRead(request, reply, "GET /api/notify/subscriptions"))
    ) {
      return reply;
    }
    const reader = options.readers?.notifySubscriptions;
    if (!reader) {
      return reply
        .code(503)
        .send(
          errorBody(
            "unavailable",
            "订阅关系数据源未装配（只读巡检模式 / 推送服务未启用）。",
          ),
        );
    }
    const query = request.query as Record<string, unknown>;
    const topic = queryString(query.topic);
    const group = queryString(query.group);
    const user = queryString(query.user);
    const view = await reader({
      ...(topic !== undefined ? { topic } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(user !== undefined ? { userId: user } : {}),
      ...(queryString(query.ineligible) === "1" ? { ineligibleOnly: true } : {}),
    });
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const start = (page - 1) * pageSize;
    return {
      counts: view.counts,
      total: view.total,
      page,
      pageSize,
      items: view.items.slice(start, start + pageSize),
    };
  });

  /**
   * 运维只读（`/api/health`，P1）：进程细节 + 模块健康 + 写队列 + 迁移问题 + 恢复现场。
   *
   * 门槛与 `/api/status` 一致（平台超管 240）。只读巡检进程没有这些内存态 → 503。
   */
  app.get("/api/health", async (request, reply) => {
    if (!(await allowPlatformRead(request, reply, "GET /api/health"))) {
      return reply;
    }
    const reader = options.readers?.health;
    if (!reader) {
      return reply
        .code(503)
        .send(
          errorBody(
            "unavailable",
            "本进程没有运行时状态（只读巡检模式 / 未装配）：请用机器人进程内的管理监听口查看。",
          ),
        );
    }
    return reader();
  });

  /**
   * 重试加载一个降级模块（运维写，平台超管 240）：
   * `POST /api/health/modules/:key/retry`。
   *
   * 与机器人 `/status proc` 的「重试加载」同一个领域入口，**幂等**（只重跑该模块的 `load()`，
   * 不动业务数据、不重启进程）；只读巡检模式没有健康注册表 → 503。
   * 仍失败不是 HTTP 错误：`ok: false` + `result.module.error` 如实回原因。
   */
  app.post("/api/health/modules/:key/retry", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { key } = request.params as { key: string };
    const result = await writers.retryModule(key.trim(), actorOf(request));
    return { ok: result.recovered, result };
  });

  /** 同步官方入群申请队列（写但幂等）：与 `/sync` 同一服务，本群 120。 */
  app.post("/api/join/sync", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 group（群 ID；同步是群维度的）。"));
    }
    const result = await writers.syncJoinRequests(group, actorOf(request));
    return { ok: true, ...result };
  });

  /**
   * 审计记录导出（`/api/audit/export.csv`）：与 `/export audit` 同口径。
   *
   * 本群要 130（与指令层一致）、平台 240 可不带 `group=` 导出全量；
   * `?full=1` 不脱敏（默认把 actor/target 的 openid 打码），两种都写审计。
   */
  app.get("/api/audit/export.csv", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    const result = await writers.exportAuditCsv(actorOf(request), {
      ...(group !== undefined ? { group } : {}),
      full: queryString(query.full) === "1",
    });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="${result.filename}"`,
    );
    // BOM：没有它 Excel 会按本地编码猜，中文列名直接乱码
    return reply.send(`\uFEFF${result.csv}`);
  });

  /**
   * 改话题门槛：`PUT /api/notify/levels { topic, level }`（平台超管 240）。
   *
   * 数值口径与指令层一致：`-1` = 不限、`110`–`140` 群内轴、`210`–`240` 平台轴。
   */
  app.put("/api/notify/levels", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (topic.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 topic（话题名，见 GET /api/notify/topics）。"));
    }
    const rawLevel =
      typeof body.level === "number"
        ? body.level
        : typeof body.level === "string" && /^-?\d+$/u.test(body.level)
          ? Number.parseInt(body.level, 10)
          : undefined;
    if (rawLevel === undefined || !Number.isInteger(rawLevel)) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "level 必须是整数（-1 = 不限、110–140 群内档、210–240 平台档）。"));
    }
    const result = await writers.setNotifyLevel({
      topic,
      level: rawLevel,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /** 所有话题门槛恢复默认：`POST /api/notify/levels/reset`（平台超管 240）。 */
  app.post("/api/notify/levels/reset", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const result = await writers.resetNotifyLevels(actorOf(request));
    return { ok: true, ...result };
  });

  /**
   * 给自己发测试卡：`POST /api/notify/test { group? }`（任何登录管理员都能用）。
   *
   * **只发给自己**（收件人取会话里的 userId，不接受请求体指定），所以不需要额外门槛：
   * 它既不打扰别人，也不泄漏任何数据。私信发不出去时返回 `ok: false` 与原因。
   */
  app.post("/api/notify/test", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const userId = actorOf(request);
    if (userId.length === 0) {
      return reply.code(401).send(errorBody("unauthorized", "需要登录。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = queryString(body.group);
    const result = await writers.sendNotifyTest({
      userId,
      ...(group !== undefined ? { groupId: group } : {}),
    });
    return { ok: result.ok, result };
  });

  /** 规则关键词逐条增删：`POST /api/rules/keywords { group, action, words }`（130 / 全局 240）。 */
  app.post("/api/rules/keywords", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 group（群 ID；全局用 __default__）。"));
    }
    const action = body.action === "remove" ? "remove" : "add";
    const words = Array.isArray(body.words)
      ? body.words.filter((word): word is string => typeof word === "string")
      : typeof body.word === "string"
        ? [body.word]
        : [];
    if (words.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 words（要加 / 要删的词，至少一个）。"));
    }
    const actorId = actorOf(request);
    const result =
      action === "add"
        ? await writers.addRuleKeywords({ groupId: group, words, actorId })
        : await writers.removeRuleKeywords({ groupId: group, words, actorId });
    return { ...result, ok: true };
  });

  /** 恢复继承（字段级）：`POST /api/rules/reset-fields { group, fields }`。 */
  app.post("/api/rules/reset-fields", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 group（群 ID；全局用 __default__）。"));
    }
    const fields = Array.isArray(body.fields)
      ? body.fields.filter((field): field is string => typeof field === "string")
      : [];
    if (fields.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 fields（要恢复继承的字段名，至少一个）。"));
    }
    const result = await writers.resetRuleFields({
      groupId: group,
      fields,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /** 恢复继承（整群）：`POST /api/rules/reset { group }` —— 不可逆，界面要二次确认。 */
  app.post("/api/rules/reset", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 group（群 ID；全局用 __default__）。"));
    }
    const result = await writers.resetRuleGroup({
      groupId: group,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /** 别名表（平台超管 240）：`GET /api/aliases`。 */
  app.get("/api/aliases", async (request, reply) => {
    if (!(await allowPlatformRead(request, reply, "GET /api/aliases"))) {
      return reply;
    }
    const reader = options.readers?.aliases;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "别名服务未启用（只读巡检模式 / 未装配）。"));
    }
    return { aliases: await reader() };
  });

  /** 新增 / 覆盖别名：`PUT /api/aliases { alias, target }`（平台超管 240）。 */
  app.put("/api/aliases", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    const target = typeof body.target === "string" ? body.target.trim() : "";
    if (alias.length === 0 || target.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 alias 与 target（都得是非空字符串）。"));
    }
    const result = await writers.setAlias({
      alias,
      target,
      actorId: actorOf(request),
    });
    return { ...result, ok: true };
  });

  /** 删除别名：`DELETE /api/aliases/:alias`（平台超管 240）。 */
  app.delete("/api/aliases/:alias", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { alias } = request.params as { alias: string };
    const result = await writers.removeAlias({
      alias: alias.trim(),
      actorId: actorOf(request),
    });
    return { ...result, ok: result.ok };
  });

  /** 只读状态（E1-c）：入口给数据库与迁移信息，server 补版本 / 运行时长 / 会话数。 */
  app.get("/api/status", async (request, reply) => {
    if (!(await allowPlatformRead(request, reply, "GET /api/status"))) {
      return reply;
    }
    const extra = options.statusProvider ? await options.statusProvider() : undefined;
    return {
      version: options.version ?? "unknown",
      uptimeMs: options.uptimeMs?.() ?? Date.now() - startedAt,
      database: extra?.database ?? "unknown",
      migrationIssues: extra?.migrationIssues ?? 0,
      activeTokens: extra?.activeTokens ?? 0,
      sessions: sessions.size,
    };
  });

  /**
   * 只读审计记录（E1-c）：按群 / 操作人 / 操作对象 / 动作 / 状态 / 时间范围过滤 + 分页；
   * 全量只有平台超管能看。
   *
   * 口径（收尾批次 B）：
   * - **操作人 / 操作对象按「人念得出来的名字」匹配** —— 内部 id、绑定的 QQ号、`#短码`、
   *   展示名都算命中（页面上复制一个 QQ号过来就能筛，不必翻「详情」里的 openid）；
   * - **时间范围**：`from` / `to` 收 `YYYY-MM-DD`（按本地日，`to` 含当天最后一毫秒）或 ISO 时间，
   *   坏值回 400（**不静默忽略**，否则会以为筛了其实没筛）；
   * - 响应始终带 `total`（筛选后的总数），与 `items` 同一次计算。
   *
   * 注意：**CSV 导出（`/api/audit/export.csv`）的筛选面不变**（`group` / `full`，按群或全量），
   * 不跟随这里的筛选 —— 页面上的导出链接文案要如实写清。
   */
  app.get("/api/audit", async (request, reply) => {
    const reader = options.auditReader;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "审计数据源未装配（缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const group = queryString(query.group);
    const actor = queryString(query.actor);
    const target = queryString(query.target);
    const action = queryString(query.action);
    const status = queryString(query.status);
    const rawFrom = queryString(query.from);
    const rawTo = queryString(query.to);
    let from: Date | undefined;
    let to: Date | undefined;
    try {
      from = rawFrom === undefined ? undefined : parseAuditBound(rawFrom, "from");
      to = rawTo === undefined ? undefined : parseAuditBound(rawTo, "to");
    } catch (error) {
      return reply
        .code(400)
        .send(
          errorBody(
            "bad_request",
            error instanceof Error ? error.message : String(error),
          ),
        );
    }

    const scope = scopeOf(await readAccessOf(request));
    if (scope) {
      // 非平台超管：必须指明群，且按该群档位判定（与 `/audit` 一样是审核员 120 起）
      if (group === undefined) {
        return reply
          .code(400)
          .send(
            errorBody(
              "bad_request",
              "需要 ?group=<群 ID>：只有平台超级管理员能查全量审计。",
            ),
          );
      }
      if (
        !(await allowGroupRead(
          request,
          reply,
          "GET /api/audit",
          group,
          PermissionLevel.Moderator,
        ))
      ) {
        return reply;
      }
    }

    const all = await reader.list();
    const filtered = filterAuditRecords(all, {
      ...(group !== undefined ? { group } : {}),
      ...(actor !== undefined ? { actor } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  /**
   * 待审批入群申请（E1-c）：状态为 pending，可按群过滤 + 分页。
   *
   * 非平台超管只看得到**自己够审核员（120）的群**（与指令层 `/pending` 同口径）；
   * 通过 / 拒绝按钮另外要群管理员 130（由写端点判定）。
   */
  app.get("/api/pending", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const group = queryString(query.group);

    const scope = scopeOf(await readAccessOf(request));
    const all = await readers.pending();
    const visible =
      scope === undefined
        ? all
        : all.filter(
            (item) =>
              levelIn(scope, item.groupId) >= PermissionLevel.Moderator,
          );
    const filtered =
      group === undefined
        ? visible
        : visible.filter((item) => item.groupId === group);
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  /**
   * 某个群的规则覆盖（E1-c）：只读原始覆盖行 + 合并后的生效值。
   *
   * `group` 用**内部群 ID**（`/auth/me` 给的就是它），不接受 `#群短码`；
   * 全局规则（`__default__`）只有平台超管能读，单群要审核员 120（与 `/rules` 查看口径一致）。
   */
  app.get("/api/rules", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    const group = queryString((request.query as Record<string, unknown>).group);
    if (group === undefined) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 ?group=<群 ID>。"));
    }
    if (group === DEFAULT_GROUP_ID) {
      if (!(await allowPlatformRead(request, reply, "GET /api/rules"))) {
        return reply;
      }
    } else if (
      !(await allowGroupRead(
        request,
        reply,
        "GET /api/rules",
        group,
        PermissionLevel.Moderator,
      ))
    ) {
      return reply;
    }
    return readers.rules(group);
  });

  /** 通知话题概览（E1-c）：默认门槛与订阅人数，供后台展示；话题门槛是平台级配置。 */
  app.get("/api/notify/topics", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    if (!(await allowPlatformRead(request, reply, "GET /api/notify/topics"))) {
      return reply;
    }
    return { topics: await readers.notifyTopics() };
  });

  /** 活动列表（E1-c）：可选按群 / 状态过滤 + 分页；非平台超管只看得见自己的群（120 起）。 */
  app.get("/api/activities", async (request, reply) => {
    const readers = options.readers;
    if (!readers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "数据源未装配（缺少数据库）。"));
    }
    const query = request.query as Record<string, unknown>;
    const page = positiveQueryInt(query.page, 1);
    const pageSize = Math.min(positiveQueryInt(query.pageSize, 50), 200);
    const group = queryString(query.group);
    const status = queryString(query.status);

    const scope = scopeOf(await readAccessOf(request));
    const all = await readers.activities();
    const visible =
      scope === undefined
        ? all
        : all.filter(
            (item) => levelIn(scope, item.groupId) >= PermissionLevel.Moderator,
          );
    const filtered = visible.filter(
      (item) =>
        (group === undefined || item.groupId === group) &&
        (status === undefined || item.status === status),
    );
    const start = (page - 1) * pageSize;
    return {
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    };
  });

  /**
   * 活动字段目录（E1-k）：给「改活动字段」的表单渲染用（字段名 / 中文名 / 输入类型 / 提示）。
   *
   * 静态清单、不含任何数据，所以只要求**登录**；真正的改字段按活动所属群判本群 130。
   * 与 `/activity set` 共用 `ACTIVITY_SETTING_FIELDS`，所以界面上的字段就是指令层支持的字段。
   */
  app.get("/api/activities/fields", async () => ({
    fields: ACTIVITY_SETTING_FIELDS,
  }));

  /**
   * 统计报表（E5）：按天 / 按群聚合的四块（群活跃 / 审核量 / 活动报名 / 通知投递）。
   *
   * 门槛：平台超管 240 可不带 `group=` 看全量；其余人必须带 `?group=`（缺参数 400）
   * 且本群 ≥130 —— 报表是「管理动作的汇总」，与名单导出一个档。
   * 只读巡检模式没有内存态（审计 / 处罚 / 活动都在进程里）→ 503。
   */
  app.get("/api/reports", async (request, reply) => {
    const reader = options.readers?.reports;
    if (!reader) {
      return reply
        .code(503)
        .send(
          errorBody(
            "unavailable",
            "统计报表数据源未装配（只读巡检模式 / 未装配）。",
          ),
        );
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    const days = parseReportDays(query.days);

    const scope = scopeOf(await readAccessOf(request));
    if (scope) {
      if (group === undefined) {
        return reply
          .code(400)
          .send(
            errorBody(
              "bad_request",
              "需要 ?group=<群 ID>：只有平台超级管理员能看全量报表。",
            ),
          );
      }
      if (
        !(await allowGroupRead(
          request,
          reply,
          "GET /api/reports",
          group,
          PermissionLevel.GroupAdmin,
        ))
      ) {
        return reply;
      }
    }
    return reader({ ...(group !== undefined ? { group } : {}), days });
  });

  /**
   * 报表 CSV（E5）：与页面同一份装配，输出长表（`section,metric,bucket,group,value`）。
   *
   * 本群 130 拿**脱敏**长表（群只出展示标签）；`?full=1`（追加内部群 ID 列）与不带
   * `group=` 的全量都要平台 240，两种都写 `admin_api:report_export` 审计。
   */
  app.get("/api/reports/export.csv", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    const result = await writers.exportReportsCsv(actorOf(request), {
      ...(group !== undefined ? { group } : {}),
      days: parseReportDays(query.days),
      full: queryString(query.full) === "1",
    });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="${result.filename}"`,
    );
    // BOM：与审计导出一致，Excel 直开不乱码
    return reply.send(`\uFEFF${result.csv}`);
  });

  /**
   * 权限总览（`GET /api/permissions?group=`，**平台超管 240**）。
   *
   * 与指令层 `/perm list` 同一份数据（`PermissionService`）：全局超管 + 选定群的
   * 群超管 / 群管理员 / 审核员；`groups` 是「有任何群内授权的群」，给页面做选择器。
   */
  app.get("/api/permissions", async (request, reply) => {
    const reader = options.readers?.permissions;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "权限数据源未装配（只读巡检模式）。"));
    }
    if (!(await allowPlatformRead(request, reply, "GET /api/permissions"))) {
      return reply;
    }
    const query = request.query as Record<string, unknown>;
    const group = queryString(query.group);
    return reader({ ...(group !== undefined ? { group } : {}), });
  });

  /**
   * 授予 / 撤销角色：`POST /api/permissions { action, role, group?, userId }`（**平台超管 240**）。
   *
   * `action` = `grant` / `revoke`；`role` = `super` / `group_super` / `group_admin` / `moderator`
   * （`super` 不带群，其余三个必须带）。与指令层 `/perm` 同源；界面必须二次确认并展示
   * 「改完谁失去了什么」——回执里的 `members` 就是改完之后该角色的名单。
   */
  app.post("/api/permissions", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action.trim() : "";
    if (action !== "grant" && action !== "revoke") {
      return reply
        .code(400)
        .send(errorBody("bad_request", "action 只能是 grant / revoke。"));
    }
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (role.length === 0) {
      return reply
        .code(400)
        .send(
          errorBody(
            "bad_request",
            "需要 role（super / group_super / group_admin / moderator）。",
          ),
        );
    }
    const group = typeof body.group === "string" ? body.group.trim() : "";
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (userId.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 userId（openid / QQ号 / #短码）。"));
    }
    const result = await writers.setPermission({
      action,
      role,
      ...(group.length > 0 ? { group } : {}),
      userId,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /**
   * 身份映射只读（`GET /api/identities`，**平台超管 240**）：群号 ↔ 群 ID、QQ号 ↔ openid。
   *
   * 这是 `/bind user` / `/bind groupid`（代绑任意主体）的**只读**面：写仍然只在机器人里做，
   * 后台只回答「这个群号对应哪个群 ID / 这个人是什么时候绑的」——排查展示层问题时最常用。
   */
  app.get("/api/identities", async (request, reply) => {
    const reader = options.readers?.identities;
    if (!reader) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "身份映射数据源未装配。"));
    }
    if (!(await allowPlatformRead(request, reply, "GET /api/identities"))) {
      return reply;
    }
    return reader();
  });

  // ------------------------------------------------------------------ 写端点（E1-d）
  //
  // 统一形状：取路径 / 请求体参数 → 调 `writers` → 原样序列化领域层回执。
  // 权限判据（本群群管理员 130 / 平台超管 240）、领域服务调用与审计都在 writer 里；
  // writer 抛 `AdminApiRequestError` 时由下面的 errorHandler 映射成 400/403/404/409。

  /** 通过入群申请（复用 `JoinApprovalService`，官方接口成功后才落地本地状态）。 */
  app.post("/api/pending/:requestId/approve", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { requestId } = request.params as { requestId: string };
    const result = await writers.approveJoin(requestId, actorOf(request));
    return { ok: true, ...result };
  });

  /** 拒绝入群申请：请求体 `{ reason }`（可空，空 = 官方默认文案）。 */
  app.post("/api/pending/:requestId/reject", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { requestId } = request.params as { requestId: string };
    const body = (request.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : "";
    const result = await writers.rejectJoin(requestId, actorOf(request), reason);
    return { ok: true, ...result };
  });

  /** 写规则：`{ group, field, value }`；非法值整体拒绝（不会写半套）。 */
  app.put("/api/rules", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(
          errorBody(
            "bad_request",
            "需要 group（群 ID / #群短码 / 全局用 __default__）。",
          ),
        );
    }
    const field = typeof body.field === "string" ? body.field.trim() : "";
    if (field.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 field（规则字段名）。"));
    }
    if (typeof body.value !== "string") {
      return reply
        .code(400)
        .send(errorBody("bad_request", "value 必须是字符串（清空用空串）。"));
    }
    const result = await writers.updateRule(
      group,
      field,
      body.value,
      actorOf(request),
    );
    return { ok: true, ...result };
  });

  /** 处罚动作：`POST /api/punishments/:code/release|mute|kick|blacklist`。 */
  const PUNISH_ACTIONS = new Set(["release", "mute", "kick", "blacklist"]);
  app.post("/api/punishments/:code/:action", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code, action } = request.params as { code: string; action: string };
    if (!PUNISH_ACTIONS.has(action)) {
      return reply
        .code(400)
        .send(
          errorBody(
            "bad_request",
            "action 只能是 release | mute | kick | blacklist。",
          ),
        );
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const note = typeof body.note === "string" ? body.note : undefined;
    const seconds =
      typeof body.seconds === "number"
        ? body.seconds
        : typeof body.seconds === "string" && /^\d+$/u.test(body.seconds)
          ? Number.parseInt(body.seconds, 10)
          : undefined;
    if (action === "mute" && seconds === undefined) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "改禁言时长需要 seconds（整数秒；0 = 解除禁言）。"));
    }
    const scope =
      body.scope === "global"
        ? "global"
        : body.scope === "group"
          ? "group"
          : undefined;
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const result = await writers.punish({
      code: code.trim(),
      action: action as "release" | "mute" | "kick" | "blacklist",
      actorId: actorOf(request),
      ...(note !== undefined ? { note } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    return { ok: result.ok, result };
  });

  /** 加入黑名单：`POST /api/blacklist { scope, group, userId, reason }`。 */
  app.post("/api/blacklist", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (userId.length === 0) {
      return reply.code(400).send(errorBody("bad_request", "需要 userId（QQ号 / #短码 / openid）。"));
    }
    const scope = body.scope === "global" ? "global" : "group";
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (scope === "group" && group.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "本群黑名单需要 group（群 ID）。"));
    }
    const result = await writers.addBlacklist({
      scope,
      ...(scope === "group" ? { groupId: group } : {}),
      userId,
      actorId: actorOf(request),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    return { ok: result.ok, result };
  });

  /** 解除黑名单：`DELETE /api/blacklist/:userId?scope=&group=`。 */
  app.delete("/api/blacklist/:userId", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { userId } = request.params as { userId: string };
    const query = request.query as Record<string, unknown>;
    const scope = queryString(query.scope) === "global" ? "global" : "group";
    const group = queryString(query.group);
    if (scope === "group" && group === undefined) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "本群黑名单需要 ?group=<群 ID>。"));
    }
    const result = await writers.removeBlacklist({
      scope,
      ...(group !== undefined ? { groupId: group } : {}),
      userId: userId.trim(),
      actorId: actorOf(request),
    });
    return { ok: result.ok, result };
  });

  /**
   * 申诉复核：`POST /api/appeals/:code/accept|reject`（本群 120）。
   *
   * 通过 = 撤销该处罚（与指令层一致）；驳回可带 `note`（默认「已驳回」）。
   * 两种结果都会私信申诉人。
   */
  app.post("/api/appeals/:code/:decision", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code, decision } = request.params as {
      code: string;
      decision: string;
    };
    if (decision !== "accept" && decision !== "reject") {
      return reply
        .code(400)
        .send(errorBody("bad_request", "decision 只能是 accept | reject。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await writers.decideAppeal({
      code: code.trim(),
      decision: decision === "accept" ? "accepted" : "rejected",
      actorId: actorOf(request),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
    });
    return { ok: true, result };
  });

  /** 新建活动：`POST /api/activities { group, title }`（只建草稿）。 */
  app.post("/api/activities", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (group.length === 0 || title.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 group 与 title（标题不能为空）。"));
    }
    const result = await writers.createActivity({
      groupId: group,
      title,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /**
   * 改活动字段：`PUT /api/activities/:code { field, value }`（本群群管理员 130）。
   *
   * `field` / `value` 与 `/activity set` **同一套写法**（含中文别名、`clear` 清空），
   * 走的也是同一个 `applyActivitySetting`，所以满员广播、变更私信等连带效果一致。
   */
  app.put("/api/activities/:code", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const field = typeof body.field === "string" ? body.field.trim() : "";
    if (field.length === 0) {
      return reply
        .code(400)
        .send(
          errorBody(
            "bad_request",
            "需要 field（活动字段名，写法同 /activity set，例如 capacity / 名额）。",
          ),
        );
    }
    if (typeof body.value !== "string") {
      return reply
        .code(400)
        .send(errorBody("bad_request", "value 必须是字符串（清空用 clear）。"));
    }
    const result = await writers.updateActivity({
      code: code.trim(),
      field,
      value: body.value,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /** 绑定发布群：`POST /api/activities/:code/groups { group }`。 */
  app.post("/api/activities/:code/groups", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (group.length === 0) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "需要 group（要绑定的群 ID）。"));
    }
    const result = await writers.bindActivityGroup({
      code: code.trim(),
      groupId: group,
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  /** 解绑发布群：`DELETE /api/activities/:code/groups/:group`。 */
  app.delete("/api/activities/:code/groups/:group", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code, group } = request.params as { code: string; group: string };
    const result = await writers.unbindActivityGroup({
      code: code.trim(),
      groupId: group.trim(),
      actorId: actorOf(request),
    });
    return { ok: true, ...result };
  });

  const ACTIVITY_ACTIONS = new Set(["open", "close", "cancel"]);
  /** 活动状态：`POST /api/activities/:code/open|close|cancel`。 */
  app.post("/api/activities/:code/:action", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code, action } = request.params as { code: string; action: string };
    if (!ACTIVITY_ACTIONS.has(action)) {
      return reply
        .code(400)
        .send(errorBody("bad_request", "动作只能是 open / close / cancel。"));
    }
    const result = await writers.setActivityStatus(
      code,
      action as "open" | "close" | "cancel",
      actorOf(request),
    );
    return { ok: true, ...result };
  });

  /**
   * 活动名单 CSV：默认**脱敏**（清空学号 / 班级 / 学院），`?full=1` 才带隐私列。
   *
   * 两种都要求本群群管理员并写审计；响应带 UTF-8 BOM，Excel 直接打开不乱码。
   */
  app.get("/api/activities/:code/export.csv", async (request, reply) => {
    const writers = options.writers;
    if (!writers) {
      return reply
        .code(503)
        .send(errorBody("unavailable", "写端点未装配（只读巡检模式）。"));
    }
    const { code } = request.params as { code: string };
    const query = request.query as Record<string, unknown>;
    const full = queryString(query.full) === "1";
    const result = await writers.exportActivityCsv(code, actorOf(request), {
      full,
    });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="${result.filename}"`,
    );
    // BOM：没有它 Excel 会按本地编码猜，中文列名直接乱码
    return reply.send(`\uFEFF${result.csv}`);
  });

  app.post("/auth/logout", async (request, reply) => {
    sessions.destroy(readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE));
    reply.header("set-cookie", sessionCookie("", config, 0));
    log.info("admin api logout", { userId: request.adminSession?.userId ?? null });
    return { ok: true };
  });

  // 管理前台静态资源（E2-e）：默认 `web/dist`（目录不存在就跳过）。
  // 挂在这里而不是更早：让 API 路由先注册，静态处理器只兜「不是接口」的路径。
  const webRoot = options.webRoot?.trim();
  if (webRoot !== undefined && webRoot.length > 0) {
    registerWebUi(app, { root: webRoot, logger: log });
  }

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send(
      errorBody(
        "not_found",
        "管理 API 没有这个接口。管理后台页面（`/`、`/login` 等）默认由本服务托管 web/dist；" +
          "如果这里是 404，多半是没部署前端或 ADMIN_API_WEB_DIR 留空了 ——" +
          "把整个域名反代到这个端口是对的做法，页面由本服务提供。",
      ),
    ),
  );
  app.setErrorHandler(async (error, _request, reply) => {
    // 领域层给的判定（权限不足 / 参数非法 / 不存在 / 已被处理）：按原状态码回，不打日志噪声
    if (error instanceof AdminApiRequestError) {
      log.info("admin api request rejected", {
        status: error.statusCode,
        error: error.errorCode,
      });
      return reply
        .code(error.statusCode)
        .send(errorBody(error.errorCode, error.message));
    }
    // Fastify 自带的 4xx（body 解析失败 / 不支持的 Content-Type / 空 body 等）也是**调用方的问题**，
    // 必须按原状态码回：以前一律吞成 500，客户端会以为服务挂了（真机 e2e 就踩到过）。
    const status = (error as { statusCode?: unknown }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof status === "number" && status >= 400 && status < 500) {
      log.info("admin api bad request", { status, error: message });
      return reply.code(status).send(errorBody("bad_request", message));
    }
    log.warn("admin api error", {
      error: message,
      // 500 一律带调用栈：这条日志就是排查入口（曾经只有一句 message，定位花了不少时间）
      stack: error instanceof Error ? error.stack : undefined,
    });
    return reply.code(500).send(errorBody("internal_error", "服务内部错误。"));
  });

  return {
    app,
    sessions,
    limiter,
    loginUrl: (token: string) => adminLoginUrl(config, token),
  };
}

function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

/**
 * 这个路径是不是管理 API 自己的接口（需要鉴权的那部分）。
 *
 * 约定：`/api/*` + `/auth/me` + `/auth/logout`。`/healthz` 与 `/auth/token` 是公开端点，
 * 在钩子里已经提前返回；其余路径一律当作「不是这个服务的」，交给 404 处理器 ——
 * 这样把 `/login` 之类的页面路径反代到管理 API 时会得到一句诚实的 404，而不是
 * 「请先登录」那种误导性的 401。
 */
export function isAdminApiRoute(route: string): boolean {
  return (
    route.startsWith("/api/") ||
    route === "/auth/me" ||
    route === "/auth/logout"
  );
}

function queryString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveQueryInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `?days=` 的解析：缺失 / 非法一律回默认值，合法值夹到 `1..90`（口径见 reports.ts）。 */
function parseReportDays(value: unknown): number {
  const parsed =
    typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return normalizeReportDays(Number.isFinite(parsed) ? parsed : undefined);
}

function hasCsrfHeader(request: FastifyRequest): boolean {
  return request.headers["x-admin-request"] === "1";
}

function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

/** 从 `Authorization: Bearer <token>` 里取令牌。 */
export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/** 用常量时间比较找出匹配的机器令牌（避免按字符提前返回的时序差异）。 */
export function findMachineToken(
  tokens: readonly AdminApiMachineToken[],
  candidate: string,
  now: Date = new Date(),
): AdminApiMachineToken | undefined {
  let matched: AdminApiMachineToken | undefined;
  for (const token of tokens) {
    // 只比令牌本身与有效期：scope 是**这个请求**能不能过的事，
    // 细粒度 token 不满足粗粒度 read/write，不能因此被当成「令牌不存在」（会变成 401）。
    if (machineTokenUsable(token, now) && tokensEqual(token.token, candidate)) {
      matched = token;
    }
  }
  return matched;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `maxAgeSeconds = 0` 表示清 cookie（登出）。 */
export function sessionCookie(
  value: string,
  config: AdminApiConfig,
  maxAgeSeconds = Math.floor(config.sessionTtlMs / 1000),
): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
