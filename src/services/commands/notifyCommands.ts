import { PermissionLevel } from "../../core/enums.js";
import { getLogger } from "../../core/logger.js";
import { renderCard } from "../cardTemplate.js";
import type { CardButton } from "../cardTemplate.js";
import { NOTIFY_SCOPE_ALL } from "../notifications.js";
import type { AdminCommandContext } from "./context.js";
import {
  NOTIFY_PERMISSION_DENIED,
  NOTIFY_USAGE,
  actionButton,
  cardFromText,
  formatError,
  isAllScope,
  isToggleOn,
  isToggleValue,
  normalize,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

const log = getLogger("notify-commands");

/**
 * `/notify` 领域模块：入群申请推送的订阅、开关与自检。
 */
export function notifyCard(
  ctx: AdminCommandContext,
    groupId: string | undefined,
    userId: string,
    notice?: string,
  ): CardResult {
    if (!ctx.notifications) {
      const card = renderCard({
        title: "入群申请推送",
        lines: ["推送服务未启用。"],
        rows: [[viewButton("help", "指令帮助", "help", "home")]],
      });
      return { ok: false, text: card.text, rich: card };
    }
    const scopes = ctx.notifications.listScopes(userId);
    const allOn = scopes.includes(NOTIFY_SCOPE_ALL);
    const lines = [
      ...ctx.helpers.renderNotice(notice),
      `**全部群**：${allOn ? "已开启" : "未开启"}`,
    ];
    if (groupId) {
      lines.push(
        `**当前群**：${scopes.includes(groupId) ? "已开启" : "未开启"}（${ctx.helpers.groupLabel(groupId)}）`,
      );
    }
    for (const scope of scopes.filter((item) => item !== NOTIFY_SCOPE_ALL)) {
      lines.push(`**已订阅**：群 ${ctx.helpers.groupLabel(scope)}`);
    }
    const reviewable = ctx.permissions.listReviewableGroups(userId);
    lines.push(
      reviewable.length > 0
        ? `**可审批的群**：${reviewable.map((id) => ctx.helpers.groupLabel(id)).join("、")}`
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

    });
  }

  /** 回调：订阅开关（固定动作 → 自动生效并回刷新后的卡片）。 */
export async function notifyToggleCard(
  ctx: AdminCommandContext,
    scope: string,
    enabled: boolean,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    if (!ctx.notifications) {
      return notifyCard(ctx, undefined, userId);
    }
    const result = applyNotify(ctx, userId, scope, enabled);
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
    return notifyCard(ctx, 
      groupContext,
      userId,
      `${ctx.helpers.mention(replyGroupId, userId)}${result.text.split("\n")[0]}`,
    );
  }

  /** 回调：测试推送（固定动作 → 直接给自己发一张测试卡并回结果）。 */
export async function notifyTestCard(
  ctx: AdminCommandContext,
    groupId: string | undefined,
    userId: string,
    replyGroupId?: string,
  ): Promise<CardResult> {
    if (!ctx.notifications) {
      return notifyCard(ctx, groupId, userId);
    }
    const result = await ctx.notifications.sendTestCard(userId, groupId);
    const notice = `${ctx.helpers.mention(replyGroupId, userId)}${result.text.split("\n")[0]}`;
    const card = notifyCard(ctx, groupId, userId, notice);
    return { ...card, ok: result.ok };
  }

  /**
   * `/audit [群号|#群短码] [每页数量] [+页码]`：审计记录卡。
   *
   * 正文沿用原格式（时间 / 动作 / 状态 / 操作人 / 对象），翻页为回调，
   * 纯文本降级给出 `/audit +<页码>`。
   */
export async function handleNotify(
  ctx: AdminCommandContext,
    groupId: string | undefined,
    userId: string,
    parts: readonly string[],
  ): Promise<CommandResult> {
    if (!ctx.notifications) {
      return { ok: false, text: "推送服务未启用。" };
    }
    const arg1 = normalize(parts[1]);
    if (!arg1) {
      return notifyCard(ctx, groupId, userId);
    }
    if (arg1 === "test" || arg1 === "测试") {
      return notifyTestCard(ctx, groupId, userId, groupId);
    }
    if (isToggleValue(arg1)) {
      // 群内：订阅本群；私信：订阅全部群
      const scope = groupId ?? NOTIFY_SCOPE_ALL;
      return notifyToggleCard(ctx, scope, isToggleOn(arg1), userId, groupId);
    }
    if (isAllScope(arg1)) {
      const action = normalize(parts[2]);
      if (!isToggleValue(action)) {
        return notifyCard(ctx, groupId, userId, NOTIFY_USAGE);
      }
      return notifyToggleCard(ctx, NOTIFY_SCOPE_ALL, isToggleOn(action), userId, groupId);
    }
    const targetGroupId = ctx.helpers.resolveTargetGroupId(undefined, parts[1]);
    const action = normalize(parts[2]);
    if (!targetGroupId || !isToggleValue(action)) {
      return notifyCard(ctx, groupId, userId, NOTIFY_USAGE);
    }
    return notifyToggleCard(ctx, targetGroupId, isToggleOn(action), userId, groupId);
  }

export function applyNotify(
  ctx: AdminCommandContext,
    userId: string,
    scope: string,
    enabled: boolean,
  ): CommandResult {
    const label =
      scope === NOTIFY_SCOPE_ALL
        ? "全部群（你担任群管理员的群）"
        : `群 ${ctx.helpers.groupLabel(scope)}`;
    if (!enabled) {
      const removed = ctx.notifications?.unsubscribe(userId, scope) ?? false;
      return {
        ok: true,
        text: removed
          ? `已关闭：${label} 的入群申请推送。`
          : `${label} 的推送本来就是关闭的。`,
      };
    }
    const allowed =
      scope === NOTIFY_SCOPE_ALL
        ? ctx.permissions.isSuperAdmin(userId) ||
          ctx.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin)
        : ctx.permissions.canApproveJoin(userId, scope);
    if (!allowed) {
      return { ok: false, text: NOTIFY_PERMISSION_DENIED };
    }
    ctx.notifications?.subscribe(userId, scope);
    return {
      ok: true,
      text:
        `已开启：${label} 的入群申请推送。\n` +
        "有新的待审批申请时会私聊推送卡片，可直接点「同意 / 拒绝」按钮。",
    };
  }

