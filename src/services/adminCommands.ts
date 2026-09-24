import { PermissionLevel } from "../core/enums.js";
import type { KeyboardModal } from "../adapters/qqOfficial.js";
import { encodeCallback, extractPageToken, pageCallback } from "./callbackData.js";
import {
  escapeCardText,
  quoteCardLines,
  renderCard,
  type CardButton,
  type CardButtonStyle,
} from "./cardTemplate.js";
import {
  JoinDecisionMode,
  KeywordPunish,
  type JoinDecisionMode as JoinDecisionModeType,
} from "../core/enums.js";
import { getLogger } from "../core/logger.js";
import type { AuditLog } from "./audit.js";
import type { ActivityCardService } from "./activityCards.js";
import { code as activityCode } from "./activityCards.js";
import { ActivityRuleError } from "./activity.js";
import type {
  Activity,
  ActivityLink,
  ActivityService,
} from "./activity.js";
import type { DisplayNameService } from "./displayNames.js";
import {
  DEFAULT_GROUP_ID,
  type EffectiveGroupConfig,
  type GroupConfigOverride,
  type GroupConfigStore,
} from "./groupConfig.js";
import { findHelpTopic, type HelpTopic } from "./helpTopics.js";
import {
  buildMenu,
  buildUnknownCommandMenu,
  findMenuSection,
  resolveMenuAccess,
  type MenuContext,
} from "./menu.js";
import type { RichMessage } from "./richMessages.js";
import { buildTestMenuCard, TEST_MENU_PAGE_COUNT } from "./testMenu.js";
import type { JoinRuleEvaluator } from "./joinRules.js";
import type { GroupMessageModeRegistry } from "./groupMessageMode.js";
import type { IdentityMapService } from "./identityMap.js";
import type { JoinApprovalService } from "./joinApproval.js";
import { EXPIRY_ACTOR_ID, type JoinAuditService, type JoinRequest } from "./joinAudit.js";
import type { JoinRequestSyncService } from "./joinAuditSync.js";
import { NOTIFY_SCOPE_ALL, type NotificationService } from "./notifications.js";
import type { PermissionService } from "./permissions.js";
import {
  normalizeYear,
  UserProfileError,
  type UserProfileField,
  type UserProfileService,
} from "./userProfiles.js";

const log = getLogger("admin-commands");

/** 通用卡片标题（未单独定制卡片的指令用）。 */
const COMMAND_CARD_TITLES: Record<string, string> = {
  myperm: "我的权限",
  whois: "映射查询",
  bind: "绑定",
  profile: "个人资料",
  activity: "活动",
  perm: "权限配置",
  notify: "入群申请推送",
  audit: "审计记录",
  sync: "同步官方申请",
  approve: "审批结果",
  reject: "审批结果",
  test: "自检结果",
  rules: "群规则",
  pending: "待审批入群申请",
  status: "运行状态",
  help: "指令帮助",
  menu: "系统菜单",
  testmenu: "测试菜单",
};

export interface CommandResult {
  ok: boolean;
  text: string;
  /** 富回复（Markdown + 按钮 + 纯文本降级）；缺省时只发 text。 */
  rich?: RichMessage | undefined;
}

/**
 * 卡片标准下的指令结果（见 `docs/CARD-STANDARD.md`）：**所有指令都必须给出卡片**，
 * 因此 `rich` 在这里是必填的，回调 renderer 可以直接拿它发送。
 */
export interface CardResult {
  ok: boolean;
  text: string;
  rich: RichMessage;
}

export interface AdminCommandServiceOptions {
  permissions: PermissionService;
  joinAudit: JoinAuditService;
  configStore: GroupConfigStore;
  joinApproval: JoinApprovalService;
  joinSync: JoinRequestSyncService;
  auditLog: AuditLog;
  /** 入群规则评估器（用于在 /pending 里给出审核意见）。 */
  joinRules?: JoinRuleEvaluator | undefined;
  groupMessageMode?: GroupMessageModeRegistry | undefined;
  identityMap?: IdentityMapService | undefined;
  /** 展示名解析（群号/QQ号/短码）；缺省时回退到绑定号或内部 id（测试用）。 */
  display?: DisplayNameService | undefined;
  /** 个人资料（班级/学院/姓名/学号）。 */
  userProfiles?: UserProfileService | undefined;
  /** 活动发布/报名/管理。 */
  activity?: ActivityService | undefined;
  /** 活动卡片渲染与发送。 */
  activityCards?: ActivityCardService | undefined;
  /** 入群申请推送（`/notify`）。 */
  notifications?: NotificationService | undefined;
}

export class AdminCommandService {
  private readonly permissions: PermissionService;
  private readonly joinAudit: JoinAuditService;
  private readonly configStore: GroupConfigStore;
  private readonly joinApproval: JoinApprovalService;
  private readonly joinSync: JoinRequestSyncService;
  private readonly auditLog: AuditLog;
  private readonly joinRules: JoinRuleEvaluator | undefined;
  private readonly groupMessageMode: GroupMessageModeRegistry | undefined;
  private readonly identityMap: IdentityMapService | undefined;
  private readonly display: DisplayNameService | undefined;
  private readonly userProfiles: UserProfileService | undefined;
  private readonly activity: ActivityService | undefined;
  private readonly activityCards: ActivityCardService | undefined;
  private readonly notifications: NotificationService | undefined;

  public constructor(options: AdminCommandServiceOptions) {
    this.permissions = options.permissions;
    this.joinAudit = options.joinAudit;
    this.configStore = options.configStore;
    this.joinApproval = options.joinApproval;
    this.joinSync = options.joinSync;
    this.auditLog = options.auditLog;
    this.joinRules = options.joinRules;
    this.groupMessageMode = options.groupMessageMode;
    this.identityMap = options.identityMap;
    this.display = options.display;
    this.userProfiles = options.userProfiles;
    this.activity = options.activity;
    this.activityCards = options.activityCards;
    this.notifications = options.notifications;
  }

  public async handle(
    groupId: string | undefined,
    userId: string,
    text: string,
  ): Promise<CommandResult> {
    const parts = text.trim().split(/\s+/u).filter((part) => part.length > 0);
    if (parts.length === 0) {
      // 空内容（群里 @机器人 不带参数）等价于打开主菜单
      return this.handleMenu(groupId, userId, ["menu"]);
    }
    const command = parts[0]!.replace(/^\//u, "").toLowerCase();
    log.debug("command", { groupId, userId, command });

    const bindingExempt = new Set(["help", "帮助", "bind", "绑定", "menu", "菜单"]);
    // 个人资料与群绑定无关：只需要绑定自己的 QQ 号
    const groupBindingExempt = new Set([...bindingExempt, "profile", "资料"]);
    if (
      !bindingExempt.has(command) &&
      this.identityMap &&
      !this.identityMap.getQq(userId)
    ) {
      log.warn("binding required", { groupId, userId, command });
      return {
        ok: false,
        text: "请先绑定 QQ 号：/bind qq <QQ号>",
      };
    }

    if (
      groupId &&
      !groupBindingExempt.has(command) &&
      this.identityMap &&
      !this.identityMap.getGroupNumber(groupId)
    ) {
      log.warn("group binding required", { groupId, userId, command });
      return {
        ok: false,
        text: "请先绑定本群：/bind group <群号>",
      };
    }

    const result = await this.dispatchCommand(command, groupId, userId, parts);
    return this.ensureCard(command, result, groupId, userId);
  }

  /**
   * 卡片标准兜底：**任何指令输出都必须是卡片**。
   *
   * 已经单独实现卡片的指令（help/status/pending/rules/audit/test/sync/审批/notify/menu…）
   * 直接返回自己的 `rich`；其余指令（包括用法提示、错误提示）在这里包成统一卡片，
   * 正文沿用原文本（纯文本降级等价），并附上常用入口按钮。
   * 后续为这些指令做定制卡时，替换掉各自的 handler 即可。
   */
  private ensureCard(
    command: string,
    result: CommandResult,
    groupId: string | undefined,
    userId: string,
  ): CommandResult {
    if (result.rich) {
      return result;
    }
    const title = COMMAND_CARD_TITLES[command] ?? "指令结果";
    const nav: CardButton[] = [];
    if (groupId) {
      nav.push(viewButton("pending", "待审批", "pending", "page", groupId, 1));
      nav.push(viewButton("rules", "群规则", "rules", "view", groupId));
    }
    nav.push(viewButton("help", "指令帮助", "help", "home"));
    const card = cardFromText(title, result.text, {
      rows: [nav],
      ...(groupId ? { buttonHint: "常用入口：" } : {}),
      footer: ["按钮不可用时可直接输入指令。"],
    });
    return { ok: result.ok, text: card.text, rich: card.rich };
  }

  /**
   * 定制卡包装：用指定标题、按钮与页脚包装已有指令结果。
   *
   * 正文沿用 `result.text`，因此**纯文本降级与旧输出等价**；已经自带卡片的直接返回。
   * 这样给某条指令做"定制布局"时不需要改它的业务逻辑。
   */
  private cardify(
    title: string,
    result: CommandResult,
    rows: readonly (readonly CardButton[])[],
    footer: readonly string[] = ["按钮不可用时可直接输入指令。"],
    buttonHint = "相关入口：",
  ): CommandResult {
    if (result.rich) {
      return result;
    }
    const card = cardFromText(title, result.text, { rows, footer, buttonHint });
    return { ok: result.ok, text: card.text, rich: card.rich };
  }

  /** 定制卡包装（异步结果版：handler 是 async 时用）。 */
  private async cardifyAsync(
    title: string,
    result: Promise<CommandResult>,
    rows: readonly (readonly CardButton[])[],
    footer?: readonly string[],
    buttonHint?: string,
  ): Promise<CommandResult> {
    return this.cardify(title, await result, rows, footer, buttonHint);
  }

  /** 指令分发表（返回值统一交给 `ensureCard` 保证是卡片）。 */
  private async dispatchCommand(
    command: string,
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    switch (command) {
      case "help":
      case "帮助":
        return this.handleHelp(groupId, userId, parts);
      case "menu":
      case "菜单":
        return this.handleMenu(groupId, userId, parts);
      case "myperm":
      case "我的权限":
        return this.cardify(
          "我的权限",
          this.handleMyPermission(groupId, userId),
          [
            [
              viewButton("profile", "我的资料", "cmd", "run", "/profile"),
              viewButton("activity", "活动", "activity", "page", groupId ?? "", 1),
              viewButton("help", "指令帮助", "help", "home"),
            ],
          ],
          ["手动指令：/myperm · /profile · /activity · /help"],
        );
      case "bind":
      case "绑定":
        return this.cardifyAsync(
          "绑定",
          this.handleBind(groupId, userId, parts),
          [
            [
              viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
              viewButton("help", "绑定帮助", "help", "topic", "bind"),
            ],
          ],
          ["手动指令：/bind qq <QQ号> · /bind group <群号>"],
        );
      case "whois":
      case "查询":
        return this.cardify(
          "映射查询",
          this.handleWhois(groupId, userId, parts),
          [
            [
              viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
              viewButton("help", "查询帮助", "help", "topic", "whois"),
            ],
          ],
          ["手动指令：/whois [目标]（不填 = 当前群 / 你自己）"]
        );
      case "perm":
      case "权限":
        return this.cardify(
          "权限配置",
          this.handlePermissionConfig(groupId, userId, parts),
          [
            [
              viewButton("help", "权限帮助", "help", "topic", "perm"),
              viewButton("myperm", "我的权限", "cmd", "run", "/myperm"),
            ],
          ],
          ["手动指令：/perm list · /perm grant <角色> <userId|QQ号> · /perm revoke <角色> <userId|QQ号>"],
        );
      case "pending":
      case "待审批":
        return this.handlePending(groupId, userId, parts);
      case "sync":
      case "同步":
        return this.handleSync(groupId, userId, parts);
      case "notify":
      case "push":
      case "推送":
      case "订阅":
        return this.handleNotify(groupId, userId, parts);
      case "profile":
      case "资料":
        return this.cardify(
          "个人资料",
          this.handleProfile(userId, parts),
          [
            [
              viewButton("activity", "活动", "activity", "page", groupId ?? "", 1),
              viewButton("help", "资料帮助", "help", "topic", "profile"),
            ],
          ],
          ["手动指令：/profile set <字段> <值> · /profile clear"],
        );
      case "activity":
      case "活动":
        return this.handleActivity(groupId, userId, parts);
      case "approve":
      case "通过":
        return this.handleApprove(groupId, userId, parts);
      case "reject":
      case "拒绝":
        return this.handleReject(groupId, userId, parts);
      case "rules":
      case "规则":
        return this.handleRules(groupId, userId, parts);
      case "audit":
      case "日志":
        return this.handleAudit(groupId, userId, parts);
      case "status":
      case "状态":
        return this.handleStatus(groupId, userId, parts);
      case "test":
      case "测试":
        return this.handleTest(groupId, userId);
      case "testmenu":
        return this.handleTestMenu(userId, parts);
      default:
        return this.unknownCommandResult(groupId, userId, parts[0]);
    }
  }

  private async handleBind(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const target = normalize(parts[1]);
    if (!target) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "/bind qq <QQ号>\n" +
          "/bind group <群号>\n" +
          "/bind user <userId> <QQ号>（超管）\n" +
          "/bind groupid <group_openid> <群号>（超管）",
      };
    }

    if (target === "qq") {
      const qq = parts[2]?.trim();
      if (!qq) {
        return { ok: false, text: "用法：/bind qq <QQ号>" };
      }
      try {
        await this.identityMap?.bindUser(userId, qq);
      } catch (error) {
        log.error("bind user qq failed", {
          userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound user qq", { userId, qq });
      return {
        ok: true,
        text: `已绑定：QQ ${qq}`,
      };
    }

    if (target === "group") {
      const groupNumber = parts[2]?.trim();
      if (!groupId || !groupNumber) {
        return {
          ok: false,
          text: "该指令需要在群内使用。用法：/bind group <群号>",
        };
      }
      if (
        !this.permissions.canApproveJoin(userId, groupId) &&
        !this.permissions.isSuperAdmin(userId)
      ) {
        return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
      }
      try {
        await this.identityMap?.bindGroup(groupId, groupNumber);
      } catch (error) {
        log.error("bind group number failed", {
          groupId,
          userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound group number", { groupId, groupNumber, userId });
      return {
        ok: true,
        text: `已绑定：群号 ${groupNumber}`,
      };
    }

    if (target === "user") {
      if (!this.permissions.isSuperAdmin(userId)) {
        return { ok: false, text: "权限不足：仅超级管理员可以绑定任意用户。" };
      }
      const officialId = parts[2]?.trim();
      const qq = parts[3]?.trim();
      if (!officialId || !qq) {
        return { ok: false, text: "用法：/bind user <userId> <QQ号>" };
      }
      try {
        await this.identityMap?.bindUser(officialId, qq);
      } catch (error) {
        log.error("bind user failed", {
          officialId,
          operator: userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound user qq", { officialId, qq, operator: userId });
      return {
        ok: true,
        text: `已绑定：QQ ${qq}`,
      };
    }

    if (target === "groupid") {
      if (!this.permissions.isSuperAdmin(userId)) {
        return { ok: false, text: "权限不足：仅超级管理员可以绑定任意群。" };
      }
      const officialId = parts[2]?.trim();
      const groupNumber = parts[3]?.trim();
      if (!officialId || !groupNumber) {
        return { ok: false, text: "用法：/bind groupid <group_openid> <群号>" };
      }
      try {
        await this.identityMap?.bindGroup(officialId, groupNumber);
      } catch (error) {
        log.error("bind group failed", {
          officialId,
          operator: userId,
          error: formatError(error),
        });
        return { ok: false, text: bindingFailureText() };
      }
      log.info("bound group number", {
        officialId,
        groupNumber,
        operator: userId,
      });
      return {
        ok: true,
        text: `已绑定：群号 ${groupNumber}`,
      };
    }

    return {
      ok: false,
      text:
        "未知绑定类型。用法：\n" +
        "/bind qq <QQ号>\n" +
        "/bind group <群号>\n" +
        "/bind user <userId> <QQ号>（超管）\n" +
        "/bind groupid <group_openid> <群号>（超管）",
    };
  }

  private handleWhois(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: "权限不足：仅超级管理员可以查询映射。" };
    }
    if (!this.identityMap) {
      return { ok: false, text: "映射服务未启用。" };
    }
    const input = parts[1]?.trim();
    if (!input) {
      // 不带参数：直接查当前上下文 —— 群聊查当前群，私聊查你自己
      if (groupId) {
        const groupNumber =
          this.identityMap.getGroupNumber(groupId) ?? "（未绑定）";
        const shortCode = this.display
          ? `\n短码：${this.display.group(groupId)}`
          : "";
        return {
          ok: true,
          text: `类型：群（当前群）\n群 ID：${groupId}\n群号：${groupNumber}${shortCode}`,
        };
      }
      const qq = this.identityMap.getQq(userId) ?? "（未绑定）";
      const shortCode = this.display
        ? `\n短码：${this.display.user(userId)}`
        : "";
      return {
        ok: true,
        text: `类型：用户（你自己）\nuserId：${userId}\nQQ：${qq}${shortCode}`,
      };
    }

    // `#短码`：唯一允许查看真实系统 id 的入口
    const code = this.display?.resolveCode(input);
    if (code) {
      const label = `#${code.code}`;
      if (code.kind === "join_request") {
        const lines = [
          "类型：入群申请",
          `短码：${label}`,
          `真实申请 ID：${code.targetId}`,
        ];
        if (this.joinAudit.has(code.targetId)) {
          const request = this.joinAudit.get(code.targetId);
          lines.push(
            `群：${this.displayGroup(request.groupId)}`,
            `申请人：${this.displayUser(request.userId)}`,
            `理由：${request.reason || "（未填写）"}`,
            `状态：${request.status}`,
            `申请时间：${formatTime(request.createdAt)}`,
          );
          if (request.reviewedAt) {
            lines.push(`处理时间：${formatTime(request.reviewedAt)}`);
          }
          if (request.reviewerId) {
            lines.push(
              `处理人：${
                request.reviewerId === EXPIRY_ACTOR_ID
                  ? "系统（自动过期）"
                  : request.reviewerId === "bot:auto"
                    ? "机器人（按入群规则自动处理）"
                    : this.displayUser(request.reviewerId)
              }`,
            );
          }
          lines.push(
            request.status === "pending"
              ? "本地队列：待审批中"
              : "本地队列：已不在队列（/pending 不会显示）",
          );
        } else {
          lines.push("本地队列：无记录（可能已被保留策略清理）");
        }
        return { ok: true, text: lines.join("\n") };
      }
      if (code.kind === "user") {
        const qq = this.identityMap.getQq(code.targetId);
        return {
          ok: true,
          text:
            `类型：用户\n短码：${label}\n真实 userId：${code.targetId}\n` +
            `QQ：${qq ?? "（未绑定）"}`,
        };
      }
      const groupNumber = this.identityMap.getGroupNumber(code.targetId);
      return {
        ok: true,
        text:
          `类型：群\n短码：${label}\n真实 group_openid：${code.targetId}\n` +
          `群号：${groupNumber ?? "（未绑定）"}`,
      };
    }

    const resolvedUserId = this.identityMap.resolveUserId(input);
    if (resolvedUserId) {
      const qq = this.identityMap.getQq(resolvedUserId) ?? "（未绑定）";
      const shortCode = this.display
        ? `\n短码：${this.display.user(resolvedUserId)}`
        : "";
      return {
        ok: true,
        text: `类型：用户\nuserId：${resolvedUserId}\nQQ：${qq}${shortCode}`,
      };
    }
    const resolvedGroupId = this.identityMap.resolveGroupId(input);
    if (resolvedGroupId) {
      const groupNumber =
        this.identityMap.getGroupNumber(resolvedGroupId) ?? "（未绑定）";
      const shortCode = this.display
        ? `\n短码：${this.display.group(resolvedGroupId)}`
        : "";
      return {
        ok: true,
        text: `类型：群\n群 ID：${resolvedGroupId}\n群号：${groupNumber}${shortCode}`,
      };
    }
    return { ok: false, text: "未找到映射。" };
  }

  /**
   * 解析审批目标（`/approve`、`/reject` 共用）：
   *
   * - 群内：`/approve <申请>`；
   * - 私信带群：`/approve <群号|#群短码> <申请>`；
   * - 私信不带群：`/approve <申请>`，从本地申请记录反查所属群（短码唯一即可定位）。
   */
  private resolveReviewTarget(
    groupId: string | undefined,
    parts: readonly string[],
  ): {
    targetGroupId: string | undefined;
    requestId: string | undefined;
    reasonParts: readonly string[];
  } {
    if (groupId) {
      return {
        targetGroupId: groupId,
        requestId: this.resolveRequestId(parts[1]),
        reasonParts: parts.slice(2),
      };
    }
    const groupFromFirst = this.resolveTargetGroupId(undefined, parts[1]);
    if (groupFromFirst) {
      return {
        targetGroupId: groupFromFirst,
        requestId: this.resolveRequestId(parts[2]),
        reasonParts: parts.slice(3),
      };
    }
    const requestId = this.resolveRequestId(parts[1]);
    let targetGroupId: string | undefined;
    if (requestId) {
      try {
        targetGroupId = this.joinAudit.get(requestId).groupId;
      } catch {
        targetGroupId = undefined;
      }
    }
    return { targetGroupId, requestId, reasonParts: parts.slice(2) };
  }

  private resolveUserId(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    // `#短码` 优先；否则按 QQ号/openid 解析
    const fromCode = this.display?.resolveUser(trimmed);
    if (fromCode) {
      return fromCode;
    }
    return this.identityMap?.resolveUserId(trimmed) ?? trimmed;
  }

  private resolveTargetGroupId(
    groupId: string | undefined,
    input: string | undefined,
  ): string | undefined {
    if (groupId) {
      return groupId;
    }
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    const fromCode = this.display?.resolveGroup(trimmed);
    if (fromCode) {
      return fromCode;
    }
    if (!this.identityMap) {
      return trimmed;
    }
    return this.identityMap.resolveGroupId(trimmed);
  }

  /** 申请参数：`#短码`（推荐）或完整 join_request_id。 */
  private resolveRequestId(input: string | undefined): string | undefined {
    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }
    return this.display?.resolveRequest(trimmed) ?? trimmed;
  }

  /**
   * `/help` 列出有权限执行的指令；`/help <主题>` 展示该指令的详细用法。
   *
   * 主题详情同样做权限过滤：无权限时只提示所需权限，不展示具体命令，
   * 与「/help 只显示有权限执行的指令」保持一致。
   */
  /** 主菜单富消息（首次私信推送与未知指令回复复用）。 */
  public mainMenu(groupId: string | undefined, userId: string): RichMessage {
    return buildMenu("main", this.menuContext(groupId, userId)).message;
  }

  /** 回调 renderer 用：渲染菜单的某一级（`cb:menu:open:<section>`）。 */
  public menuMessage(
    section: string | undefined,
    groupId: string | undefined,
    userId: string,
  ): RichMessage {
    return buildMenu(
      findMenuSection(section) ?? "main",
      this.menuContext(groupId, userId),
    ).message;
  }

  /**
   * `/help [主题]`：指令列表卡 / 主题详情卡。
   *
   * 正文沿用原来的帮助文本（纯文本降级因此与旧输出等价），按钮按标准分类：
   * 菜单入口与主题查看都是**回调**（点击即出卡），无需用户再发指令。
   */
  public helpCard(
    groupId: string | undefined,
    userId: string,
    topicQuery?: string,
  ): CardResult {
    const access = resolveMenuAccess(this.menuContext(groupId, userId));
    /** 完整指令列表卡（正文沿用 buildHelp，含未绑定/未绑群提示）。 */
    const listCard = (): CardResult => {
      const card = renderCard({
        title: "全部可用指令",
        lines: this.buildHelp(groupId, userId).split("\n"),
        rows: [[viewButton("home", "返回帮助", "help", "home")]],
        footer: ["某个指令的详细用法：/help <指令>"],
      });
      return { ok: true, text: card.text, rich: card };
    };
    const isBound = this.identityMap
      ? Boolean(this.identityMap.getQq(userId))
      : true;
    const groupBound =
      groupId === undefined || !this.identityMap
        ? true
        : Boolean(this.identityMap.getGroupNumber(groupId));

    if (!topicQuery) {
      // 未绑定 QQ 号 / 本群未绑定：直接给完整列表卡，正文里带绑定提示
      if (!isBound || !groupBound) {
        return listCard();
      }
      // 伞形卡：只给分类入口，完整列表在 `/help all`（避免一张卡 30 行）
      const menuRow: CardButton[] = [
        viewButton("sys", "系统菜单", "menu", "open", "sys"),
      ];
      if (access.canModerate) {
        menuRow.push(viewButton("admin", "管理菜单", "menu", "open", "admin"));
      }
      if (access.isSuperAdmin) {
        menuRow.push(viewButton("super", "超管菜单", "menu", "open", "super"));
      }
      const card = renderCard({
        title: "指令帮助",
        lines: [
          "按分类查看你有权限使用的指令。",
          "完整指令列表：/help all",
        ],
      rows: [
        menuRow,
        [
          viewButton("all", "全部指令", "help", "list"),
          viewButton("topic-rules", "群规则", "help", "topic", "rules"),
          viewButton("topic-approve", "审批", "help", "topic", "approve"),
        ],
        [
          viewButton("topic-bind", "绑定", "help", "topic", "bind"),
          viewButton("topic-menu", "菜单", "help", "topic", "menu"),
        ],
      ],
        buttonHint: "请选择分类：",
        footer: ["某个指令的详细用法：/help <指令>"],
      });
      return { ok: true, text: card.text, rich: card };
    }

    if (topicQuery === "all" || topicQuery === "全部") {
      return listCard();
    }

    const topic = findHelpTopic(topicQuery);
    if (!topic) {
      const card = renderCard({
        title: "指令帮助",
        lines: [
          `未找到「${topicQuery}」的帮助。`,
          "用法：/help <指令>，例如 /help rules、/help bind、/help perm",
          "",
          ...this.buildHelp(groupId, userId).split("\n"),
        ],
        rows: [[viewButton("home", "返回帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const context = {
      permissions: this.permissions,
      configStore: this.configStore,
      identityMap: this.identityMap,
      groupId,
      userId,
    };
    if (!topic.allows(context)) {
      const card = renderCard({
        title: "权限不足",
        lines: [
          `/${topic.name} 需要${topic.requirement}。`,
          "权限由全局超级管理员通过 /perm 配置。",
        ],
        rows: [[viewButton("home", "返回帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const rows: CardButton[] = [viewButton("home", "返回帮助", "help", "home")];
    if (topic.name === "rules" && groupId) {
      rows.unshift(
        viewButton("view", "查看当前规则", "rules", "view", groupId),
      );
    }
    if (topic.name === "menu") {
      rows.unshift(viewButton("menu", "打开菜单", "menu", "open", "main"));
    }
    const card = renderCard({
      title: `/${topic.name} · ${topic.title}`,
      lines: this.renderHelpTopic(topic, context).split("\n"),
      rows: [rows],
      buttonHint: "相关入口：",
    });
    return { ok: true, text: card.text, rich: card };
  }

  /** `/status <群号|#群短码>`：运行状态卡 + 常用入口。 */
  public statusCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CardResult {
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "运行状态",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/status <群号|#群短码>",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const config = this.configStore.get(targetGroupId);
    const text = [
      `群 ${this.displayGroup(targetGroupId)} 状态：`,
      `机器人启用：${config.enabled}`,
      `消息过滤：${config.wordFilterEnabled}`,
      `全量消息模式：${this.groupMessageMode?.get(targetGroupId) ?? "unknown"}`,
      `入群审核：${config.joinAuditEnabled}`,
      `导出功能：${config.exportEnabled}`,
      `禁言时长：${config.muteDurationSeconds} 秒`,
    ].join("\n");
    return cardFromText("运行状态", text, {
      rows: [
        [
          viewButton("refresh", "刷新", "status", "view", targetGroupId),
          viewButton("pending", "待审批", "pending", "page", targetGroupId, 1),
          viewButton("rules", "群规则", "rules", "view", targetGroupId),
        ],
        [
          viewButton("help", "指令帮助", "help", "home"),
          actionButton("test", "自检", "/test"),
        ],
      ],
      buttonHint: "常用入口：",
      footer: [`刷新：/status`, `本群：${this.displayGroup(targetGroupId)}`],
    });
  }

  /**
   * `/pending [群号|#群短码] [+页码]`：待审批列表卡。
   *
   * 每页 3 条（含审核意见会占多行），每条给「通过 / 拒绝」**指令按钮**（走正常审批权限
   * 与二次确认），翻页用**回调按钮**；纯文本降级给出 `/pending +<页码>` 指令。
   */
  public pendingCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    notice?: string,
  ): CardResult {
    const { page, rest } = extractPageToken(parts);
    const targetGroupId = this.resolveTargetGroupId(groupId, rest[0]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "待审批入群申请",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/pending <群号|#群短码> [+页码]",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const groupLabel = this.displayGroup(targetGroupId);
    const pending = this.joinAudit.pending(targetGroupId);
    if (pending.length === 0) {
      return cardFromText(
        "待审批入群申请",
        [
          ...(notice ? [notice] : []),
          `群 ${groupLabel}：当前没有待审批入群申请。`,
        ].join("\n"),
        {
          rows: [
            [viewButton("refresh", "刷新", "pending", "page", targetGroupId, 1)],
          ],
          footer: [`本群：${groupLabel}`],
        },
      );
    }

    const pageSize = 3;
    const pageCount = Math.max(1, Math.ceil(pending.length / pageSize));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = pending.slice((current - 1) * pageSize, current * pageSize);
    const config = this.configStore.get(targetGroupId);
    const withOpinion =
      config.joinReviewOpinion && this.joinRules !== undefined;

    const lines = [
      `**群**：${groupLabel}`,
      `**待审批**：${pending.length} 条 · 第 ${current} / ${pageCount} 页`,
      ...(notice ? [`**结果**：${escapeCardText(notice)}`] : []),
    ];
    const rows: CardButton[][] = [];
    for (const request of slice) {
      const code = this.displayRequest(request.requestId);
      lines.push(
        "",
        `**${escapeCardText(code)}** · 申请人：${escapeCardText(this.displayUser(request.userId))}`,
        `理由：${escapeCardText(request.reason) || "（未填写）"}`,
      );
      if (withOpinion) {
        const evaluation = this.joinRules?.evaluate(request.reason, {
          mode: config.joinDecision,
          requireClass: config.joinRequireClass,
          requireName: config.joinRequireName,
          answerPattern: config.joinAnswerPattern,
          opinionEnabled: true,
        });
        if (evaluation?.opinion) {
          lines.push(...quoteCardLines(evaluation.opinion));
        }
      }
      rows.push([
        // 「通过」是固定动作（无需参数）→ 回调自动完成，并回一张刷新后的列表
        {
          ...viewButton(
            `approve-${code}`,
            "通过",
            "pending",
            "approve",
            targetGroupId,
            request.requestId,
            current,
          ),
          style: 1,
        },
        // 「拒绝」支持可选原因 → 保留指令按钮，用户可在发送前补上原因
        actionButton(`reject-${code}`, "拒绝", `/reject ${code}`, {
          style: 3,
          modal: {
            content: "确认拒绝该入群申请？（可先补上原因）",
            confirmText: "拒绝",
            cancelText: "取消",
          },
        }),
      ]);
    }

    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "pending", "page", targetGroupId, current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "pending", "page", targetGroupId, current + 1),
      );
    }
    paging.push(
      viewButton("refresh", "刷新", "pending", "page", targetGroupId, current),
    );
    rows.push(paging);

    const footer: string[] = [];
    if (current < pageCount) {
      footer.push(`下一页：/pending +${current + 1}`);
    }
    if (current > 1) {
      footer.push(`上一页：/pending +${current - 1}`);
    }
    footer.push("审批：/approve <申请ID> · /reject <申请ID> [原因]");

    return cardFromText("待审批入群申请", lines.join("\n"), {
      rows,
      buttonHint: "点击审批：",
      footer,
    });
  }

  /**
   * 回调：固定动作「通过入群申请」。
   *
   * 无需参数，因此走回调自动完成：校验权限 → 调官方审批接口 → 回一张**刷新后的**列表卡
   * （带「已通过 #短码」结果行）。拒绝因为支持可选原因，仍然是指令按钮。
   */
  public async approveCard(
    targetGroupId: string,
    requestId: string,
    userId: string,
    page = 1,
  ): Promise<CardResult> {
    const back = viewButton("back", "返回待审批", "pending", "page", targetGroupId, page);
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["通过入群申请需要群管理员或以上权限。"],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        const card = renderCard({
          title: "审批失败",
          lines: ["申请不属于该群。"],
          rows: [[back]],
        });
        return { ok: false, text: card.text, rich: card };
      }
      await this.joinApproval.approve(targetGroupId, requestId, userId);
    } catch (error) {
      log.warn("approve via callback failed", {
        requestId,
        error: formatError(error),
      });
      const card = renderCard({
        title: "审批失败",
        lines: [formatError(error)],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("approved join request via callback", { requestId, userId });
    return this.pendingCard(
      undefined,
      userId,
      ["pending", targetGroupId, `+${page}`],
      `已通过 ${this.displayRequest(requestId)} · 操作人：${this.displayUser(userId)}`,
    );
  }

  /**
   * `/rules [群号|#群短码]`：群规则卡。
   *
   * 查看是回调；开关类改动是**指令按钮**（`/rules set <字段> <值>`），
   * 与手输指令走同一条权限与持久化路径。
   */
  public rulesCard(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
    notice?: string,
  ): CardResult {
    if (isGlobalTarget(parts[1])) {
      return this.globalRulesCard(userId);
    }
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      if (!parts[1] && this.permissions.isSuperAdmin(userId)) {
        return this.globalRulesCard(userId);
      }
      const card = renderCard({
        title: "群规则",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/rules <群号|#群短码>；全局默认规则：/rules all",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限（查看）／群管理员或以上（修改）。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const config = this.configStore.get(targetGroupId);
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);

    // 概览卡：只放按钮没覆盖的信息 + 设置入口（开关/枚举在子卡里，避免卡片过挤）
    const rows: CardButton[][] = [];
    if (canManage) {
      rows.push([
        viewButton("panel-toggle", "开关设置", "rules", "panel", targetGroupId, "toggle"),
        viewButton("panel-decision", "入群决策", "rules", "panel", targetGroupId, "decision"),
        viewButton("panel-punish", "命中处罚", "rules", "panel", targetGroupId, "punish"),
      ]);
    }
    const lastRow: CardButton[] = [
      viewButton("view", "刷新", "rules", "view", targetGroupId),
      viewButton("help", "规则帮助", "help", "topic", "rules"),
    ];
    if (this.permissions.isSuperAdmin(userId)) {
      lastRow.unshift(viewButton("global", "全局规则", "rules", "all"));
    }
    rows.push(lastRow);

    const lines = [
      `**关键词**：${config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）"}`,
      `**警告文案**：${config.warningMessage}`,
      `**禁言时长**：${config.muteDurationSeconds} 秒`,
      `**入群要求**：班级 ${config.joinRequireClass} · 姓名 ${config.joinRequireName} · 审核意见 ${config.joinReviewOpinion}`,
      `**导出功能**：${config.exportEnabled ? "开" : "关"}（当前仅存储展示）`,
      `**机器人启用**：${config.enabled ? "开" : "关"}`,
    ];

    return cardFromText(
      "群规则",
      [
        ...(notice ? [`**结果**：${escapeCardText(notice)}`] : []),
        ...lines,
      ].join("\n"),
      {
        rows,
        buttonHint: canManage ? "设置入口（点击即生效）：" : "相关入口：",
        footer: [
          `本群：${this.displayGroup(targetGroupId)}`,
          "自由文本/数值仍用指令：/rules set <字段> <值>（keywords / warning / muteDuration ...）",
          "完整字段用法：/help rules",
        ],
      },
    );
  }

  /**
   * `/activity [list] [群号] [+页码]`：活动列表卡。
   *
   * 每页 3 个活动（每个一行按钮：报名 / 详情 / 名单），翻页是回调；
   * 手动翻页用 `/activity list +<页码>`（`+` 前缀与群号区分）。
   */
  public activityListCard(
    targetGroupId: string,
    userId: string,
    page = 1,
    notice?: string,
  ): CardResult {
    const list = this.activity!.listActivities(targetGroupId);
    const groupLabel = this.displayGroup(targetGroupId);
    if (list.length === 0) {
      return cardFromText(
        "活动列表",
        [...(notice ? [notice] : []), `群 ${groupLabel} 还没有活动。`].join("\n"),
        {
          rows: [
            [viewButton("refresh", "刷新", "activity", "page", targetGroupId, 1)],
          ],
          footer: [
            "创建活动：/activity create <标题>（群管理员或以上）",
            `本群：${groupLabel}`,
          ],
        },
      );
    }

    const size = 3;
    const pageCount = Math.max(1, Math.ceil(list.length / size));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = list.slice((current - 1) * size, current * size);
    const lines = [
      ...(notice ? [`**结果**：${escapeCardText(notice)}`] : []),
      `**群**：${groupLabel}`,
      `**活动**：${list.length} 个 · 第 ${current} / ${pageCount} 页`,
      "",
    ];
    const rows: CardButton[][] = [];
    for (const activity of slice) {
      const count = this.activity!.listRegistrations(activity.activityId).length;
      const code = activityCode(activity);
      lines.push(
        `**${escapeCardText(code)}** ${escapeCardText(activity.title)} [${activity.status}] 报名 ${count}${
          activity.capacity ? `/${activity.capacity}` : ""
        }`,
      );
      rows.push([
        actionButton(`join-${code}`, "报名", `/activity join ${code}`),
        actionButton(`info-${code}`, "详情", `/activity info ${code}`),
        actionButton(`signups-${code}`, "名单", `/activity signups ${code}`),
      ]);
    }

    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "activity", "page", targetGroupId, current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "activity", "page", targetGroupId, current + 1),
      );
    }
    paging.push(
      viewButton("refresh", "刷新", "activity", "page", targetGroupId, current),
    );
    rows.push(paging);

    const footer: string[] = [];
    if (current < pageCount) {
      footer.push(`下一页：/activity list +${current + 1}`);
    }
    if (current > 1) {
      footer.push(`上一页：/activity list +${current - 1}`);
    }
    footer.push("报名需要资料完整：/profile");

    return cardFromText("活动列表", lines.join("\n"), {
      rows,
      buttonHint: "点击操作：",
      footer,
    });
  }

  /**
   * `/notify`：入群申请推送订阅卡。
   *
   * 订阅开关是**回调**（固定动作，点击即订阅/退订并回一张带操作人的卡），
   * 「测试推送」也是回调（固定动作，触发一次自检卡片）。
   */
  public notifyCard(
    groupId: string | undefined,
    userId: string,
    notice?: string,
  ): CardResult {
    if (!this.notifications) {
      const card = renderCard({
        title: "入群申请推送",
        lines: ["推送服务未启用。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const scopes = this.notifications.listScopes(userId);
    const allOn = scopes.includes(NOTIFY_SCOPE_ALL);
    const lines = [
      ...(notice ? [`**结果**：${escapeCardText(notice)}`] : []),
      `**全部群**：${allOn ? "已开启" : "未开启"}`,
    ];
    if (groupId) {
      lines.push(
        `**当前群**：${scopes.includes(groupId) ? "已开启" : "未开启"}（${this.groupLabel(groupId)}）`,
      );
    }
    for (const scope of scopes.filter((item) => item !== NOTIFY_SCOPE_ALL)) {
      lines.push(`**已订阅**：群 ${this.groupLabel(scope)}`);
    }
    const reviewable = this.permissions.listReviewableGroups(userId);
    lines.push(
      reviewable.length > 0
        ? `**可审批的群**：${reviewable.map((id) => this.groupLabel(id)).join("、")}`
        : "**可审批的群**：无（入群审批需要群管理员或以上权限）",
    );
    lines.push("", "订阅后：有新的待人工处理申请会私聊推送卡片，可直接点按钮审批。");

    const rows: CardButton[][] = [];
    const switchRow: CardButton[] = [];
    if (groupId) {
      switchRow.push(
        viewButton(
          "thisGroup",
          `本群 ${scopes.includes(groupId) ? "关" : "开"}`,
          "notify",
          "toggle",
          groupId,
          scopes.includes(groupId) ? "off" : "on",
        ),
      );
    }
    switchRow.push(
      viewButton(
        "allGroups",
        `全部群 ${allOn ? "关" : "开"}`,
        "notify",
        "toggle",
        NOTIFY_SCOPE_ALL,
        allOn ? "off" : "on",
      ),
    );
    rows.push(switchRow);
    rows.push([
      viewButton("test", "测试推送", "notify", "test", groupId ?? ""),
      viewButton("refresh", "刷新", "notify", "view"),
    ]);

    return cardFromText("入群申请推送", lines.join("\n"), {
      rows,
      buttonHint: "点击即生效：",
      footer: [
        "手动等价指令：/notify on|off · /notify all on|off · /notify <群号> on|off · /notify test",
      ],
    });
  }

  /** 回调：订阅开关（固定动作 → 自动生效并回刷新后的卡片）。 */
  public async notifyToggleCard(
    scope: string,
    enabled: boolean,
    userId: string,
  ): Promise<CardResult> {
    if (!this.notifications) {
      return this.notifyCard(undefined, userId);
    }
    const result = this.applyNotify(userId, scope, enabled);
    const groupContext = scope === NOTIFY_SCOPE_ALL ? undefined : scope;
    if (!result.ok) {
      const card = renderCard({
        title: "推送未修改",
        lines: [result.text],
        rows: [
          [
            viewButton(
              "back",
              "返回推送设置",
              "notify",
              "view",
            ),
          ],
        ],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("notify scope updated via callback", { scope, enabled, userId });
    return this.notifyCard(
      groupContext,
      userId,
      `${result.text.split("\n")[0]} · 操作人：${this.displayUser(userId)}`,
    );
  }

  /** 回调：测试推送（固定动作 → 直接给自己发一张测试卡并回结果）。 */
  public async notifyTestCard(
    groupId: string | undefined,
    userId: string,
  ): Promise<CardResult> {
    if (!this.notifications) {
      return this.notifyCard(groupId, userId);
    }
    const result = await this.notifications.sendTestCard(userId, groupId);
    const notice = `${result.text.split("\n")[0]} · 操作人：${this.displayUser(userId)}`;
    const card = this.notifyCard(groupId, userId, notice);
    return { ...card, ok: result.ok };
  }

  /**
   * `/audit [群号|#群短码] [每页数量] [+页码]`：审计记录卡。
   *
   * 正文沿用原格式（时间 / 动作 / 状态 / 操作人 / 对象），翻页为回调，
   * 纯文本降级给出 `/audit +<页码>`。
   */
  public auditCard(
    targetGroupId: string,
    userId: string,
    page = 1,
    limit = 20,
  ): CardResult {
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const groupLabel = this.displayGroup(targetGroupId);
    const size = limit > 0 ? limit : 20;
    // 最新的记录在前
    const all = this.auditLog.findByGroup(targetGroupId).slice().reverse();
    if (all.length === 0) {
      return cardFromText("审计记录", `群 ${groupLabel}：暂无审计记录。`, {
        rows: [
          [viewButton("refresh", "刷新", "audit", "page", targetGroupId, size, 1)],
        ],
        footer: [`本群：${groupLabel}`],
      });
    }
    const pageCount = Math.max(1, Math.ceil(all.length / size));
    const current = Math.min(Math.max(page, 1), pageCount);
    const slice = all.slice((current - 1) * size, current * size);
    const lines = [
      `**群**：${groupLabel}`,
      `**审计记录**：${all.length} 条 · 第 ${current} / ${pageCount} 页（每页 ${size}）`,
    ];
    for (const record of slice) {
      const target = record.targetUserId
        ? ` → ${this.displayUser(record.targetUserId)}`
        : "";
      lines.push(
        `${formatTime(record.createdAt)} ${record.action} ${record.status}${
          record.actorId ? ` by ${this.displayUser(record.actorId)}` : ""
        }${target}`,
      );
    }
    const paging: CardButton[] = [];
    if (current > 1) {
      paging.push(
        viewButton("prev", "上一页", "audit", "page", targetGroupId, size, current - 1),
      );
    }
    if (current < pageCount) {
      paging.push(
        viewButton("next", "下一页", "audit", "page", targetGroupId, size, current + 1),
      );
    }
    paging.push(
      viewButton("refresh", "刷新", "audit", "page", targetGroupId, size, current),
    );
    const footer: string[] = [];
    if (current < pageCount) {
      footer.push(`下一页：/audit +${current + 1}`);
    }
    if (current > 1) {
      footer.push(`上一页：/audit +${current - 1}`);
    }
    footer.push(`本群：${groupLabel}`);
    return cardFromText("审计记录", lines.join("\n"), {
      rows: [paging],
      buttonHint: "翻页：",
      footer,
    });
  }

  /** `/test`：自检结果卡 + 常用入口。 */
  public testCard(groupId: string | undefined, userId: string): CardResult {
    if (!this.permissions.canReviewContent(userId, groupId ?? "")) {
      log.warn("test permission denied", { groupId, userId });
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("test command", { groupId, userId });
    const rows: CardButton[][] = [];
    if (groupId) {
      rows.push([
        viewButton("refresh", "刷新", "test", "view", groupId),
        viewButton("pending", "待审批", "pending", "page", groupId, 1),
        viewButton("rules", "群规则", "rules", "view", groupId),
      ]);
    } else {
      rows.push([viewButton("help", "指令帮助", "help", "home")]);
    }
    const lines = [
      "测试成功：机器人已响应。",
      groupId ? `**群**：${this.displayGroup(groupId)}` : "**当前会话**：私聊",
      `**用户**：${this.displayUser(userId)}`,
    ];
    if (groupId) {
      lines.push(`**待审批申请**：${this.joinAudit.pending(groupId).length}`);
      lines.push(
        `**全量消息模式**：${this.groupMessageMode?.get(groupId) ?? "unknown"}`,
      );
    }
    return cardFromText("自检结果", lines.join("\n"), {
      rows,
      buttonHint: "常用入口：",
      footer: ["机器人状态异常时：查看日志 logs/qq-group-ops.log"],
    });
  }

  /**
   * `/sync [群号|#群短码]` 与 `cb:sync:run`：同步官方待审批申请。
   *
   * 属于固定动作（无需参数），因此既能用指令触发，也能用回调自动完成；
   * 结果卡标明**操作人**，并给出「查看待审批」入口。
   */
  public async syncCard(
    targetGroupId: string,
    userId: string,
  ): Promise<CardResult> {
    const back = viewButton(
      "pending",
      "查看待审批",
      "pending",
      "page",
      targetGroupId,
      1,
    );
    if (!this.permissions.canReviewContent(userId, targetGroupId)) {
      const card = renderCard({
        title: "权限不足",
        lines: ["需要审核员或以上权限。"],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    let pending;
    try {
      pending = await this.joinSync.syncGroup(targetGroupId);
    } catch (error) {
      log.warn("join sync failed", {
        groupId: targetGroupId,
        error: formatError(error),
      });
      const card = renderCard({
        title: "同步失败",
        lines: [
          `操作人：${this.displayUser(userId)}`,
          formatError(error),
        ],
        rows: [[back]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    await this.notifyPending(targetGroupId, pending).catch(() => undefined);
    const operator = `操作人：${this.displayUser(userId)}`;
    const lines = [
      `**群**：${this.displayGroup(targetGroupId)}`,
      `**结果**：已同步官方待审批申请，当前待审批 ${pending.length} 条 · ${operator}`,
    ];
    for (const request of pending.slice(0, 5)) {
      const reason = request.reason ? ` 理由：${request.reason}` : "";
      lines.push(
        `- ${escapeCardText(this.displayRequest(request.requestId))} 用户：${escapeCardText(this.displayUser(request.userId))}${escapeCardText(reason)}`,
      );
    }
    if (pending.length > 5) {
      lines.push("（仅显示前 5 条，点下方按钮查看全部）");
    }
    return cardFromText("同步结果", lines.join("\n"), {
      rows: [[back]],
      footer: ["手动同步：/sync", "待审批列表每页 3 条，可翻页"],
    });
  }

  /** 审批结果卡（通过 / 拒绝），标明操作人并给回列表入口。 */
  private approvalResultCard(
    targetGroupId: string,
    userId: string,
    message: string,
    ok: boolean,
  ): CardResult {
    const card = renderCard({
      title: ok ? "审批结果" : "审批失败",
      lines: [message, `操作人：${this.displayUser(userId)}`],
      rows: [
        [
          viewButton("back", "返回待审批", "pending", "page", targetGroupId, 1),
          viewButton("audit", "查看审计", "audit", "page", targetGroupId, 20, 1),
        ],
      ],
      footer: ["手动审批：/approve <申请ID> · /reject <申请ID> [原因]"],
    });
    return { ok, text: card.text, rich: card };
  }
  /**
   * 子卡：开关设置 / 入群决策 / 命中处罚。
   *
   * 全部是**回调按钮**（开关与枚举都能自动完成）。
   */
  public rulesPanelCard(
    panel: string,
    targetGroupId: string,
    userId: string,
    notice?: string,
  ): CardResult {
    const config = this.configStore.get(targetGroupId);
    const canManage =
      this.permissions.canManageRules(userId, targetGroupId) ||
      this.permissions.isSuperAdmin(userId);
    if (!canManage) {
      const card = renderCard({
        title: "权限不足",
        lines: ["修改规则需要群管理员或以上权限。"],
        rows: [[viewButton("back", "返回规则", "rules", "view", targetGroupId)]],
      });
      return { ok: false, text: card.text, rich: card };
    }

    const back = viewButton("back", "返回规则", "rules", "view", targetGroupId);
    const toggle = (
      id: string,
      label: string,
      field: string,
      enabled: boolean,
      inPanel: boolean,
    ): CardButton => ({
      ...viewButton(
        id,
        `${label} ${enabled ? "关" : "开"}`,
        "rules",
        "toggle",
        targetGroupId,
        field,
        enabled ? "off" : "on",
        ...(inPanel ? [panel] : []),
      ),
    });
    const choice = (
      id: string,
      label: string,
      field: string,
      value: string,
      current: string,
      inPanel: boolean,
    ): CardButton => ({
      ...viewButton(
        id,
        `${current === value ? "● " : ""}${label}`,
        "rules",
        "toggle",
        targetGroupId,
        field,
        value,
        ...(inPanel ? [panel] : []),
      ),
      ...(current === value ? { style: 4 as CardButtonStyle } : {}),
    });

    const rows: CardButton[][] = [];
    let title = "群规则";
    if (panel === "toggle") {
      title = "群规则 · 开关设置";
      // 开关类：一行 2 个，描述 2-4 字 + 开/关（整行控制在 10 字内）
      rows.push([
        toggle("wordFilter", "过滤", "wordFilter", config.wordFilterEnabled, true),
        toggle("joinAudit", "入群", "joinAudit", config.joinAuditEnabled, true),
      ]);
      rows.push([
        toggle("keywordRecall", "撤回", "keywordRecall", config.keywordRecall, true),
        toggle("autoApprove", "自动通过", "autoApprove", config.autoApproveJoin, true),
      ]);
      rows.push([
        toggle("notifyAutoApproved", "通知", "notifyAutoApproved", config.notifyAutoApproved, true),
        toggle("export", "导出", "export", config.exportEnabled, true),
      ]);
    } else if (panel === "decision") {
      title = "群规则 · 入群决策";
      rows.push([
        choice("decision-manual", "人工", "joinDecision", "manual", config.joinDecision, true),
        choice("decision-auto", "全自动", "joinDecision", "auto_approve", config.joinDecision, true),
        choice("decision-match", "命中通过", "joinDecision", "approve_on_match", config.joinDecision, true),
      ]);
      rows.push([
        choice("decision-reject", "命中拒绝", "joinDecision", "reject_on_match", config.joinDecision, true),
        choice("decision-mismatch", "未命中拒绝", "joinDecision", "reject_on_mismatch", config.joinDecision, true),
      ]);
    } else {
      title = "群规则 · 命中处罚";
      rows.push([
        choice("punish-none", "仅警告", "keywordPunish", "none", config.keywordPunish, true),
        choice("punish-mute", "禁言", "keywordPunish", "mute", config.keywordPunish, true),
      ]);
      rows.push([
        choice("punish-kick", "移出", "keywordPunish", "kick", config.keywordPunish, true),
        choice("punish-blacklist", "移出拉黑", "keywordPunish", "kick_blacklist", config.keywordPunish, true),
      ]);
    }
    rows.push([back]);

    return cardFromText(
      title,
      [
        ...(notice ? [`**结果**：${escapeCardText(notice)}`] : []),
        `**当前值**：${panel === "toggle" ? "见下方按钮（显示的是「点一下会变成的结果」）" : panel === "decision" ? config.joinDecision : config.keywordPunish}`,
        "",
        "手动等价指令：/rules set <字段> <值>（详见 /help rules）",
      ].join("\n"),
      {
        rows,
        buttonHint: "点击即生效：",
        footer: [`本群：${this.displayGroup(targetGroupId)}`],
      },
    );
  }

  /** 回调：规则开关/枚举切换（固定动作 → 自动执行并回刷新后的卡片）。 */
  public async toggleRulesCard(
    targetGroupId: string,
    field: string,
    value: string,
    userId: string,
    panel?: string,
  ): Promise<CardResult> {
    const result = await this.handleRulesSet(undefined, userId, [
      "rules",
      "set",
      targetGroupId,
      field,
      value,
    ]);
    const notice = `已更新：${field} = ${value} · 操作人：${this.displayUser(userId)}`;
    if (!result.ok) {
      const card = renderCard({
        title: "规则未修改",
        lines: [notice, "", ...result.text.split("\n")],
        rows: [
          [viewButton("back", "返回规则", "rules", "view", targetGroupId)],
        ],
      });
      return { ok: false, text: card.text, rich: card };
    }
    log.info("rule updated via callback", {
      targetGroupId,
      field,
      value,
      userId,
    });
    return panel
      ? this.rulesPanelCard(panel, targetGroupId, userId, notice)
      : this.rulesCard(undefined, userId, ["rules", targetGroupId], notice);
  }

  /** `/rules all`：全局默认规则卡（仅超级管理员）。 */
  private globalRulesCard(userId: string): CardResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      const card = renderCard({
        title: "权限不足",
        lines: [GLOBAL_RULES_DENIED],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    return cardFromText("全局规则（默认）", this.formatGlobalRules(), {
      rows: [
        [
          viewButton("refresh", "刷新", "rules", "all"),
          viewButton("help", "规则帮助", "help", "topic", "rules"),
        ],
      ],
      footer: ["修改全局规则：/rules set all <字段> <值>"],
    });
  }

  /**
   * `/testmenu [页码]`：官方回调按钮翻页试验（仅全局超级管理员）。
   *
   * 卡片里的「上一页 / 下一页 / 返回」是回调按钮（`action.type=1`），
   * 点击后由 `TestMenuService` 走互动事件链路被动回复新的一页；
   * 同时保留 `/testmenu <页码>` 指令入口与「指令翻页」按钮作为双通道兜底。
   */
  private handleTestMenu(
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return {
        ok: false,
        text: "权限不足：/testmenu 需要全局超级管理员权限。",
      };
    }
    const raw = parts[1];
    let page = 1;
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (
        Number.isNaN(parsed) ||
        parsed < 1 ||
        parsed > TEST_MENU_PAGE_COUNT
      ) {
        return {
          ok: false,
          text: `页码范围 1-${TEST_MENU_PAGE_COUNT}，例如 /testmenu 2`,
        };
      }
      page = parsed;
    }
    const card = buildTestMenuCard(page);
    return { ok: true, text: card.text, rich: card };
  }

  /** `/menu [系统|管理|超管|活动|审核|运营]`：渲染对应层级的交互菜单。 */
  private handleMenu(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const query = parts[1];
    const section = findMenuSection(query);
    if (query !== undefined && section === undefined) {
      const main = this.mainMenu(groupId, userId);
      return {
        ok: false,
        text:
          `未找到「${query}」菜单。\n` +
          "用法：/menu [系统|管理|超管|活动|审核|运营]\n\n" +
          main.text,
        rich: main,
      };
    }
    const view = buildMenu(
      section ?? "main",
      this.menuContext(groupId, userId),
    );
    return { ok: view.ok, text: view.message.text, rich: view.message };
  }

  /** 未知指令：保留原来的报错文案，同时附上菜单入口按钮。 */
  private unknownCommandResult(
    groupId: string | undefined,
    userId: string,
    command: string | undefined,
  ): CommandResult {
    const rich = buildUnknownCommandMenu(
      command ?? "",
      this.menuContext(groupId, userId),
    );
    return { ok: false, text: rich.text, rich };
  }

  private menuContext(groupId: string | undefined, userId: string): MenuContext {
    const context: MenuContext = {
      userId,
      groupId,
      // 与 buildHelp 保持一致：未注入身份映射时（单元测试）视为已绑定
      bound: this.identityMap ? Boolean(this.identityMap.getQq(userId)) : true,
      permissions: this.permissions,
    };
    if (this.display) {
      context.userLabel = this.display.user(userId);
    }
    if (groupId !== undefined) {
      if (this.display) {
        context.groupLabel = this.display.group(groupId);
      }
      if (this.identityMap) {
        context.groupBound = Boolean(this.identityMap.getGroupNumber(groupId));
      }
    }
    return context;
  }

  private handleHelp(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    return this.helpCard(groupId, userId, parts[1]);
  }

  private renderHelpTopic(
    topic: HelpTopic,
    context: Parameters<HelpTopic["body"]>[0],
  ): string {
    return [
      `/${topic.name} — ${topic.title}`,
      `所需权限：${topic.requirement}`,
      "",
      ...topic.body(context),
      "",
      "相关：/help 查看全部可用指令",
    ].join("\n");
  }

  private buildHelp(groupId: string | undefined, userId: string): string {
    const lines: string[] = [
      "可用指令：",
      "/help - 显示帮助",
      "/help <指令> - 查看某个指令的详细用法，例如 /help rules、/help bind、/help perm",
      "/menu - 打开系统菜单（系统 / 管理 / 超管），按钮点击即执行",
      "/bind qq <QQ号> - 绑定自己的 QQ 号",
    ];
    const isSuper = this.permissions.isSuperAdmin(userId);
    const canBindGroup =
      groupId !== undefined &&
      (isSuper || this.permissions.canApproveJoin(userId, groupId));
    if (canBindGroup) {
      lines.push("/bind group <群号> - 绑定当前群号");
    }
    if (isSuper) {
      lines.push("/bind user <userId> <QQ号> - 绑定任意用户");
      lines.push("/bind groupid <group_openid> <群号> - 绑定任意群");
      lines.push("/whois <QQ号|userId|群号|group_openid> - 查询映射");
      lines.push(
        `/testmenu [页码] - 回调按钮翻页试验（1-${TEST_MENU_PAGE_COUNT} 页）`,
      );
    }

    const isBound = this.identityMap
      ? Boolean(this.identityMap.getQq(userId))
      : true;
    if (!isBound) {
      lines.push("", "请先绑定 QQ 号：/bind qq <QQ号>");
      lines.push("绑定后使用 /help 查看可用指令。");
      return lines.join("\n");
    }

    const groupBound = groupId !== undefined
      ? Boolean(this.identityMap?.getGroupNumber(groupId))
      : true;
    if (groupId !== undefined && !groupBound) {
      lines.push("", "本群未绑定，群管理指令不可用。");
      lines.push(
        canBindGroup
          ? "请先绑定本群：/bind group <群号>"
          : "请联系群管理员绑定本群：/bind group <群号>",
      );
      return lines.join("\n");
    }

    lines.push("/myperm - 查看自己的权限");
    lines.push("/profile - 配置个人资料（班级/学院/姓名/学号）");
    lines.push("/activity - 活动列表；/activity join <#活动短码> 报名");
    const canModerate =
      groupId !== undefined
        ? this.permissions.canReviewContent(userId, groupId)
        : this.permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator);
    const canAdmin =
      groupId !== undefined
        ? this.permissions.canApproveJoin(userId, groupId)
        : this.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin);

    if (canModerate) {
      lines.push("/pending [#群短码|群号] - 查看待审批入群申请");
      lines.push("/sync [#群短码|群号] - 从官方接口同步待审批申请");
      lines.push("/rules [#群短码|群号] - 查看群规则配置");
      lines.push("/audit [#群短码|群号] [数量] - 查看最近审计记录");
      lines.push("/status [#群短码|群号] - 查看群运行状态");
      lines.push("/test - 测试机器人是否正常响应");
    }
    if (canAdmin) {
      lines.push("/approve [#群短码|群号] <申请ID> - 通过入群申请");
      lines.push("/reject [#群短码|群号] <申请ID> [原因] - 拒绝入群申请");
      lines.push("/notify - 配置入群申请推送（卡片 + 快捷同意/拒绝按钮）");
      lines.push("/rules set <字段> <值> - 修改群规则（关键词、警告文案等）");
    }
    if (isSuper) {
      lines.push("/perm list [#群短码|群号] - 查看权限配置");
      lines.push("/perm grant super <userId|QQ号> - 授予全局超管");
      lines.push("/perm revoke super <userId|QQ号> - 撤销全局超管");
      lines.push("/perm grant gsuper [#群短码|群号] <userId|QQ号> - 授予本群超管");
      lines.push("/perm revoke gsuper [#群短码|群号] <userId|QQ号> - 撤销本群超管");
      lines.push("/perm grant admin [#群短码|群号] <userId|QQ号> - 授予群管理员");
      lines.push("/perm revoke admin [#群短码|群号] <userId|QQ号> - 撤销群管理员");
      lines.push("/perm grant mod [#群短码|群号] <userId|QQ号> - 授予审核员");
      lines.push("/perm revoke mod [#群短码|群号] <userId|QQ号> - 撤销审核员");
      lines.push("/rules all - 查看全局默认规则");
      lines.push("/rules set all <字段> <值> - 修改全局默认规则");
    }
    if (!canModerate && !canAdmin && !isSuper) {
      lines.push("当前没有更多可执行的管理指令。");
    }
    return lines.join("\n");
  }

  private handleMyPermission(
    groupId: string | undefined,
    userId: string,
  ): CommandResult {
    const level = this.permissions.levelFor(userId, groupId);
    return {
      ok: true,
      text: [
        `你的权限等级：${level}`,
        `全局超级管理员：${this.permissions.isSuperAdmin(userId)}`,
        groupId
          ? `本群超级管理员：${this.permissions.isGroupSuperAdmin(userId, groupId)}`
          : undefined,
        groupId ? `当前群：${this.displayGroup(groupId)}` : "当前会话：私聊",
        `审核入群：${this.permissions.canApproveJoin(userId, groupId ?? "")}`,
        `管理规则：${this.permissions.canManageRules(userId, groupId ?? "")}`,
        `内容审核：${this.permissions.canReviewContent(userId, groupId ?? "")}`,
        `导出数据：${this.permissions.canExportData(userId, groupId ?? "")}`,
        `配置权限：${this.permissions.isSuperAdmin(userId)}`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    };
  }

  private handlePermissionConfig(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      log.warn("permission config denied", { groupId, userId });
      return { ok: false, text: "权限不足：仅超级管理员可以配置权限。" };
    }

    const action = normalize(parts[1]);
    if (!action || action === "list" || action === "列表") {
      const targetGroupId = this.resolveTargetGroupId(groupId, parts[2]);
      return {
        ok: true,
        text: this.formatPermissionList(targetGroupId),
      };
    }

    const role = normalize(parts[2]);
    const isSuperRole = role === "super" || role === "超管";
    const isGroupSuperRole = GROUP_SUPER_ROLES.has(role);
    let targetGroupId: string | undefined;
    let targetUserId: string | undefined;

    if (isSuperRole) {
      targetUserId = this.resolveUserId(parts[3]);
    } else if (isGroupSuperRole) {
      targetGroupId = groupId ?? this.resolveTargetGroupId(undefined, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    } else {
      targetGroupId = this.resolveTargetGroupId(groupId, parts[3]);
      targetUserId = this.resolveUserId(groupId ? parts[3] : parts[4]);
    }

    if (!role) {
      return { ok: false, text: PERM_USAGE };
    }

    if (!isSuperRole && !targetGroupId) {
      return {
        ok: false,
        text: "私信中配置群角色需要提供群号或 #群短码。",
      };
    }

    if (!targetUserId) {
      return { ok: false, text: PERM_USAGE };
    }

    try {
      if (action === "grant" || action === "授予") {
        this.grantRole(targetGroupId, role, targetUserId);
      } else if (action === "revoke" || action === "撤销") {
        this.revokeRole(targetGroupId, role, targetUserId);
      } else {
        return { ok: false, text: PERM_USAGE };
      }
    } catch (error) {
      log.warn("permission config failed", {
        groupId,
        userId,
        action,
        role,
        targetUserId,
        error: String(error),
      });
      return { ok: false, text: `权限配置失败：${String(error)}` };
    }

    log.info("permission config updated", {
      groupId: targetGroupId,
      userId,
      action,
      role,
      targetUserId,
    });
    return {
      ok: true,
      text: `已更新权限：${role} ${this.displayUser(targetUserId)}\n\n${this.formatPermissionList(targetGroupId)}`,
    };
  }

  private formatPermissionList(groupId?: string): string {
    const lines = [`全局超级管理员：${this.displayUsers(this.permissions.listSuperAdmins())}`];
    if (groupId) {
      const label = this.displayGroup(groupId);
      lines.push(
        `本群超级管理员（${label}）：${this.displayUsers(this.permissions.listGroupSuperAdmins(groupId))}`,
      );
      lines.push(
        `群管理员（${label}）：${this.displayUsers(this.permissions.listGroupAdmins(groupId))}`,
      );
      lines.push(
        `审核员（${label}）：${this.displayUsers(this.permissions.listModerators(groupId))}`,
      );
    } else {
      lines.push("本群超级管理员：私信中请指定 group_openid");
      lines.push("群管理员：私信中请指定 group_openid");
      lines.push("审核员：私信中请指定 group_openid");
    }
    return lines.join("\n");
  }

  private grantRole(
    groupId: string | undefined,
    role: string,
    targetUserId: string,
  ): void {
    if (role === "super" || role === "超管") {
      this.permissions.grantSuperAdmin(targetUserId);
      return;
    }
    if (!groupId) {
      throw new Error("group_openid is required");
    }
    if (GROUP_SUPER_ROLES.has(role)) {
      this.permissions.grantGroupSuperAdmin(groupId, targetUserId);
      return;
    }
    if (role === "admin" || role === "管理员") {
      this.permissions.grantGroupAdmin(groupId, targetUserId);
      return;
    }
    if (role === "mod" || role === "审核员") {
      this.permissions.grantModerator(groupId, targetUserId);
      return;
    }
    throw new Error(`未知角色：${role}`);
  }

  private revokeRole(
    groupId: string | undefined,
    role: string,
    targetUserId: string,
  ): void {
    if (role === "super" || role === "超管") {
      this.permissions.revokeSuperAdmin(targetUserId);
      return;
    }
    if (!groupId) {
      throw new Error("group_openid is required");
    }
    if (GROUP_SUPER_ROLES.has(role)) {
      this.permissions.revokeGroupSuperAdmin(groupId, targetUserId);
      return;
    }
    if (role === "admin" || role === "管理员") {
      this.permissions.revokeGroupAdmin(groupId, targetUserId);
      return;
    }
    if (role === "mod" || role === "审核员") {
      this.permissions.revokeModerator(groupId, targetUserId);
      return;
    }
    throw new Error(`未知角色：${role}`);
  }

  private async handleSync(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const targetGroupId = this.resolveTargetGroupId(groupId, parts[1]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "同步官方申请",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/sync [#群短码|群号]",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    return this.syncCard(targetGroupId, userId);
  }

  /**
   * `/notify`：审核员自助配置入群申请推送。
   *
   * 订阅范围只有两种：`__all__`（我担任群管理员的全部群）与单个群；
   * 推送时还会再按「当前群是否有审批权限」过滤一次，越权订阅不会泄漏申请内容。
   */
  private async handleNotify(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    if (!this.notifications) {
      return { ok: false, text: "推送服务未启用。" };
    }
    const arg1 = normalize(parts[1]);
    if (!arg1) {
      return this.notifyCard(groupId, userId);
    }
    if (arg1 === "test" || arg1 === "测试") {
      return this.notifyTestCard(groupId, userId);
    }
    if (isToggleValue(arg1)) {
      // 群内：订阅本群；私信：订阅全部群
      const scope = groupId ?? NOTIFY_SCOPE_ALL;
      return this.notifyToggleCard(scope, isToggleOn(arg1), userId);
    }
    if (isAllScope(arg1)) {
      const action = normalize(parts[2]);
      if (!isToggleValue(action)) {
        return this.notifyCard(groupId, userId, NOTIFY_USAGE);
      }
      return this.notifyToggleCard(NOTIFY_SCOPE_ALL, isToggleOn(action), userId);
    }
    const targetGroupId = this.resolveTargetGroupId(undefined, parts[1]);
    const action = normalize(parts[2]);
    if (!targetGroupId || !isToggleValue(action)) {
      return this.notifyCard(groupId, userId, NOTIFY_USAGE);
    }
    return this.notifyToggleCard(targetGroupId, isToggleOn(action), userId);
  }

  private applyNotify(
    userId: string,
    scope: string,
    enabled: boolean,
  ): CommandResult {
    const label =
      scope === NOTIFY_SCOPE_ALL
        ? "全部群（你担任群管理员的群）"
        : `群 ${this.groupLabel(scope)}`;
    if (!enabled) {
      const removed = this.notifications?.unsubscribe(userId, scope) ?? false;
      return {
        ok: true,
        text: removed
          ? `已关闭：${label} 的入群申请推送。`
          : `${label} 的推送本来就是关闭的。`,
      };
    }
    const allowed =
      scope === NOTIFY_SCOPE_ALL
        ? this.permissions.isSuperAdmin(userId) ||
          this.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin)
        : this.permissions.canApproveJoin(userId, scope);
    if (!allowed) {
      return { ok: false, text: NOTIFY_PERMISSION_DENIED };
    }
    this.notifications?.subscribe(userId, scope);
    return {
      ok: true,
      text:
        `已开启：${label} 的入群申请推送。\n` +
        "有新的待审批申请时会私聊推送卡片，可直接点「同意 / 拒绝」按钮。",
    };
  }

  private renderNotifyStatus(
    userId: string,
    groupId: string | undefined,
  ): string {
    const scopes = this.notifications?.listScopes(userId) ?? [];
    const lines = [
      "入群申请推送：",
      `  全部群（你担任群管理员的群）：${
        scopes.includes(NOTIFY_SCOPE_ALL) ? "已开启" : "未开启"
      }`,
    ];
    for (const scope of scopes.filter((item) => item !== NOTIFY_SCOPE_ALL)) {
      lines.push(`  群 ${this.groupLabel(scope)}：已开启`);
    }
    const reviewable = this.permissions.listReviewableGroups(userId);
    lines.push(
      "",
      reviewable.length > 0
        ? `可审批的群：${reviewable.map((id) => this.groupLabel(id)).join("、")}`
        : "可审批的群：无（入群审批需要群管理员或以上权限）",
    );
    if (this.permissions.isSuperAdmin(userId)) {
      lines.push("说明：你是全局超级管理员，可审批所有群。");
    }
    if (groupId) {
      lines.push(`当前群：${this.groupLabel(groupId)}`);
    }
    lines.push("", NOTIFY_USAGE);
    return lines.join("\n");
  }

  private groupLabel(groupId: string): string {
    return this.displayGroup(groupId);
  }

  /**
   * 展示用户：QQ号 或随机短码 `#XXXXXX`。
   *
   * 没有注入 DisplayNameService 时（部分单测）回退为「绑定 QQ号 → QQ号，否则原样 id」。
   */
  private displayUser(officialId: string): string {
    if (this.display) {
      return this.display.user(officialId);
    }
    return this.identityMap?.getQq(officialId) ?? officialId;
  }

  /** 展示群：群号 或随机短码 `#XXXXXX`。 */
  private displayGroup(groupId: string): string {
    if (this.display) {
      return this.display.group(groupId);
    }
    return this.identityMap?.getGroupNumber(groupId) ?? groupId;
  }

  /** 展示申请：短码 `#XXXXXX`（替代又长又难读的 join_request_id）。 */
  private displayRequest(requestId: string): string {
    return this.display?.request(requestId) ?? requestId;
  }

  private displayUsers(ids: readonly string[]): string {
    return formatList(ids.map((id) => this.displayUser(id)));
  }

  /** 同步补齐的申请也推送一次；投递表保证同一申请不会重复推给同一个人。 */
  private async notifyPending(
    groupId: string,
    requests: readonly JoinRequest[],
  ): Promise<void> {
    if (!this.notifications) {
      return;
    }
    for (const request of requests) {
      await this.notifications
        .notifyJoinRequest({
          groupId,
          requestId: request.requestId,
          userId: request.userId,
          reason: request.reason,
        })
        .catch((error: unknown) => {
          log.warn("notify pending join request failed", {
            groupId,
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  // ------------------------------------------------------------- /profile

  private handleProfile(userId: string, parts: readonly string[]): CommandResult {
    const profiles = this.userProfiles;
    if (!profiles) {
      return { ok: false, text: "个人资料服务未启用。" };
    }
    const action = normalize(parts[1]);
    if (!action) {
      return { ok: true, text: this.formatProfile(userId) };
    }
    if (action === "set" || action === "设置") {
      const field = PROFILE_FIELD_ALIASES[normalize(parts[2])];
      const value = parts.slice(3).join(" ").trim();
      if (!field || value.length === 0) {
        return { ok: false, text: PROFILE_USAGE };
      }
      if (CLEAR_WORDS.has(value.toLowerCase())) {
        profiles.clear(userId, field);
        return {
          ok: true,
          text: `已清除：${PROFILE_FIELD_LABELS[field]}\n\n${this.formatProfile(userId)}`,
        };
      }
      try {
        profiles.set(userId, field, value);
      } catch (error) {
        return { ok: false, text: `设置失败：${formatError(error)}` };
      }
      return {
        ok: true,
        text: `已更新：${PROFILE_FIELD_LABELS[field]}\n\n${this.formatProfile(userId)}`,
      };
    }
    if (action === "clear" || action === "清除" || action === "重置") {
      profiles.clear(userId);
      return { ok: true, text: "已清空个人资料。" };
    }
    return { ok: false, text: PROFILE_USAGE };
  }

  private formatProfile(userId: string): string {
    const profile = this.userProfiles?.get(userId);
    const userLabel = this.displayUser(userId);
    if (!profile) {
      return `个人资料（${userLabel}）：尚未填写\n\n${PROFILE_USAGE}`;
    }
    return [
      `个人资料（${userLabel}）：`,
      `姓名：${profile.name || "（未填）"}`,
      `学号：${profile.studentId || "（未填）"}${
        profile.studentId && profile.year ? `（${profile.year} 级）` : ""
      }`,
      `班级：${profile.className || "（未填）"}`,
      `学院：${profile.college || "（未填）"}`,
      "",
      PROFILE_USAGE,
    ].join("\n");
  }

  // ------------------------------------------------------------ /activity

  private async handleActivity(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const activities = this.activity;
    if (!activities) {
      return { ok: false, text: "活动模块未启用。" };
    }
    const action = normalize(parts[1]);
    if (!action || action === "list" || action === "列表" || action === "查看") {
      const { page, rest } = extractPageToken(parts);
      const targetGroupId =
        this.resolveTargetGroupId(groupId, rest[1] ?? rest[0]) ?? groupId;
      if (!targetGroupId) {
        return {
          ok: false,
          text: "用法：/activity（群内查看本群活动），或 /activity list <群号|#群短码> [+页码]",
        };
      }
      return this.activityListCard(targetGroupId, userId, page);
    }
    if (parts[1]?.startsWith("#")) {
      return this.handleActivityInfo(userId, parts[1]);
    }
    switch (action) {
      case "create":
      case "创建":
      case "新建":
        return this.handleActivityCreate(groupId, userId, parts);
      case "set":
      case "设置":
      case "配置":
        return this.handleActivitySet(userId, parts);
      case "open":
      case "开始":
      case "发布":
        return this.handleActivityOpen(userId, parts);
      case "close":
      case "关闭":
        return this.handleActivityStatus(userId, parts, "close");
      case "cancel":
      case "取消活动":
        return this.handleActivityStatus(userId, parts, "cancel");
      case "join":
      case "报名":
        return this.handleActivityJoin(userId, parts);
      case "quit":
      case "取消报名":
        return this.handleActivityQuit(userId, parts);
      case "info":
      case "详情":
        return this.handleActivityInfo(userId, parts[2]);
      case "signups":
      case "名单":
        return this.handleActivitySignups(userId, parts);
      default:
        return { ok: false, text: ACTIVITY_USAGE };
    }
  }

  private requireActivity(
    code: string | undefined,
  ): { ok: true; activity: Activity } | { ok: false; text: string } {
    if (!code) {
      return { ok: false, text: ACTIVITY_USAGE };
    }
    try {
      return { ok: true, activity: this.activity!.requireByCode(code) };
    } catch (error) {
      return { ok: false, text: `活动不存在：${code}` };
    }
  }

  private canManageActivity(userId: string, activity: Activity): boolean {
    return (
      this.permissions.isSuperAdmin(userId) ||
      activity.createdBy === userId ||
      this.permissions.canApproveJoin(userId, activity.groupId)
    );
  }

  private handleActivityCreate(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    let targetGroupId = groupId;
    let titleParts = parts.slice(2);
    if (!targetGroupId) {
      const fromInput = this.resolveTargetGroupId(undefined, parts[2]);
      if (fromInput && parts.length > 3) {
        targetGroupId = fromInput;
        titleParts = parts.slice(3);
      }
    }
    if (!targetGroupId) {
      return {
        ok: false,
        text: "用法：群内 /activity create <标题>；私信 /activity create <群号|#群短码> <标题>",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：发布活动需要群管理员或以上权限。" };
    }
    const title = titleParts.join(" ").trim();
    if (title.length === 0) {
      return { ok: false, text: "请提供活动标题：/activity create <标题>" };
    }
    try {
      const activity = this.activity!.createActivity({
        groupId: targetGroupId,
        title,
        createdBy: userId,
        groupNumber: this.identityMap?.getGroupNumber(targetGroupId) ?? "",
      });
      return {
        ok: true,
        text:
          `已创建活动（草稿）：${activity.title}\n` +
          `活动短码：${activityCode(activity)}\n\n` +
          `接下来：/activity set ${activityCode(activity)} capacity 50、link https://...、allowYears 22,23、denyColleges ...；\n` +
          `配好后用 /activity open ${activityCode(activity)} 开放报名并发送卡片。`,
      };
    } catch (error) {
      return { ok: false, text: `创建失败：${formatError(error)}` };
    }
  }

  private handleActivitySet(userId: string, parts: readonly string[]): CommandResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return found;
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return { ok: false, text: "权限不足：只有群管理员或活动发布者可以修改活动。" };
    }
    const field = normalize(parts[3]);
    const value = parts.slice(4).join(" ").trim();
    if (!field || value.length === 0) {
      return { ok: false, text: ACTIVITY_SET_USAGE };
    }
    const cleared = CLEAR_WORDS.has(value.toLowerCase());
    try {
      switch (field) {
        case "title":
        case "标题":
          this.activity!.updateActivity(activity.activityId, { title: value });
          break;
        case "desc":
        case "description":
        case "描述":
          this.activity!.updateActivity(activity.activityId, {
            description: cleared ? "" : value,
          });
          break;
        case "capacity":
        case "名额":
          this.activity!.updateActivity(activity.activityId, {
            capacity: cleared ? undefined : parsePositiveInt(field, value),
          });
          break;
        case "group":
        case "群号":
          this.activity!.updateActivity(activity.activityId, {
            groupNumber: cleared ? "" : value,
          });
          break;
        case "link":
        case "链接":
          this.activity!.updateActivity(activity.activityId, {
            links: cleared ? [] : [...activity.links, parseLink(value)],
          });
          break;
        case "links":
        case "链接列表":
          this.activity!.updateActivity(activity.activityId, {
            links: cleared ? [] : parseLinks(value),
          });
          break;
        case "allowcolleges":
        case "允许学院":
          this.activity!.updateActivity(activity.activityId, {
            allowColleges: cleared ? [] : parseList(value),
          });
          break;
        case "denycolleges":
        case "禁止学院":
        case "不允许学院":
          this.activity!.updateActivity(activity.activityId, {
            denyColleges: cleared ? [] : parseList(value),
          });
          break;
        case "allowyears":
        case "允许年级":
          this.activity!.updateActivity(activity.activityId, {
            allowYears: cleared ? [] : parseYearList(value),
          });
          break;
        case "denyyears":
        case "禁止年级":
        case "不允许年级":
          this.activity!.updateActivity(activity.activityId, {
            denyYears: cleared ? [] : parseYearList(value),
          });
          break;
        default:
          return { ok: false, text: ACTIVITY_SET_USAGE };
      }
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }
    const updated = this.activity!.requireByCode(activity.code);
    return {
      ok: true,
      text: `已更新活动 ${activityCode(updated)}。\n\n${this.formatActivityInfo(updated)}`,
    };
  }

  private async handleActivityOpen(
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return found;
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return { ok: false, text: "权限不足：只有群管理员或活动发布者可以开放活动。" };
    }
    const opened = this.activity!.openActivity(activity.activityId);
    const registrations = this.activity!.listRegistrations(opened.activityId);
    const result = await this.activityCards?.publish({
      activity: opened,
      registrations,
      groupLabel: this.displayGroup(opened.groupId),
    });
    const lines = [`活动已开放报名：${opened.title}（${activityCode(opened)}）`];
    if (result && !result.ok) {
      lines.push(`卡片发送失败：${result.detail}`);
      lines.push(`可以手动把活动发到群里：/activity info ${activityCode(opened)}`);
    } else if (result?.detail) {
      lines.push(`卡片已发送（降级为 ${result.detail}）。`);
    } else if (result) {
      lines.push("活动卡片已发送到群里。");
    }
    return { ok: true, text: lines.join("\n") };
  }

  private handleActivityStatus(
    userId: string,
    parts: readonly string[],
    mode: "close" | "cancel",
  ): CommandResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return found;
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return { ok: false, text: "权限不足：只有群管理员或活动发布者可以操作活动。" };
    }
    const updated =
      mode === "close"
        ? this.activity!.closeActivity(activity.activityId)
        : this.activity!.cancelActivity(activity.activityId);
    return {
      ok: true,
      text:
        mode === "close"
          ? `已关闭活动：${updated.title}（停止报名）`
          : `已取消活动：${updated.title}`,
    };
  }

  private handleActivityJoin(
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return found;
    }
    const { activity } = found;
    const profiles = this.userProfiles;
    if (!profiles) {
      return { ok: false, text: "个人资料服务未启用，无法校验报名资格。" };
    }
    let profile;
    try {
      profile = profiles.requireComplete(userId);
      this.activity!.checkEligibility(activity, profile);
    } catch (error) {
      if (error instanceof UserProfileError || error instanceof ActivityRuleError) {
        return { ok: false, text: error.message };
      }
      throw error;
    }
    try {
      const registration = this.activity!.register({
        activityId: activity.activityId,
        userId,
        displayName: profile.name,
        note: parts.slice(3).join(" ").trim(),
      });
      const total = this.activity!.listRegistrations(activity.activityId).length;
      return {
        ok: true,
        text:
          `报名成功：${activity.title}\n` +
          `姓名：${registration.displayName} · 学号：${profile.studentId} · 班级：${profile.className} · 学院：${profile.college}\n` +
          `当前报名人数：${total}${activity.capacity ? ` / ${activity.capacity}` : ""}\n` +
          `取消报名：/activity quit ${activityCode(activity)}`,
      };
    } catch (error) {
      if (error instanceof ActivityRuleError) {
        return { ok: false, text: error.message };
      }
      return { ok: false, text: `报名失败：${formatError(error)}` };
    }
  }

  private handleActivityQuit(
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return found;
    }
    const { activity } = found;
    const registration = this.activity!.findRegistration(
      activity.activityId,
      userId,
    );
    if (!registration) {
      return { ok: false, text: "你还没有报名这个活动。" };
    }
    this.activity!.cancelRegistration(registration.registrationId, userId);
    return {
      ok: true,
      text: `已取消报名：${activity.title}（${activityCode(activity)}）`,
    };
  }

  private handleActivityInfo(
    userId: string,
    code: string | undefined,
  ): CommandResult {
    const found = this.requireActivity(code);
    if (!found.ok) {
      return found;
    }
    return { ok: true, text: this.formatActivityInfo(found.activity) };
  }

  private handleActivitySignups(
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const found = this.requireActivity(parts[2]);
    if (!found.ok) {
      return found;
    }
    const { activity } = found;
    if (!this.canManageActivity(userId, activity)) {
      return { ok: false, text: "权限不足：只有群管理员或活动发布者可以查看报名名单。" };
    }
    const registrations = this.activity!.listRegistrations(activity.activityId);
    if (registrations.length === 0) {
      return { ok: true, text: `${activity.title} 目前还没有人报名。` };
    }
    const lines = [
      `${activity.title} 报名名单（${registrations.length}${
        activity.capacity ? ` / ${activity.capacity}` : ""
      }）：`,
    ];
    registrations.forEach((registration, index) => {
      const profile = this.userProfiles?.get(registration.userId);
      const detail = profile
        ? [profile.studentId, profile.className, profile.college]
            .filter((item) => item.length > 0)
            .join(" · ")
        : "";
      const note = registration.note ? ` 备注：${registration.note}` : "";
      lines.push(
        `${index + 1}. ${registration.displayName || this.displayUser(registration.userId)}${
          detail ? `（${detail}）` : ""
        }${note}`,
      );
    });
    return { ok: true, text: lines.join("\n") };
  }

  private formatActivityList(groupId: string): string {
    const activities = this.activity!.listActivities(groupId);
    if (activities.length === 0) {
      return `群 ${this.displayGroup(groupId)} 还没有活动。\n\n${ACTIVITY_USAGE}`;
    }
    const lines = [`群 ${this.displayGroup(groupId)} 的活动：`];
    for (const activity of activities) {
      const count = this.activity!.listRegistrations(activity.activityId).length;
      lines.push(
        `- ${activityCode(activity)} ${activity.title} [${activity.status}] 报名 ${count}${
          activity.capacity ? `/${activity.capacity}` : ""
        }`,
      );
    }
    lines.push("", `查看详情：/activity info <活动短码>`);
    return lines.join("\n");
  }

  private formatActivityInfo(activity: Activity): string {
    const registrations = this.activity!.listRegistrations(activity.activityId);
    const rules: string[] = [];
    if (activity.allowColleges.length > 0) {
      rules.push(`仅限学院：${activity.allowColleges.join("、")}`);
    }
    if (activity.allowYears.length > 0) {
      rules.push(`仅限年级：${activity.allowYears.join("、")}`);
    }
    if (activity.denyColleges.length > 0) {
      rules.push(`不接受学院：${activity.denyColleges.join("、")}`);
    }
    if (activity.denyYears.length > 0) {
      rules.push(`不接受年级：${activity.denyYears.join("、")}`);
    }
    return [
      `活动 ${activityCode(activity)}：${activity.title}`,
      `状态：${activity.status}`,
      `群：${activity.groupNumber || this.displayGroup(activity.groupId)}`,
      ...(activity.description ? [`简介：${activity.description}`] : []),
      `报名人数：${registrations.length}${activity.capacity ? ` / ${activity.capacity}` : ""}`,
      ...rules,
      ...activity.links.map((link) => `链接：${link.label} ${link.url}`),
      "",
      `报名：/activity join ${activityCode(activity)}`,
      `取消报名：/activity quit ${activityCode(activity)}`,
      `管理：/activity set ${activityCode(activity)} <字段> <值>`,
    ].join("\n");
  }

  private handlePending(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    return this.pendingCard(groupId, userId, parts);
  }

  private async handleApprove(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const resolved = this.resolveReviewTarget(groupId, parts);
    const { targetGroupId, requestId } = resolved;
    if (!targetGroupId || !requestId) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "  /approve <#申请短码>                         群内审批本群\n" +
          "  /approve <群号|#群短码> <#申请短码>            私信中审批指定群\n" +
          "  /approve <#申请短码>                         私信中也可以（自动定位该申请所属群）",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        return { ok: false, text: "申请不属于该群。" };
      }
      await this.joinApproval.approve(targetGroupId, requestId, userId);
    } catch (error) {
      log.warn("approve failed", { requestId, error: formatError(error) });
      return { ok: false, text: `审批失败：${formatError(error)}` };
    }
    log.info("approved join request", { requestId, userId });
    return this.approvalResultCard(
      targetGroupId,
      userId,
      `已通过入群申请 ${this.displayRequest(requestId)}。`,
      true,
    );
  }

  private async handleReject(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const { targetGroupId, requestId, reasonParts } = this.resolveReviewTarget(
      groupId,
      parts,
    );
    if (!targetGroupId || !requestId) {
      return {
        ok: false,
        text:
          "用法：\n" +
          "  /reject <#申请短码> [原因]                    群内审批本群\n" +
          "  /reject <群号|#群短码> <#申请短码> [原因]      私信中审批指定群\n" +
          "  /reject <#申请短码> [原因]                    私信中也可以（自动定位该申请所属群）",
      };
    }
    if (!this.permissions.canApproveJoin(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    const reason = reasonParts.join(" ").trim();
    try {
      const request = this.joinAudit.get(requestId);
      if (request.groupId !== targetGroupId) {
        return { ok: false, text: "申请不属于该群。" };
      }
      await this.joinApproval.reject(targetGroupId, requestId, userId, reason);
    } catch (error) {
      log.warn("reject failed", { requestId, error: formatError(error) });
      return { ok: false, text: `审批失败：${formatError(error)}` };
    }
    log.info("rejected join request", {
      requestId,
      userId,
      hasReason: reason.length > 0,
    });
    return this.approvalResultCard(
      targetGroupId,
      userId,
      `已拒绝入群申请 ${this.displayRequest(requestId)}。`,
      true,
    );
  }

  private async handleRules(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const action = normalize(parts[1]);
    if (action === "set" || action === "设置") {
      return this.handleRulesSet(groupId, userId, parts);
    }
    return this.rulesCard(groupId, userId, parts);
  }

  /** 全局规则：仅超级管理员可查看。 */
  private handleGlobalRulesView(userId: string): CommandResult {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: GLOBAL_RULES_DENIED };
    }
    return { ok: true, text: this.formatGlobalRules() };
  }

  private async handleRulesSet(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    const args = parts.slice(2);
    if (isGlobalTarget(args[0])) {
      return this.handleGlobalRulesSet(userId, args.slice(1));
    }

    const targetGroupId = groupId ?? this.resolveTargetGroupId(undefined, args[0]);
    const field = groupId ? args[0] : args[1];
    const valueParts = groupId ? args.slice(1) : args.slice(2);

    if (!targetGroupId) {
      return {
        ok: false,
        text: "私信中设置规则需要提供已绑定的群号或 #群短码。用法：/rules set <群号|#群短码> <字段> <值>",
      };
    }
    if (!this.permissions.canManageRules(userId, targetGroupId)) {
      return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
    }
    if (!field || valueParts.length === 0) {
      return { ok: false, text: RULES_SET_USAGE };
    }

    const value = valueParts.join(" ").trim();
    let override: GroupConfigOverride;
    try {
      override = parseRuleSetting(targetGroupId, field, value, this.configStore);
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }

    this.configStore.setOverride(override);
    log.info("group rules updated", {
      groupId: targetGroupId,
      userId,
      field: normalize(field),
    });
    return {
      ok: true,
      text: `已更新群规则。\n\n${this.formatRules(targetGroupId)}`,
    };
  }

  /** 全局规则：仅超级管理员可修改。 */
  private async handleGlobalRulesSet(
    userId: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    if (!this.permissions.isSuperAdmin(userId)) {
      return { ok: false, text: GLOBAL_RULES_DENIED };
    }
    const field = args[0];
    const valueParts = args.slice(1);
    if (!field || valueParts.length === 0) {
      return { ok: false, text: GLOBAL_RULES_SET_USAGE };
    }

    const value = valueParts.join(" ").trim();
    let override: GroupConfigOverride;
    try {
      override = parseRuleSetting(DEFAULT_GROUP_ID, field, value, this.configStore);
    } catch (error) {
      return { ok: false, text: `设置失败：${formatError(error)}` };
    }

    this.configStore.setOverride(override);
    log.info("global rules updated", { userId, field: normalize(field) });
    return {
      ok: true,
      text: `已更新全局规则（影响所有未单独覆盖的群）。\n\n${this.formatGlobalRules()}`,
    };
  }

  private formatRules(targetGroupId: string): string {
    return formatEffectiveConfig(
      this.configStore.get(targetGroupId),
      `群 ${this.displayGroup(targetGroupId)} 规则配置：`,
    );
  }

  private formatGlobalRules(): string {
    return formatEffectiveConfig(
      this.configStore.default,
      "全局默认规则（未单独配置的群继承）：",
    );
  }

  private handleAudit(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    const { page, rest } = extractPageToken(parts);
    const targetGroupId = this.resolveTargetGroupId(groupId, rest[0]);
    if (!targetGroupId) {
      const card = renderCard({
        title: "审计记录",
        lines: [
          "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
          "用法：/audit [群号|#群短码] [每页数量] [+页码]",
        ],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const limit = clampLimit(groupId !== undefined ? rest[0] : rest[1]);
    return this.auditCard(targetGroupId, userId, page, limit);
  }

  private handleStatus(
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): CommandResult {
    return this.statusCard(groupId, userId, parts);
  }

  private handleTest(groupId: string | undefined, userId: string): CommandResult {
    return this.testCard(groupId, userId);
  }
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

/** 查看/导航类按钮（标准：点击即回包 + 重发卡片）。 */
function viewButton(
  id: string,
  label: string,
  namespace: string,
  action: string,
  ...args: readonly (string | number)[]
): CardButton {
  return {
    id,
    label,
    callbackData: encodeCallback(namespace, action, ...args),
  };
}

/** 执行动作类按钮（标准：点击=发送指令，与手输同一条权限/审计路径）。 */
function actionButton(
  id: string,
  label: string,
  command: string,
  options: { style?: CardButtonStyle; modal?: KeyboardModal } = {},
): CardButton {
  return {
    id,
    label,
    command,
    ...(options.style !== undefined ? { style: options.style } : {}),
    ...(options.modal !== undefined ? { modal: options.modal } : {}),
  };
}

/**
 * 把已有文本结果包成卡片：正文行沿用原文本，因此**纯文本降级与旧输出等价**，
 * 按钮只是在此之上加的可选交互。
 */
function cardFromText(
  title: string,
  text: string,
  options: {
    rows?: readonly (readonly CardButton[])[];
    buttonHint?: string;
    footer?: readonly string[];
  } = {},
): CardResult {
  const rich = renderCard({
    title,
    lines: text.split("\n"),
    ...(options.rows ? { rows: options.rows } : {}),
    ...(options.buttonHint !== undefined
      ? { buttonHint: options.buttonHint }
      : {}),
    ...(options.footer ? { footer: options.footer } : {}),
  });
  return { ok: true, text: rich.text, rich };
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "（空）";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindingFailureText(): string {
  return "绑定失败：数据库写入异常，请查看服务端日志后重试。";
}

const RULE_FIELDS_HELP = [
  "  keywords 广告,刷屏 / keywords clear",
  "  warning <文案> / warning clear",
  "  muteDuration <秒>",
  "  wordFilter on|off",
  "  joinAudit on|off",
  "  autoApprove on|off",
  "  export on|off",
  "  enabled on|off",
  "  keywordRecall on|off                  命中关键词是否撤回消息",
  "  keywordPunish none|mute|kick|kick_blacklist   命中关键词的处罚动作",
  "  joinDecision manual|auto_approve|approve_on_match|reject_on_match|reject_on_mismatch",
  "  joinRequireClass on|off               入群答案必须包含班级库中的班级",
  "  joinRequireName on|off                入群答案必须包含姓名",
  "  joinAnswerPattern <正则> / clear      入群答案必须匹配的额外正则",
  "  joinReviewOpinion on|off              人工审核时是否给出审核意见",
  "  notifyAutoApproved on|off             机器人自动通过/拒绝的申请是否也推送给审核员",
];

const RULES_SET_USAGE = [
  "用法：/rules set <字段> <值>",
  "字段：",
  ...RULE_FIELDS_HELP,
  "私信中使用：/rules set <group_openid> <字段> <值>",
].join("\n");

const GLOBAL_RULES_SET_USAGE = [
  "用法：/rules set all <字段> <值>（仅超级管理员）",
  "字段：",
  ...RULE_FIELDS_HELP,
].join("\n");

const GLOBAL_RULES_DENIED =
  "权限不足：全局规则仅超级管理员可以查看与修改。";

const MAX_MUTE_DURATION_SECONDS = 30 * 24 * 60 * 60;
const MAX_AUDIT_LIMIT = 50;
const DEFAULT_AUDIT_LIMIT = 10;
const GLOBAL_TARGETS = new Set(["all", "global", "default", "全局", "默认"]);
/** `/perm grant gsuper` 的别名：本群超级管理员。 */
const GROUP_SUPER_ROLES = new Set([
  "gsuper",
  "groupsuper",
  "群超管",
  "本群超管",
  "群超级管理员",
]);
const PERM_USAGE = [
  "用法：",
  "/perm list [#群短码|群号]",
  "/perm grant|revoke super <userId|QQ号> - 全局超级管理员",
  "/perm grant|revoke gsuper [#群短码|群号] <userId|QQ号> - 本群超级管理员",
  "/perm grant|revoke admin [#群短码|群号] <userId|QQ号> - 群管理员",
  "/perm grant|revoke mod [#群短码|群号] <userId|QQ号> - 审核员",
].join("\n");
const TOGGLE_ON = new Set(["on", "true", "1", "yes", "y", "开", "启用", "是"]);
const TOGGLE_OFF = new Set(["off", "false", "0", "no", "n", "关", "关闭", "否"]);
const CLEAR_WORDS = new Set(["clear", "清空", "默认", "reset"]);
/** `/notify all on` 里的「全部群」写法。 */
const NOTIFY_ALL_WORDS = new Set([
  "all",
  "global",
  "全部",
  "全局",
  "所有",
  "默认",
]);
const NOTIFY_USAGE = [
  "用法：",
  "  /notify                              查看当前推送订阅",
  "  /notify on|off                       群内=本群；私信=你担任群管理员的全部群",
  "  /notify all on|off                   全部群（群内/私信均可）",
  "  /notify <群号|group_openid|#群短码> on|off    指定群",
  "  /notify test                         给自己发一张推送测试卡片",
].join("\n");
const NOTIFY_PERMISSION_DENIED =
  "权限不足：入群审批需要群管理员或以上权限（推送与快捷按钮只发给能审批的人）。";

function isToggleValue(value: string | undefined): value is string {
  const normalized = normalize(value);
  return TOGGLE_ON.has(normalized) || TOGGLE_OFF.has(normalized);
}

function isToggleOn(value: string): boolean {
  return TOGGLE_ON.has(normalize(value));
}

function isAllScope(value: string | undefined): boolean {
  return NOTIFY_ALL_WORDS.has(normalize(value));
}

/** `/profile set` 的字段别名。 */
const PROFILE_FIELD_ALIASES: Record<string, UserProfileField> = {
  name: "name",
  姓名: "name",
  名字: "name",
  id: "studentId",
  studentid: "studentId",
  学号: "studentId",
  class: "className",
  classname: "className",
  班级: "className",
  college: "college",
  学院: "college",
  year: "year",
  年级: "year",
};

/** 回执里显示的中文字段名。 */
const PROFILE_FIELD_LABELS: Record<UserProfileField, string> = {
  name: "姓名",
  studentId: "学号",
  className: "班级",
  college: "学院",
  year: "年级",
};

const PROFILE_USAGE = [
  "用法：",
  "  /profile                                 查看个人资料",
  "  /profile set name <姓名>                  姓名",
  "  /profile set id <11位学号>                学号（前两位决定年级：22-26）",
  "  /profile set class <班级>                 班级（必须在班级库里，自动带出学院）",
  "  /profile set college <学院>               学院（可手动覆盖）",
  "  /profile set year <年级>                  年级（可手动覆盖，如 2022 或 22）",
  "  /profile set <字段> clear                 清除单个字段",
  "  /profile clear                            清空整份资料",
].join("\n");

const ACTIVITY_USAGE = [
  "用法：",
  "  /activity                                查看本群活动列表",
  "  /activity list <群号|#群短码>             查看指定群活动",
  "  /activity create <标题>                   创建活动（群管理员+；私信需先写群号）",
  "  /activity set <#活动短码> <字段> <值>       配置（标题/简介/名额/群号/链接/学院/年级限制）",
  "  /activity open <#活动短码>                 开放报名并把卡片发到群里",
  "  /activity close|/activity cancel <#活动短码>  关闭 / 取消活动",
  "  /activity join <#活动短码> [备注]           报名（需 /profile 完整）",
  "  /activity quit <#活动短码>                 取消报名",
  "  /activity info <#活动短码>                 活动详情",
  "  /activity signups <#活动短码>              报名名单（群管理员/发布者）",
].join("\n");

const ACTIVITY_SET_USAGE = [
  "用法：/activity set <#活动短码> <字段> <值>",
  "字段（大小写不敏感，clear 清空）：",
  "  title <标题>                              活动标题",
  "  desc <简介>                               活动简介",
  "  capacity <人数>                            名额上限",
  "  group <群号>                               展示用活动群号",
  "  link <url> / link <说明=url>               追加一个链接（可多次）",
  "  links clear                               清空链接",
  "  allowColleges / denyColleges <学院列表>     学院白名单 / 黑名单",
  "  allowYears / denyYears <年级列表>           年级白名单 / 黑名单（22/23/…）",
].join("\n");

/** 逗号/顿号/空格分隔的列表。 */
function parseList(value: string): string[] {
  return value
    .split(/[,，、\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 年级列表：22 / 2022 都接受，统一存 2 位。 */
function parseYearList(value: string): string[] {
  return parseList(value).map((item) => normalizeYear(item).slice(2));
}

/** `<说明=url>` 或纯 url。 */
function parseLink(value: string): ActivityLink {
  const index = value.indexOf("=");
  if (index > 0 && !value.slice(0, index).includes(":")) {
    const label = value.slice(0, index).trim();
    const url = value.slice(index + 1).trim();
    if (label.length > 0 && /^https?:\/\//u.test(url)) {
      return { label, url };
    }
  }
  if (!/^https?:\/\//u.test(value)) {
    throw new Error("链接必须以 http:// 或 https:// 开头");
  }
  return { label: "活动链接", url: value };
}

function parseLinks(value: string): ActivityLink[] {
  return parseList(value).map((item) => parseLink(item));
}

function parsePositiveInt(field: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} 需要正整数`);
  }
  return parsed;
}

/** `/rules all`、`/rules 全局`、`/rules set default ...` 都指向全局规则。 */
function isGlobalTarget(value: string | undefined): boolean {
  return GLOBAL_TARGETS.has(normalize(value));
}

function formatEffectiveConfig(
  config: EffectiveGroupConfig,
  header: string,
): string {
  const keywords =
    config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）";
  return [
    header,
    `启用：${config.enabled}`,
    `关键词过滤：${config.wordFilterEnabled}`,
    `关键词：${keywords}`,
    `关键词撤回：${config.keywordRecall}`,
    `命中处罚：${config.keywordPunish}`,
    `入群审核：${config.joinAuditEnabled}`,
    `入群决策：${config.joinDecision}`,
    `入群要求：班级 ${config.joinRequireClass} · 姓名 ${config.joinRequireName}${
      config.joinAnswerPattern ? ` · 正则 /${config.joinAnswerPattern}/` : ""
    }`,
    `审核意见：${config.joinReviewOpinion}`,
    `自动通过：${config.autoApproveJoin}`,
    `自动处理也通知：${config.notifyAutoApproved}`,
    `导出功能：${config.exportEnabled}`,
    `警告文案：${config.warningMessage}`,
    `禁言时长：${config.muteDurationSeconds} 秒`,
  ].join("\n");
}

function parseRuleSetting(
  groupId: string,
  field: string,
  value: string,
  configStore: GroupConfigStore,
): GroupConfigOverride {
  const cleared = CLEAR_WORDS.has(value.toLowerCase());
  switch (normalize(field)) {
    case "keywords":
    case "keyword":
    case "关键词":
      return {
        groupId,
        keywords: cleared
          ? []
          : value
              .split(/[,，、\s]+/u)
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
      };
    case "warning":
    case "warningmessage":
    case "警告":
      return {
        groupId,
        warningMessage: cleared
          ? groupId === DEFAULT_GROUP_ID
            ? configStore.builtinDefault.warningMessage
            : configStore.default.warningMessage
          : value,
      };
    case "muteduration":
    case "mute":
    case "禁言时长":
      return { groupId, muteDurationSeconds: parseDuration(value) };
    case "autoapprove":
    case "自动通过":
      return { groupId, autoApproveJoin: parseToggle(field, value) };
    case "joinaudit":
    case "入群审核":
      return { groupId, joinAuditEnabled: parseToggle(field, value) };
    case "wordfilter":
    case "关键词过滤":
      return { groupId, wordFilterEnabled: parseToggle(field, value) };
    case "export":
    case "导出":
      return { groupId, exportEnabled: parseToggle(field, value) };
    case "enabled":
    case "启用":
      return { groupId, enabled: parseToggle(field, value) };
    case "keywordrecall":
    case "recall":
    case "撤回":
      return { groupId, keywordRecall: parseToggle(field, value) };
    case "keywordpunish":
    case "punish":
    case "处罚":
      return { groupId, keywordPunish: parseKeywordPunish(value) };
    case "joindecision":
    case "入群决策":
      return { groupId, joinDecision: parseJoinDecision(value) };
    case "joinrequireclass":
    case "requireclass":
    case "要求班级":
      return { groupId, joinRequireClass: parseToggle(field, value) };
    case "joinrequirename":
    case "requirename":
    case "要求姓名":
      return { groupId, joinRequireName: parseToggle(field, value) };
    case "joinanswerpattern":
    case "answerpattern":
    case "入群正则":
      return {
        groupId,
        joinAnswerPattern: cleared ? "" : requireValidRegex(value),
      };
    case "joinreviewopinion":
    case "审核意见":
      return { groupId, joinReviewOpinion: parseToggle(field, value) };
    case "notifyautoapproved":
    case "autonotify":
    case "通知自动通过":
    case "通知自动处理":
      return { groupId, notifyAutoApproved: parseToggle(field, value) };
    default:
      throw new Error(`未知字段：${field}`);
  }
}

function parseKeywordPunish(value: string): KeywordPunish {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, KeywordPunish> = {
    none: KeywordPunish.None,
    off: KeywordPunish.None,
    "无": KeywordPunish.None,
    "不处罚": KeywordPunish.None,
    mute: KeywordPunish.Mute,
    "禁言": KeywordPunish.Mute,
    kick: KeywordPunish.Kick,
    "踢出": KeywordPunish.Kick,
    "移出": KeywordPunish.Kick,
    kick_blacklist: KeywordPunish.KickBlacklist,
    blacklist: KeywordPunish.KickBlacklist,
    "踢出并拉黑": KeywordPunish.KickBlacklist,
    "拉黑": KeywordPunish.KickBlacklist,
  };
  const parsed = aliases[normalized];
  if (!parsed) {
    throw new Error("处罚动作需要 none / mute / kick / kick_blacklist");
  }
  return parsed;
}

function parseJoinDecision(value: string): JoinDecisionModeType {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, JoinDecisionMode> = {
    manual: JoinDecisionMode.Manual,
    "人工": JoinDecisionMode.Manual,
    "人工审核": JoinDecisionMode.Manual,
    auto: JoinDecisionMode.AutoApprove,
    auto_approve: JoinDecisionMode.AutoApprove,
    "自动通过": JoinDecisionMode.AutoApprove,
    approve_on_match: JoinDecisionMode.ApproveOnMatch,
    "命中通过": JoinDecisionMode.ApproveOnMatch,
    reject_on_match: JoinDecisionMode.RejectOnMatch,
    "命中拒绝": JoinDecisionMode.RejectOnMatch,
    reject_on_mismatch: JoinDecisionMode.RejectOnMismatch,
    "未命中拒绝": JoinDecisionMode.RejectOnMismatch,
  };
  const parsed = aliases[normalized];
  if (!parsed) {
    throw new Error(
      "入群决策需要 manual / auto_approve / approve_on_match / reject_on_match / reject_on_mismatch",
    );
  }
  return parsed;
}

function requireValidRegex(value: string): string {
  try {
    new RegExp(value, "u");
    return value;
  } catch (error) {
    throw new Error(
      `入群正则不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseToggle(field: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TOGGLE_ON.has(normalized)) {
    return true;
  }
  if (TOGGLE_OFF.has(normalized)) {
    return false;
  }
  throw new Error(`${field} 需要 on 或 off`);
}

function parseDuration(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("禁言时长需要非负整数（秒）");
  }
  return Math.min(parsed, MAX_MUTE_DURATION_SECONDS);
}

function clampLimit(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function formatTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}
