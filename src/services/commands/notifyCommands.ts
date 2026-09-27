import { PLATFORM_LEVEL_MIN, PlatformLevel } from "../../core/enums.js";
import { getLogger } from "../../core/logger.js";
import { renderCard, type CardButton } from "../cardTemplate.js";
import {
  NOTIFY_CHANNELS,
  NOTIFY_SCOPE_ALL,
  NOTIFY_TOPIC_META,
  type NotifyChannel,
} from "../notifyTopics.js";
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
 * 所有话题共用一张 `notification_subscriptions` 表（存储键 `话题:范围`），
 * 订阅只通过**这张卡的按钮**完成：老的 `/notify on|off|all|<群>|punish` 与
 * `/activity subscribe|unsubscribe` 已删除，不做兼容。
 *
 * 话题元数据（标签 / 默认门槛 / 附加要求）统一在 `notifyTopics.ts`，这里只是转出。
 */
export const NOTIFY_CHANNEL_META = NOTIFY_TOPIC_META;

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

/** 通知中心每页话题数：4 行话题 + 1 行导航 = 卡片 5 行上限。 */
export const NOTIFY_PAGE_SIZE = 4;

/**
 * 通知中心（统一订阅入口）。
 *
 * 每个话题一行：「本群 开/关」「全部 开/关」「测试」；私信里没有「本群」范围，
 * 平台类话题（门槛 >= 200，与具体群无关）只给「全部 开/关」「测试」。
 * 超管专属话题只对全局超管显示；每页 4 个话题，底部一行翻页/刷新/帮助。
 */
export function notifyCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  notice?: string,
  page = 1,
): CardResult {
  const notifications = ctx.notifications;
  if (!notifications) {
    const card = renderCard({
      title: "通知订阅",
      lines: ["推送服务未启用。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const isSuperAdmin = ctx.permissions.meetsGlobal(
    userId,
    PlatformLevel.GlobalSuperAdmin,
  );
  const visible = NOTIFY_CHANNELS.filter(
    (topic) =>
      notifications.topicLevel(topic) < PLATFORM_LEVEL_MIN || isSuperAdmin,
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / NOTIFY_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);
  const topics = visible.slice(
    (current - 1) * NOTIFY_PAGE_SIZE,
    current * NOTIFY_PAGE_SIZE,
  );

  const lines = [...ctx.helpers.renderNotice(notice)];
  for (const topic of topics) {
    const scopes = notifications.listScopes(userId, topic);
    const parts: string[] = [];
    if (groupId !== undefined) {
      parts.push(`本群 ${scopes.includes(groupId) ? "开" : "关"}`);
    }
    parts.push(`全部 ${scopes.includes(NOTIFY_SCOPE_ALL) ? "开" : "关"}`);
    lines.push(`**${channelLabel(topic)}**：${parts.join(" · ")}`);
  }
  lines.push(
    "",
    "「全部」= 所有装了机器人的群（绑定是全局的：在一个群绑过 QQ 号即可）。",
    "入群申请需要群管理员及以上、处罚与申诉需要审核员及以上才会推送给你；超管专属话题只有全局超管能看到。",
  );

  const rows: CardButton[][] = topics.map((topic) =>
    topicRow(notifications, groupId, userId, topic),
  );
  rows.push(navigationRow(current, pageCount));

  return cardFromText(`通知中心（${current}/${pageCount}）`, lines.join("\n"), {
    rows,
  });
}

/** 一个话题一行：群内话题「本群 / 全部 / 测试」，平台类话题「全部 / 测试」。 */
function topicRow(
  notifications: NonNullable<AdminCommandContext["notifications"]>,
  groupId: string | undefined,
  userId: string,
  topic: NotifyChannel,
): CardButton[] {
  const meta = NOTIFY_CHANNEL_META[topic];
  const scopes = notifications.listScopes(userId, topic);
  const platformTopic = notifications.topicLevel(topic) >= PLATFORM_LEVEL_MIN;
  const row: CardButton[] = [];
  if (!platformTopic && groupId !== undefined) {
    row.push(
      viewButton(
        `${topic}ThisGroup`,
        `${meta.short}本群`,
        "notify",
        "set",
        topic,
        groupId,
        scopes.includes(groupId) ? "off" : "on",
      ),
    );
  }
  row.push(
    viewButton(
      `${topic}AllGroups`,
      `${meta.short}全部`,
      "notify",
      "set",
      topic,
      NOTIFY_SCOPE_ALL,
      scopes.includes(NOTIFY_SCOPE_ALL) ? "off" : "on",
    ),
  );
  row.push(viewButton(`${topic}Test`, "测试", "notify", "test", topic));
  return row;
}

/** 底部导航行：翻页 + 刷新 + 帮助。 */
function navigationRow(current: number, pageCount: number): CardButton[] {
  const row: CardButton[] = [];
  if (current > 1) {
    row.push(viewButton("prev", "上一页", "notify", "view", current - 1));
  }
  if (current < pageCount) {
    row.push(viewButton("next", "下一页", "notify", "view", current + 1));
  }
  row.push(viewButton("refresh", "刷新", "notify", "view", current));
  row.push(viewButton("help", "指令帮助", "help", "topic", "notify"));
  return row;
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
 * 订阅资格：与推送时的收件人判定（`NotificationService.canReceive`）走**同一份**
 * 话题门槛判据（`NotificationService.checkTopicReach`），免得「订阅成功但永远收不到」。
 */
function canSubscribe(
  ctx: AdminCommandContext,
  userId: string,
  channel: NotifyChannel,
  scope: string,
): { ok: boolean; reason: string } {
  if (!ctx.notifications) {
    return { ok: false, reason: "推送服务未启用。" };
  }
  return ctx.notifications.checkTopicReach(userId, channel, scope);
}

/**
 * 回调：`cb:notify:unsub:<话题>:<范围>` —— 推送卡底部的「取消订阅此通知」。
 *
 * 退订立刻生效（不再弹二次确认），回执卡附「重新订阅」按钮防误点；
 * 默认开的话题同时落一行退订墓碑，重启不会被重新种上。
 */
export function notifyUnsubscribeCard(
  ctx: AdminCommandContext,
  topic: string,
  scope: string,
  userId: string,
  replyGroupId?: string,
): CardResult {
  if (!ctx.notifications || !isNotifyChannel(topic) || scope.length === 0) {
    return notifyCard(ctx, undefined, userId);
  }
  const removed = ctx.notifications.unsubscribe(userId, scope, topic);
  const label = `${channelLabel(topic)} · ${scopeLabel(ctx, scope)}`;
  const notice = ctx.helpers.mention(replyGroupId, userId);
  const card = renderCard({
    title: "取消订阅",
    lines: [
      `${notice}${removed ? `已取消：${label}。` : `${label} 本来就是关闭的。`}`,
      "",
      "误点了可以点「重新订阅」，或随时用 `/notify` 打开通知中心。",
    ],
    rows: [
      [
        viewButton("resub", "重新订阅", "notify", "set", topic, scope, "on"),
        viewButton("back", "通知中心", "notify", "view"),
      ],
    ],
  });
  return { ok: true, text: card.text, rich: card };
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
