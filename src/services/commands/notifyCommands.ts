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
    if (arg1 === "punish" || arg1 === "处罚" || arg1 === "违规") {
      return handlePunishNotify(ctx, groupId, userId, parts);
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

/** `/notify punish [on|off|all on|test|<群> on]`：处罚事件推送的独立开关（§B7）。 */
async function handlePunishNotify(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  if (!ctx.notifications) {
    return { ok: false, text: "推送服务未启用。" };
  }
  const arg2 = normalize(parts[2]);
  if (!arg2) {
    return notifyPunishCard(ctx, groupId, userId);
  }
  if (arg2 === "test" || arg2 === "测试") {
    return notifyPunishTestCard(ctx, groupId, userId, groupId);
  }
  if (isToggleValue(arg2)) {
    // 群内：订阅本群；私信：订阅全部群（与 /notify on|off 一致）
    const scope = groupId ?? NOTIFY_SCOPE_ALL;
    return notifyPunishToggleCard(ctx, scope, isToggleOn(arg2), userId, groupId);
  }
  if (isAllScope(arg2)) {
    const action = normalize(parts[3]);
    if (!isToggleValue(action)) {
      return notifyPunishCard(ctx, groupId, userId, NOTIFY_USAGE);
    }
    return notifyPunishToggleCard(
      ctx,
      NOTIFY_SCOPE_ALL,
      isToggleOn(action),
      userId,
      groupId,
    );
  }
  const targetGroupId = ctx.helpers.resolveTargetGroupId(undefined, parts[2]);
  const action = normalize(parts[3]);
  if (!targetGroupId || !isToggleValue(action)) {
    return notifyPunishCard(ctx, groupId, userId, NOTIFY_USAGE);
  }
  return notifyPunishToggleCard(
    ctx,
    targetGroupId,
    isToggleOn(action),
    userId,
    groupId,
  );
}

/** 处罚通知订阅卡（与入群申请订阅完全独立）。 */
export function notifyPunishCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  notice?: string,
): CardResult {
  if (!ctx.notifications) {
    const card = renderCard({
      title: "处罚通知推送",
      lines: ["推送服务未启用。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const scopes = ctx.notifications.listScopes(userId, "punish");
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
  const reviewable = [
    ...new Set([
      ...ctx.permissions.listReviewableGroups(userId),
      ...ctx.permissions.listModeratedGroups(userId),
    ]),
  ].sort();
  lines.push(
    reviewable.length > 0
      ? `**可审核的群**：${reviewable.map((id) => ctx.helpers.groupLabel(id)).join("、")}`
      : "**可审核的群**：无（内容审核需要审核员或以上权限）",
  );
  lines.push(
    "",
    "订阅后：关键词命中并处罚（撤回 / 禁言 / 踢出 / 拉黑）时会私聊推送卡片，",
    "卡片上可直接解除处罚、改禁言时长、踢出、拉黑本群或全局（全局仅超管）。",
  );

  const rows: CardButton[][] = [];
  const switchRow: CardButton[] = [];
  if (groupId) {
    switchRow.push(
      viewButton(
        "punishThisGroup",
        `本群 ${scopes.includes(groupId) ? "关" : "开"}`,
        "notify",
        "punishToggle",
        groupId,
        scopes.includes(groupId) ? "off" : "on",
      ),
    );
  }
  switchRow.push(
    viewButton(
      "punishAllGroups",
      `全部群 ${allOn ? "关" : "开"}`,
      "notify",
      "punishToggle",
      NOTIFY_SCOPE_ALL,
      allOn ? "off" : "on",
    ),
  );
  rows.push(switchRow);
  rows.push([
    viewButton("punishTest", "测试推送", "notify", "punishTest", groupId ?? ""),
    viewButton("punishRefresh", "刷新", "notify", "punishView"),
  ]);

  return cardFromText("处罚通知推送", lines.join("\n"), {
    rows,
    buttonHint: "点击即生效：",
    footer: [
      "与入群申请推送相互独立：/notify 管理申请推送，/notify punish 管理处罚推送。",
    ],
  });
}

/** 回调：处罚通知订阅开关。 */
export function notifyPunishToggleCard(
  ctx: AdminCommandContext,
  scope: string,
  enabled: boolean,
  userId: string,
  replyGroupId?: string,
): CardResult {
  if (!ctx.notifications) {
    return notifyPunishCard(ctx, undefined, userId);
  }
  const label =
    scope === NOTIFY_SCOPE_ALL
      ? "全部群（你有审核权限的群）"
      : `群 ${ctx.helpers.groupLabel(scope)}`;
  const notice = ctx.helpers.mention(replyGroupId, userId);
  if (!enabled) {
    const removed = ctx.notifications.unsubscribe(userId, scope, "punish");
    return notifyPunishCard(
      ctx,
      scope === NOTIFY_SCOPE_ALL ? undefined : scope,
      userId,
      `${notice}${removed ? `已关闭：${label} 的处罚通知。` : `${label} 的处罚通知本来就是关闭的。`}`,
    );
  }
  const allowed =
    scope === NOTIFY_SCOPE_ALL
      ? ctx.permissions.isSuperAdmin(userId) ||
        ctx.permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator)
      : ctx.permissions.canReviewContent(userId, scope);
  if (!allowed) {
    return notifyPunishCard(
      ctx,
      scope === NOTIFY_SCOPE_ALL ? undefined : scope,
      userId,
      `${notice}权限不足：处罚通知只推送给该群审核员或以上成员。`,
    );
  }
  ctx.notifications.subscribe(userId, scope, "punish");
  return notifyPunishCard(
    ctx,
    scope === NOTIFY_SCOPE_ALL ? undefined : scope,
    userId,
    `${notice}已开启：${label} 的处罚通知。`,
  );
}

/** 回调 / 指令：给自己发一张处罚通知测试卡。 */
export async function notifyPunishTestCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  replyGroupId?: string,
): Promise<CardResult> {
  if (!ctx.notifications) {
    return notifyPunishCard(ctx, groupId, userId);
  }
  const targetGroupId =
    groupId && ctx.permissions.canReviewContent(userId, groupId)
      ? groupId
      : ctx.permissions.listModeratedGroups(userId)[0];
  const card = renderCard({
    title: "处罚通知测试",
    lines: [
      "能看到这张卡片说明处罚 / 申诉推送通道正常。",
      ...(targetGroupId
        ? [`- 群：${ctx.helpers.groupLabel(targetGroupId)}`]
        : ["- 还没有可审核的群：先在群里把自己设为审核员或以上，才有处罚通知可订阅"]),
      "",
      "真实的处罚卡片上会有「解除处罚 / 禁言时长 / 踢出 / 拉黑」按钮。",
    ],
    rows: [[viewButton("punishBack", "返回订阅", "notify", "punishView")]],
    footer: ["用法：/notify punish on|off"],
  });
  const sent = await ctx.notifications.sendPrivateCard(userId, card);
  const notice = `${ctx.helpers.mention(replyGroupId, userId)}${
    sent.ok ? "已发送测试卡片，请查看私聊。" : `测试推送失败：${sent.detail}`
  }`;
  const result = notifyPunishCard(ctx, groupId, userId, notice);
  return { ...result, ok: sent.ok };
}

