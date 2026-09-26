import { PermissionLevel } from "../../core/enums.js";
import { getLogger } from "../../core/logger.js";
import { renderCard, type CardButton } from "../cardTemplate.js";
import {
  NOTIFY_CHANNELS,
  NOTIFY_SCOPE_ALL,
  type NotifyChannel,
} from "../notifications.js";
import type { AdminCommandContext } from "./context.js";
import {
  cardFromText,
  viewButton,
  type CardResult,
  type CommandResult,
} from "./support.js";

const log = getLogger("notify-commands");

/**
 * 统一通知订阅菜单（重构后唯一入口）。
 *
 * 三个频道共用一张 `notification_subscriptions` 表（存储键 `频道:范围`），
 * 订阅只通过**这张卡的按钮**完成：老的 `/notify on|off|all|<群>|punish` 与
 * `/activity subscribe|unsubscribe` 已删除，不做兼容。
 */
export const NOTIFY_CHANNEL_META: Record<
  NotifyChannel,
  { label: string; short: string; hint: string }
> = {
  join: {
    label: "入群申请",
    short: "入群",
    hint: "有新的待处理入群申请（或自动处理结果）时私信你",
  },
  punish: {
    label: "处罚与申诉",
    short: "处罚",
    hint: "关键词处罚、申诉派发与申诉结果私信你",
  },
  activity: {
    label: "活动通知",
    short: "活动",
    hint: "群里有新活动发布时私信你",
  },
};

export function isNotifyChannel(value: string | undefined): value is NotifyChannel {
  return (NOTIFY_CHANNELS as readonly string[]).includes(value ?? "");
}

function channelLabel(channel: NotifyChannel): string {
  return NOTIFY_CHANNEL_META[channel].label;
}

/** 订阅范围在卡片上的写法。 */
function scopeLabel(ctx: AdminCommandContext, scope: string): string {
  return scope === NOTIFY_SCOPE_ALL
    ? "全部群"
    : `群 ${ctx.helpers.groupLabel(scope)}`;
}

/**
 * 统一订阅菜单。
 *
 * 群内：每个频道一行「本群 / 全部 / 测试」；私信：只有「全部 / 测试」
 * （要订某个具体群，到那个群里发 `/notify`）。
 */
export function notifyCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  notice?: string,
  _channel?: NotifyChannel,
): CardResult {
  if (!ctx.notifications) {
    const card = renderCard({
      title: "通知订阅",
      lines: ["推送服务未启用。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const lines = [...ctx.helpers.renderNotice(notice)];
  for (const channel of NOTIFY_CHANNELS) {
    const scopes = ctx.notifications.listScopes(userId, channel);
    const here = groupId !== undefined && scopes.includes(groupId);
    const parts: string[] = [];
    if (groupId !== undefined) {
      parts.push(`本群 ${here ? "开" : "关"}`);
    }
    parts.push(`全部 ${scopes.includes(NOTIFY_SCOPE_ALL) ? "开" : "关"}`);
    lines.push(`**${channelLabel(channel)}**：${parts.join(" · ")}`);
  }
  lines.push(
    "",
    "「全部」= 所有装了机器人的群（绑定是全局的：在一个群绑过 QQ 号即可）。",
    "入群申请需要群管理员及以上、处罚与申诉需要审核员及以上才会推送给你。",
  );

  const rows: CardButton[][] = [];
  for (const channel of NOTIFY_CHANNELS) {
    const meta = NOTIFY_CHANNEL_META[channel];
    const scopes = ctx.notifications.listScopes(userId, channel);
    const row: CardButton[] = [];
    if (groupId !== undefined) {
      row.push(
        viewButton(
          `${channel}ThisGroup`,
          `${meta.short} 本群`,
          "notify",
          "set",
          channel,
          groupId,
          scopes.includes(groupId) ? "off" : "on",
        ),
      );
    }
    row.push(
      viewButton(
        `${channel}AllGroups`,
        `${meta.short} 全部`,
        "notify",
        "set",
        channel,
        NOTIFY_SCOPE_ALL,
        scopes.includes(NOTIFY_SCOPE_ALL) ? "off" : "on",
      ),
    );
    row.push(
      viewButton(`${channel}Test`, "测试", "notify", "test", channel),
    );
    rows.push(row);
  }
  rows.push([
    viewButton("refresh", "刷新", "notify", "view"),
    viewButton("help", "指令帮助", "help", "topic", "notify"),
  ]);

  return cardFromText("通知订阅", lines.join("\n"), { rows });
}

/** 回调：订阅开关（`cb:notify:set:<频道>:<范围>:<on|off>`）。 */
export function notifyToggleCard(
  ctx: AdminCommandContext,
  channel: string,
  scope: string,
  enabled: boolean,
  userId: string,
  replyGroupId?: string,
): CardResult {
  const groupId = scope === NOTIFY_SCOPE_ALL ? undefined : scope;
  if (!ctx.notifications || !isNotifyChannel(channel) || scope.length === 0) {
    return notifyCard(ctx, groupId, userId);
  }
  const label = `${channelLabel(channel)} · ${scopeLabel(ctx, scope)}`;
  const notice = ctx.helpers.mention(replyGroupId, userId);

  if (!enabled) {
    const removed = ctx.notifications.unsubscribe(userId, scope, channel);
    return notifyCard(
      ctx,
      groupId,
      userId,
      `${notice}${removed ? `已关闭：${label}。` : `${label} 本来就是关闭的。`}`,
    );
  }

  const check = canSubscribe(ctx, userId, channel, scope);
  if (!check.ok) {
    // 订阅失败要带 `ok: false`（卡片内容仍是菜单，方便直接改订别的频道）
    return {
      ...notifyCard(ctx, groupId, userId, `${notice}${check.reason}`),
      ok: false,
    };
  }
  ctx.notifications.subscribe(userId, scope, channel);
  log.info("notification subscription updated via callback", {
    channel,
    scope,
    userId,
  });
  return notifyCard(ctx, groupId, userId, `${notice}已开启：${label}。`);
}

/**
 * 订阅资格：与推送时的收件人判定（`NotificationService.canReceive`）保持一致，
 * 免得「订阅成功但永远收不到」。
 */
function canSubscribe(
  ctx: AdminCommandContext,
  userId: string,
  channel: NotifyChannel,
  scope: string,
): { ok: boolean; reason: string } {
  const all = scope === NOTIFY_SCOPE_ALL;
  if (channel === "join") {
    const allowed = all
      ? ctx.permissions.isSuperAdmin(userId) ||
        ctx.permissions.hasAnyGroupRole(userId, PermissionLevel.GroupAdmin)
      : ctx.permissions.canApproveJoin(userId, scope);
    return allowed
      ? { ok: true, reason: "" }
      : { ok: false, reason: "权限不足：入群申请推送只发给群管理员及以上。" };
  }
  if (channel === "punish") {
    const allowed = all
      ? ctx.permissions.isSuperAdmin(userId) ||
        ctx.permissions.hasAnyGroupRole(userId, PermissionLevel.Moderator)
      : ctx.permissions.canReviewContent(userId, scope);
    return allowed
      ? { ok: true, reason: "" }
      : { ok: false, reason: "权限不足：处罚与申诉推送只发给审核员及以上。" };
  }
  // 活动通知不限权限；但「全部群」必须是已绑定 QQ 号的用户（绑定是全局的）
  if (all && ctx.identityMap?.getQq(userId) === undefined) {
    return {
      ok: false,
      reason: "订阅「全部群」的活动通知需要先绑定 QQ 号（/bind）。",
    };
  }
  return { ok: true, reason: "" };
}

/** `/notify`：打开统一订阅菜单；`/notify test [频道]` 直接自检某个频道。 */
export async function handleNotify(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  if (!ctx.notifications) {
    return { ok: false, text: "推送服务未启用。" };
  }
  const arg = (parts[1] ?? "").trim().toLowerCase();
  if (arg === "test" || arg === "测试") {
    const requested = (parts[2] ?? "").trim();
    const channel: NotifyChannel = isNotifyChannel(requested)
      ? requested
      : "join";
    return notifyTestCard(ctx, channel, userId, groupId, groupId);
  }
  return notifyCard(ctx, groupId, userId);
}

/** 回调 / 指令：给自己发一张该频道的测试卡，验证推送通道。 */
export async function notifyTestCard(
  ctx: AdminCommandContext,
  channel: NotifyChannel,
  userId: string,
  replyGroupId?: string,
  groupId?: string,
): Promise<CardResult> {
  if (!ctx.notifications) {
    return notifyCard(ctx, groupId, userId);
  }
  const meta = NOTIFY_CHANNEL_META[channel];
  let sent: { ok: boolean; detail: string };
  if (channel === "join") {
    // 入群申请那张测试卡带「查看待审批」按钮，沿用它（验证按钮通道）
    const result = await ctx.notifications.sendTestCard(userId, groupId);
    sent = { ok: result.ok, detail: result.text };
    return {
      ...notifyCard(
        ctx,
        groupId,
        userId,
        `${ctx.helpers.mention(replyGroupId, userId)}${result.text.split("\n")[0]}`,
      ),
      ok: result.ok,
    };
  }

  const card = renderCard({
    title: `${meta.label}测试`,
    lines: [
      `能看到这张卡片说明「${meta.label}」推送通道正常。`,
      `- 用途：${meta.hint}`,
      groupId
        ? `- 群：${ctx.helpers.groupLabel(groupId)}`
        : "- 群：私信中触发，未指定群",
    ],
    rows: [[viewButton("back", "返回订阅", "notify", "view")]],
  });
  sent = await ctx.notifications.sendPrivateCard(userId, card);
  const notice = `${ctx.helpers.mention(replyGroupId, userId)}${
    sent.ok ? "已发送测试卡片，请查看私聊。" : `测试推送失败：${sent.detail}`
  }`;
  return { ...notifyCard(ctx, groupId, userId, notice), ok: sent.ok };
}
