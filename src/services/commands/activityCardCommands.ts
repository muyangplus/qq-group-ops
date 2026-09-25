import { getLogger } from "../../core/logger.js";
import type { Activity } from "../activity.js";
import {
  ActivityCardService,
  type ActivityCardInput,
  code as activityCode,
} from "../activityCards.js";
import {
  escapeCardText,
  renderCard,
  type CardButton,
} from "../cardTemplate.js";
import type { RichMessage } from "../richMessages.js";
import type { UserProfile } from "../userProfiles.js";
import type { AdminCommandContext } from "./context.js";
import {
  type CardResult,
  mention,
  actionButton,
  ACTIVITY_USAGE,
  cardFromText,
  listGroupOf,
  viewButton,
} from "./support.js";
import { resolveTargetGroupId } from "./targetResolvers.js";

/**
 * 活动卡片层：成员卡 / 详情卡 / 管理卡 / 配置卡 / 回执与名单卡，以及共享的卡片输入与权限判定。
 */

/**
 * §B4 落地选项：报名 / 取消报名的结果**只私信**。
 *
 * - `dmOnly: true` 表示「结果私信给本人，群里不发结果」；
 * - `dmSilent: true` 表示命令路径（`silent: true`，跳过群回复）；
 *   回调路径为 `false`（命中静默时渲染器不发言）；
 * - 群内与私聊都走同一套 handler，私聊传 `dmOnly: false` 原地回复。
 */
export interface ActivityDmOptions {
  dmOnly: boolean;
  dmSilent: boolean;
}

const log = getLogger("admin-commands");

/**
 * `/activity [list] [群号] [+页码]`：活动列表卡（按状态分组）。
 *
 * 每页 3 个活动，每个活动一行按钮：`详情` / `报名` / `管理`（仅管理者）/ `订阅`，
 * 全部是**回调**（点击即出卡/生效，不用再发消息）；翻页是回调，
 * 纯文本降级给出 `/activity list +<页码>`（`+` 前缀与群号区分）。
 */
export function activityListCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  page = 1,
  notice?: string,
): CardResult {
  const list = ctx.activity!.listActivities(targetGroupId);
  const groupLabel = ctx.helpers.displayGroup(targetGroupId);
  if (list.length === 0) {
    return cardFromText(
      "活动列表",
      [...ctx.helpers.renderNotice(notice), `群 ${groupLabel} 还没有活动。`].join("\n"),
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
  const subscribed = isSubscribedTo(ctx, targetGroupId, userId);
  const canManageAny = list.some((activity) =>
    canManageActivity(ctx, userId, activity),
  );
  const lines = [
    ...ctx.helpers.renderNotice(notice),
    `**群**：${groupLabel}`,
    `**活动**：${list.length} 个 · 第 ${current} / ${pageCount} 页`,
    "",
  ];
  const rows: CardButton[][] = [];
  for (const groupName of ["报名中", "草稿", "已结束"] as const) {
    const group = slice.filter((activity) => listGroupOf(activity) === groupName);
    if (group.length === 0) {
      continue;
    }
    lines.push(`**${groupName}**`);
    for (const activity of group) {
      const count = ctx.activity!.listRegistrations(activity.activityId).length;
      const code = activityCode(activity);
      lines.push(
        `${escapeCardText(code)} ${escapeCardText(activity.title)} · 报名 ${count}${
          activity.capacity ? `/${activity.capacity}` : ""
        }`,
      );
      const row: CardButton[] = [
        viewButton(`info-${code}`, "详情", "activity", "info", code),
        viewButton(`join-${code}`, "报名", "activity", "join", code),
      ];
      if (canManageActivity(ctx, userId, activity)) {
        row.push(viewButton(`manage-${code}`, "管理", "activity", "manage", code));
      }
      row.push(
        viewButton(
          `subscribe-${code}`,
          subscribed ? "订阅 开" : "订阅 关",
          "activity",
          "subscribe",
          targetGroupId,
          subscribed ? "off" : "on",
        ),
      );
      rows.push(row);
    }
    lines.push("");
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
  if (canManageAny) {
    footer.push("管理入口只在你有权限的活动上显示。");
  }

  return cardFromText("活动列表", lines.join("\n"), {
    rows,
    buttonHint: "点击操作：",
    footer,
  });
}

export function activityCardInput(
  ctx: AdminCommandContext,
  activity: Activity,
  userId: string,
  extra: { full?: boolean; page?: number } = {},
): ActivityCardInput {
  const registrations = ctx.activity!.listRegistrations(activity.activityId);
  return {
    activity,
    registrations,
    waitlist: ctx.activity!.listWaitlist(activity.activityId),
    boundGroups: ctx.activity!.listBoundGroups(activity.activityId),
    groupLabel: activity.groupNumber || ctx.helpers.displayGroup(activity.groupId),
    viewerId: userId,
    canManage: canManageActivity(ctx, userId, activity),
    ...extra,
  };
}

export function activityCardService(ctx: AdminCommandContext): ActivityCardService {
  const cards = ctx.activityCards;
  if (cards) {
    return cards;
  }
  // 未装配卡片服务时（极简单测）用最小依赖现建一个，保证活动指令仍是卡片。
  return new ActivityCardService({
    activity: ctx.activity,
    display: ctx.display,
    // 绑定群子卡：群里显示绑定号 / 短码，不暴露 openid
    groupLabel: (groupId) => ctx.helpers.displayGroup(groupId),
    ...(ctx.userProfiles ? { profiles: ctx.userProfiles } : {}),
    ...(ctx.helpers.roster() ? { roster: ctx.helpers.roster() } : {}),
    // 「统计图片」按钮只在**既能渲染又能发送**时生成，避免出现点了没反应的入口
    ...(ctx.helpers.statsService()?.canSend
      ? { stats: ctx.helpers.statsService() }
      : {}),
    ...(ctx.helpers.exportService()
      ? { exportService: ctx.helpers.exportService() }
      : {}),
    isSubscribed: (groupId, id) => isSubscribedTo(ctx, groupId, id),
  });
}

export function isSubscribedTo(ctx: AdminCommandContext, groupId: string, userId: string): boolean {
  if (ctx.activityNotifications) {
    return ctx.activityNotifications.isSubscribed(groupId, userId);
  }
  return ctx.helpers.fallbackSubscriptions.has(`${groupId}\u0000${userId}`);
}

export function activityManageCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "需要群管理员或活动发布者权限。");
  }
  return {
    ok: true,
    text: activityCardService(ctx)
      .manageCard(activityCardInput(ctx, activity, userId))
      .markdown,
    rich: activityCardService(ctx).manageCard(activityCardInput(ctx, activity, userId)),
  };
}

/** 配置卡入口（管理者专用）。 */

export function activityConfigCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "需要群管理员或活动发布者权限。");
  }
  const rich = activityCardService(ctx).configCard(
    activityCardInput(ctx, activity, userId),
  );
  return { ok: true, text: rich.text, rich };
}

/** 活动不存在的统一卡片（回调里短码解析失败也走这里）。 */

export function activityNotFoundCard(ctx: AdminCommandContext, rawCode: string): CardResult {
  const card = renderCard({
    title: "活动不存在",
    lines: [
      `没有找到活动：${escapeCardText(rawCode) || "（空短码）"}`,
      "短码形如 #A7K2Q9，可从活动列表或活动卡片上复制。",
    ],
    rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
  });
  return { ok: false, text: card.text, rich: card };
}

export function activityDeniedCard(ctx: AdminCommandContext, reason: string): CardResult {
  const card = renderCard({
    title: "权限不足",
    lines: [reason],
    rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
  });
  return { ok: false, text: card.text, rich: card };
}

/** 活动成员卡（群内展示 / 预览 / 重发）。 */

export function activityMemberCard(ctx: AdminCommandContext, activity: Activity, viewerId: string): RichMessage {
  return activityCardService(ctx).memberCard(
    activityCardInput(ctx, activity, viewerId),
  );
}

// ------------------------------------------- 活动：回调 renderer（B2）

export function activityInfoCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const activity = found.activity;
  const registrations = ctx.activity!.listRegistrations(activity.activityId);
  const canManage = canManageActivity(ctx, userId, activity);
  const registration = ctx.activity!.findRegistration(activity.activityId, userId);
  const waitlist = ctx.activity!.findWaitlistEntry(activity.activityId, userId);
  const lines = [
    `**状态**：${activity.status}`,
    `**群**：${activity.groupNumber || ctx.helpers.displayGroup(activity.groupId)}`,
    `**报名**：${registrations.length}${activity.capacity ? ` / ${activity.capacity}` : ""}${
      activity.heldSlots > 0 ? `（待释放 ${activity.heldSlots}）` : ""
    }`,
    `**候补**：${ctx.activity!.listWaitlist(activity.activityId).length}`,
    registration ? "**你的状态**：已报名" : waitlist ? `**你的状态**：候补第 ${ctx.activity!.waitlistPosition(activity.activityId, userId) ?? 0} 位` : "**你的状态**：未报名",
  ];
  if (activity.description) {
    lines.push("", escapeCardText(activity.description));
  }
  const row: CardButton[] = [
    viewButton("join", "我要报名", "activity", "join", activityCode(activity)),
    viewButton("quit", "取消报名", "activity", "quit", activityCode(activity)),
  ];
  const card = renderCard({
    title: `活动详情 ${activityCode(activity)}`,
    lines,
    rows: [
      row,
      canManage
        ? [
            viewButton("manage", "管理", "activity", "manage", activityCode(activity)),
            viewButton("config", "配置", "activity", "config", activityCode(activity)),
          ]
        : [
            viewButton(
              "subscribe",
              isSubscribedTo(ctx, activity.groupId, userId) ? "订阅 开" : "订阅 关",
              "activity",
              "subscribe",
              activity.groupId,
              isSubscribedTo(ctx, activity.groupId, userId) ? "off" : "on",
            ),
          ],
    ],
    buttonHint: "点击操作：",
    footer: [
      `报名：/activity join ${activityCode(activity)}`,
      `报名名单：/activity signups ${activityCode(activity)}（管理者）`,
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/** `cb:activity:bindings:<短码>[:<页码>]`：绑定群子卡（管理者专用）。 */

export function activityBindingsResultCard(
  ctx: AdminCommandContext,
  userId: string,
  activity: Activity,
  notice: string,
): CardResult {
  const fresh = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).bindGroupsCard({
    activity: fresh,
    groups: ctx.activity!.listBoundGroups(fresh.activityId),
  });
  const code = activityCode(fresh);
  const card = renderCard({
    title: `绑定群 ${code}`,
    lines: [notice, "", ...rich.markdown.split("\n")],
    rows: [
      [
        actionButton("bind", "绑定群", `/activity bind ${code} `),
        viewButton("back", "返回配置", "activity", "config", code),
      ],
      [viewButton("manage", "返回管理", "activity", "manage", code)],
    ],
    footer: [
      `绑定：/activity bind ${code} <群号|#群短码>`,
      `解绑：/activity unbind ${code} <群号|#群短码>`,
    ],
  });
  return { ok: true, text: card.text, rich: card };
}

/**
 * 绑定参数解析：群号 / `#群短码` / 内部群 ID 都接受。
 *
 * 解析使用与其它指令相同的 `resolveTargetGroupId`（群号与短码都走身份库），
 * 因此不会把「活动短码」误当成群号（活动短码带 `#` 时先剥离再查群）。
 */
export function resolveActivityGroupArg(ctx: AdminCommandContext, input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  return ctx.helpers.resolveTargetGroupId(undefined, trimmed);
}

/** `cb:activity:preview:<短码>`：把成员卡预览给操作者本人（不发群）。 */

export function activityPreviewCard(ctx: AdminCommandContext, userId: string, rawCode?: string): CardResult {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  if (!canManageActivity(ctx, userId, found.activity)) {
    return activityDeniedCard(ctx, "预览活动卡片需要群管理员或发布者权限。");
  }
  const rich = activityCardService(ctx).memberCard(
    activityCardInput(ctx, found.activity, userId),
  );
  return { ok: true, text: rich.text, rich };
}

export function activityStatsFallback(
  ctx: AdminCommandContext,
  userId: string,
  activity: Activity,
  replyGroupId?: string,
): CardResult {
  const rich = activityCardService(ctx).manageCard(
    activityCardInput(ctx, activity, userId),
  );
  const notice = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const lines = notice ? [notice, ...(rich.markdown.split("\n"))] : rich.markdown.split("\n");
  const card = renderCard({
    title: `活动统计 ${activityCode(activity)}`,
    lines,
    rows: [
      [
        viewButton("manage", "返回管理", "activity", "manage", activityCode(activity)),
      ],
    ],
    footer: ["统计图片不可用（服务未装配或字体缺失），以上为文字统计。"],
  });
  return { ok: true, text: card.text, rich: card };
}

export function activityNoticeCard(
  ctx: AdminCommandContext,
  replyGroupId: string | undefined,
  userId: string,
  body: string,
): CardResult {
  const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const card = renderCard({
    title: "活动操作",
    lines: [...(mention ? [mention] : []), body],
    rows: [[viewButton("help", "活动帮助", "help", "topic", "activity")]],
  });
  return { ok: true, text: card.text, rich: card };
}

export function activityManageNotice(
  ctx: AdminCommandContext,
  userId: string,
  activity: Activity,
  replyGroupId: string | undefined,
  outcome: { ok: boolean; text: string },
): CardResult {
  const fresh = ctx.activity!.getActivity(activity.activityId);
  const rich = activityCardService(ctx).manageCard(
    activityCardInput(ctx, fresh, userId),
  );
  const mention = ctx.helpers.mention(replyGroupId, userId).trimEnd();
  const lines = [
    ...(mention ? [mention] : []),
    outcome.text,
    "",
    ...rich.markdown.split("\n"),
  ];
  const card = renderCard({
    title: `活动管理 ${activityCode(fresh)}`,
    lines,
    rows: [
      [
        viewButton("signups", "报名名单", "activity", "signups", activityCode(fresh), 1),
        viewButton("resend", "重发卡片", "activity", "resend", activityCode(fresh)),
      ],
      [
        viewButton("manage", "刷新管理", "activity", "manage", activityCode(fresh)),
      ],
    ],
    buttonHint: "操作：",
    footer: [`活动配置：/activity info ${activityCode(fresh)}`],
  });
  return { ok: outcome.ok, text: card.text, rich: card };
}

/** `cb:activity:set:<短码>:<字段>:<值>`：配置卡上的快捷设置（管理者专用）。 */

export function requireActivity(
  ctx: AdminCommandContext,
  code: string | undefined,
): { ok: true; activity: Activity } | { ok: false; text: string } {
  if (!code) {
    return { ok: false, text: ACTIVITY_USAGE };
  }
  try {
    return { ok: true, activity: ctx.activity!.requireByCode(code) };
  } catch (error) {
    return { ok: false, text: `活动不存在：${code}` };
  }
}

export function canManageActivity(ctx: AdminCommandContext, userId: string, activity: Activity): boolean {
  return (
    ctx.permissions.isSuperAdmin(userId) ||
    activity.createdBy === userId ||
    ctx.permissions.canApproveJoin(userId, activity.groupId)
  );
}

/**
 * 报名结果卡。
 *
 * - 群内静默路径（`profile` 存在）：私信卡可以含姓名 / 学号 / 班级 / 人数；
 * - 私聊原地回复 / 兜底路径：正文只写结果（不含隐私字段）。
 */
export function joinReceiptCard(
  ctx: AdminCommandContext,
  input: {
    title: string;
  body: string;
  activity: Activity;
  ticket: string;
  profile?: UserProfile | undefined;
}): RichMessage {
  const footer = [`取消报名：/activity quit ${activityCode(input.activity)}`];
  const profile = input.profile;
  if (!profile) {
    return renderCard({
      title: input.title,
      lines: [`**结果**：${escapeCardText(input.body)}`],
      footer,
    });
  }
  return renderCard({
    title: input.title,
    lines: [
      `**结果**：${escapeCardText(input.body)}`,
      `**姓名**：${escapeCardText(profile.name)}`,
      `**学号**：${escapeCardText(profile.studentId)}`,
      `**班级**：${escapeCardText(profile.className)}`,
      `**当前报名**：${input.ticket}`,
      "",
      ...footer,
    ],
  });
}

/**
 * 群内静默路径的私信投递（§B4）：**结果只私信给本人**。
 *
 * 返回 `true` = 私信已送达；`false` = 私信失败或没有私信通道
 * （调用方用 `silentFallbackCard` 给群内**不含结果**的兜底提示）。
 *
 * 私聊点击的回调（`dmGroupId` 为空）本来就不该走静默路径，调用方会原地回复。
 */
export async function deliverSilentReceipt(
  ctx: AdminCommandContext,
  card: RichMessage,
  userId: string,
  dmGroupId: string | undefined,
): Promise<boolean> {
  const sender = ctx.helpers.cardSender();
  if (!sender || !dmGroupId) {
    return false;
  }
  const sent = await sender.sendToUser(userId, card);
  if (sent.ok) {
    log.info("activity receipt DM delivered", { userId });
    return true;
  }
  log.warn("activity group receipt DM failed", { userId, error: sent.detail });
  return false;
}

/**
 * 群内静默路径的返回值：命令路径发 `silent: true`，回调路径发 `undefined`。
 *
 * `ok` 保留业务结果（报名失败仍是 `false`，只是不在群里公开）；命令路径的
 * `text` / `rich` 只是「不落地到群聊」的容器，`silent: true` 会拦下发送。
 */
export function silentReceiptResult(
  ctx: AdminCommandContext,
  card: RichMessage,
  commandPath: boolean,
  ok = true,
): CardResult | undefined {
  if (!commandPath) {
    return undefined;
  }
  return { ok, text: card.text, rich: card, silent: true };
}

/**
 * 群内唯一的静默例外卡片：`<@!申请人>` + 「私信发送失败，请先私聊机器人再试」。
 *
 * 正文**不含任何结果字段**（成功 / 候补 / 失败原因都不出现）。
 */
export function silentFallbackCard(ctx: AdminCommandContext, replyGroupId: string, userId: string): CardResult {
  const card = renderCard({
    title: "活动",
    lines: [`<@!${userId}>`, "私信发送失败，请先私聊机器人再试"],
  });
  return { ok: false, text: card.text, rich: card };
}

/** 静默路径下活动不存在 / 资料服务缺失：只私信，群里不发。 */

export async function dmOnlyFailure(
  ctx: AdminCommandContext,
  silent: boolean,
  userId: string,
  reason: string,
): Promise<CardResult> {
  const card = renderCard({
    title: "活动操作",
    lines: [`**结果**：${escapeCardText(reason)}`],
  });
  const sender = ctx.helpers.cardSender();
  if (sender) {
    await sender.sendToUser(userId, card).catch(() => undefined);
  }
  return {
    ok: false,
    text: card.text,
    rich: card,
    ...(silent ? { silent: true } : {}),
  };
}

/**
 * 报名失败：群里不再回执（§B4 群内静默），原因只私信。
 *
 * 私信失败时群里只提示「请先私聊机器人再试」，**绝不**把原因降级到群里
 * （原因可能包含班级/学院等个人资料）。
 */
export async function activityJoinFailure(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  activity: Activity,
  reason: string,
  dmOptions?: ActivityDmOptions,
): Promise<CardResult | undefined> {
  const privateCard = renderCard({
    title: "报名未通过",
    lines: [
      `**活动**：${escapeCardText(activity.title)}（${activityCode(activity)}）`,
      `**原因**：${escapeCardText(reason)}`,
      "",
      `查看详情：/activity info ${activityCode(activity)}`,
    ],
  });
  // §B4：群内静默 —— 结果（含失败原因）只私信，群里一条都不发
  if (dmOptions?.dmOnly) {
    if (!groupId) {
      return { ok: false, text: privateCard.text, rich: privateCard };
    }
    const delivered = await deliverSilentReceipt(ctx, privateCard, userId, groupId);
    if (!delivered) {
      return silentFallbackCard(ctx, groupId, userId);
    }
    // 命令路径（`dmSilent`）给 `silent: true` 的卡片；回调路径给 undefined（不发言）
    return silentReceiptResult(ctx, privateCard, dmOptions.dmSilent, false);
  }
  const sender = ctx.helpers.cardSender();
  const sent = sender
    ? await sender.sendToUser(userId, privateCard)
    : { ok: false, detail: "私信通道未启用" };
  if (groupId) {
    const card = renderCard({
      title: "报名未通过",
      lines: [
        `<@!${userId}>`,
        sent.ok
          ? escapeCardText("报名未通过，原因已私信。")
          : escapeCardText("报名未通过，请先私聊机器人再试（原因只走私信）。"),
      ],
      footer: [`活动详情：/activity info ${activityCode(activity)}`],
    });
    return { ok: false, text: card.text, rich: card };
  }
  return { ok: false, text: privateCard.text, rich: privateCard };
}

/**
 * 理论上不可达的兜底卡（命令路径必须给出卡片）。
 *
 * 静默路径在命令上下文中总是返回带 `silent: true` 的卡片，因此这里只在
 * 调用方误用（例如把回调路径的结果当成指令结果返回）时出现。
 */
export function activityUnavailableCard(ctx: AdminCommandContext): CardResult {
  const card = renderCard({
    title: "活动",
    lines: ["操作已完成，但结果无法投递，请私聊机器人后重试。"],
  });
  return { ok: false, text: card.text, rich: card, silent: true };
}

/** `/activity info <#短码>`：详情卡（回调 `cb:activity:info` 复用）。 */

export function formatActivityList(ctx: AdminCommandContext, groupId: string): string {
  const activities = ctx.activity!.listActivities(groupId);
  if (activities.length === 0) {
    return `群 ${ctx.helpers.displayGroup(groupId)} 还没有活动。\n\n${ACTIVITY_USAGE}`;
  }
  const lines = [`群 ${ctx.helpers.displayGroup(groupId)} 的活动：`];
  for (const activity of activities) {
    const count = ctx.activity!.listRegistrations(activity.activityId).length;
    lines.push(
      `- ${activityCode(activity)} ${activity.title} [${activity.status}] 报名 ${count}${
        activity.capacity ? `/${activity.capacity}` : ""
      }`,
    );
  }
  lines.push("", `查看详情：/activity info <活动短码>`);
  return lines.join("\n");
}

export function formatActivityInfo(ctx: AdminCommandContext, activity: Activity): string
{
  const rich = activityCardService(ctx).configCard(
    activityCardInput(ctx, activity, activity.createdBy),
  );
  return rich.text;
}
