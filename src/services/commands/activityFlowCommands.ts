import { getLogger } from "../../core/logger.js";
import {
  ActivityRuleError,
  type Activity,
  type ActivityWaitlistEntry,
} from "../activity.js";
import { code as activityCode } from "../activityCards.js";
import {
  escapeCardText,
  renderCard,
} from "../cardTemplate.js";
import type { RichMessage } from "../richMessages.js";
import {
  UserProfileError,
  type UserProfile,
} from "../userProfiles.js";
import {
  activityNotFoundCard,
  activityDeniedCard,
  activityMemberCard,
  activityNoticeCard,
  requireActivity,
  canManageActivity,
  activityCardInput,
  activityCardService,
  joinReceiptCard,
  deliverSilentReceipt,
  silentReceiptResult,
  silentFallbackCard,
  dmOnlyFailure,
  activityJoinFailure,
  type ActivityDmOptions,
} from "./activityCardCommands.js";
import type { AdminCommandContext } from "./context.js";
import {
  type CardResult,
  mention,
  formatError,
  formatGroupList,
  viewButton,
} from "./support.js";

/**
 * 活动流程层：发布、满员广播、递补、取消通知、报名与取消报名（含静默私信路径）。
 */

const log = getLogger("admin-commands");

export function activityProfiles(
  ctx: AdminCommandContext,
  activityId: string,
): Map<string, UserProfile> | undefined {
  const profiles = ctx.userProfiles;
  if (!profiles) {
    return undefined;
  }
  const map = new Map<string, UserProfile>();
  for (const registration of ctx.activity!.listRegistrations(activityId)) {
    const profile = profiles.get(registration.userId);
    if (profile) {
      map.set(registration.userId, profile);
    }
  }
  return map;
}

/** 统计降级：管理卡同款文字统计。 */

export async function publishActivity(
  ctx: AdminCommandContext,
  userId: string,
  rawCode: string | undefined,
  replyGroupId?: string,
): Promise<CardResult> {
  const found = requireActivity(ctx, rawCode);
  if (!found.ok) {
    return activityNotFoundCard(ctx, rawCode ?? "");
  }
  const { activity } = found;
  if (!canManageActivity(ctx, userId, activity)) {
    return activityDeniedCard(ctx, "发布活动需要群管理员或活动发布者权限。");
  }
  const opened = ctx.activity!.openActivity(activity.activityId);
  // §B4：发布到**所有绑定群**（不是只有归属群），并逐个记录成功 / 失败
  const groups = ctx.activity!.listBoundGroups(opened.activityId);
  const sender = ctx.helpers.cardSender();
  const memberCard = activityMemberCard(ctx, opened, userId);
  const sentGroups: string[] = [];
  const failedGroups: string[] = [];
  if (sender) {
    for (const groupId of groups) {
      const result = await sender.sendToGroup(groupId, memberCard);
      if (result.ok) {
        sentGroups.push(groupId);
      } else {
        failedGroups.push(groupId);
        log.warn("activity publish failed for group", {
          activityId: opened.activityId,
          groupId,
          error: result.detail,
        });
      }
    }
  } else {
    failedGroups.push(...groups);
  }
  const published = groups.length > 0 && failedGroups.length === 0;
  const groupReceipt = activityNoticeCard(ctx,
    replyGroupId,
    userId,
    published
      ? `**结果**：活动已开放报名，活动卡片已发送到 ${sentGroups.length} 个绑定群。`
      : `**结果**：活动已开放报名，卡片发送结果：成功 ${sentGroups.length} 个 / 失败 ${failedGroups.length} 个。`,
  );
  // 操作者私信回执：列出各群发送结果 + 「@全体不可用」提示 + 重发 / 关停入口
  const receiptSender = ctx.helpers.cardSender();
  if (receiptSender) {
    const hint = opened.mentionAll
      ? "你开启了「提醒@全体」：**机器人无法 @全体成员**，如需通知全群请手动 @ 一条。"
      : "机器人无法 @全体成员；如需通知全群请手动 @ 一条。";
    const receipt = renderCard({
      title: `活动已发布 ${activityCode(opened)}`,
      lines: [
        `**活动**：${escapeCardText(opened.title)}`,
        `**绑定群**：${groups.length} 个`,
        `**成功**：${formatGroupList(sentGroups, (id) => ctx.helpers.displayGroup(id)) || "（无）"}`,
        `**失败**：${formatGroupList(failedGroups, (id) => ctx.helpers.displayGroup(id)) || "（无）"}`,
        "",
        hint,
      ],
      rows: [
        [
          viewButton("resend", "重发卡片", "activity", "resend", activityCode(opened)),
          viewButton("close", "关闭报名", "activity", "status", activityCode(opened), "close"),
        ],
        [
          viewButton("info", "查看详情", "activity", "info", activityCode(opened)),
        ],
      ],
    });
    await receiptSender
      .sendToUser(userId, receipt)
      .catch(() => undefined);
  }
  log.info("activity published", {
    activityId: opened.activityId,
    groupId: opened.groupId,
    by: userId,
    published,
  });
  await pushNewActivity(ctx, opened);
  return groupReceipt;
}

/** 给**所有绑定群**的订阅者私信新活动卡片（只发给订阅者，不群发）。 */

export async function pushNewActivity(ctx: AdminCommandContext, activity: Activity): Promise<void> {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const card = activityMemberCard(ctx, activity, activity.createdBy);
  for (const groupId of ctx.activity!.listBoundGroups(activity.activityId)) {
    try {
      await notifications.publishNewActivity({
        activityId: activity.activityId,
        groupId,
        card,
      });
    } catch (error) {
      log.warn("activity publish push failed", {
        activityId: activity.activityId,
        groupId,
        error: formatError(error),
      });
    }
  }
}

/**
 * 满员广播（§B4）：本次报名后**恰好满员**时，往所有绑定群发一次「已满」卡。
 *
 * 每个群只发一次（`activity_notifications` 的 `(活动, "group:<群ID>", "full")` 去重），
 * 未装配群发送通道时静默跳过（不报错）。
 */
export async function announceActivityFull(ctx: AdminCommandContext, activityId: string): Promise<void> {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const activity = ctx.activity!.getActivity(activityId);
  const capacity = activity.capacity;
  if (capacity === undefined) {
    return;
  }
  const registered = ctx.activity!.listRegistrations(activityId).length;
  if (registered + activity.heldSlots < capacity) {
    return;
  }
  const groups = ctx.activity!.listBoundGroups(activityId);
  if (groups.length === 0) {
    return;
  }
  try {
    const result = await notifications.notifyGroupsCard({
      activityId,
      groupIds: groups,
      kind: "full",
      card: activityCardService(ctx).fullCard(
        activityCardInput(ctx, activity, activity.createdBy),
      ),
    });
    log.info("activity full broadcast finished", {
      activityId,
      groups: groups.length,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      available: result.available,
    });
  } catch (error) {
    log.warn("activity full broadcast failed", {
      activityId,
      error: formatError(error),
    });
  }
}

/** 递补成功：私信被递补者「你已递补成功（当前 Y/Z）」，**不往群里发**。 */

export async function notifyPromoted(
  ctx: AdminCommandContext,
  activity: Activity,
  entry: ActivityWaitlistEntry,
  total: number,
): Promise<void> {
  const notifications = ctx.activityNotifications;
  if (!notifications) {
    return;
  }
  const text = [
    `你已递补成功（活动 ${escapeCardText(activity.title)}，当前 ${total}${
      activity.capacity === undefined ? "" : ` / ${activity.capacity}`
    }）。`,
    `活动群：${activity.groupNumber || ctx.helpers.displayGroup(activity.groupId)}`,
    "",
    `取消报名：/activity quit ${activityCode(activity)}`,
  ].join("\n");
  await notifications
    .notifyParticipants({
      activityId: activity.activityId,
      userIds: [entry.userId],
      kind: "promoted",
      text,
      title: "候补递补成功",
    })
    .catch((error: unknown) => {
      log.warn("activity promotion notify failed", {
        activityId: activity.activityId,
        error: formatError(error),
      });
    });
}

/** 取消活动：私信所有已报名 + 候补者。 */

export async function notifyActivityCancelled(ctx: AdminCommandContext, activity: Activity): Promise<void> {
  const notifications = ctx.activityNotifications;
  const userIds = participantIds(ctx, activity);
  if (!notifications || userIds.length === 0) {
    return;
  }
  const text = [
    `活动 **${escapeCardText(activity.title)}**（${activityCode(activity)}）已取消。`,
    `活动群：${activity.groupNumber || ctx.helpers.displayGroup(activity.groupId)}`,
    "",
    "如有疑问请联系活动管理者。",
  ].join("\n");
  await notifications
    .notifyParticipants({
      activityId: activity.activityId,
      userIds,
      kind: "cancelled",
      text,
      title: "活动已取消",
    })
    .catch((error: unknown) => {
      log.warn("activity cancel notify failed", {
        activityId: activity.activityId,
        error: formatError(error),
      });
    });
}

/** 活动的当事人（已报名 + 候补，去重）。 */

export function participantIds(ctx: AdminCommandContext, activity: Activity): string[] {
  const registrations = ctx.activity!.listRegistrations(activity.activityId);
  const waitlist = ctx.activity!.listWaitlist(activity.activityId);
  return [
    ...new Set([
      ...registrations.map((item) => item.userId),
      ...waitlist.map((item) => item.userId),
    ]),
  ];
}

/**
 * 报名（`/activity join` 与 `cb:activity:join` 共用）。
 *
 * 消息落点（§B4 用户确认，**优先于 §B2 的 1.6**）：
 * - **群里操作**（回调或手输）：群内**一律静默**（连「原因已私信」都不发），
 *   成功 / 候补 / 失败原因全部**私信**给本人；
 * - **私聊操作**：原地回复，可含姓名 / 学号 / 班级 / 人数；
 * - **唯一例外**：私信发送失败时，允许群里回一条**不含任何结果**的提示
 *   （`<@!申请人> 私信发送失败，请先私聊机器人再试`），否则用户会以为没反应。
 *
 * `dmOnly` / `dmSilent` 由调用方给出（见 `ActivityDmOptions`）：
 * 群内回调 / 群内手输都是 `dmOnly: true`，前者 `dmSilent: false`（renderer 返回 undefined），
 * 后者 `dmSilent: true`（命令返回 `silent: true` 让 gatewayRunner 跳过群回复）；
 * 私聊（命令或回调）是 `dmOnly: false`，原地回复。
 */
export async function joinActivityCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
  dmOptions: ActivityDmOptions,
): Promise<CardResult | undefined> {
  const dmOnly = dmOptions.dmOnly;
  const silent = dmOptions.dmSilent;
  // 回执可以带完整信息（姓名 / 学号 / 班级）：群内私信回执与私聊原地回复都是本人可见
  const showFullReceipt = true;
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return dmOnly
      ? dmOnlyFailure(ctx, silent, userId, `活动不存在：${parts[2] ?? "（空短码）"}`)
      : activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const { activity } = found;
  const profiles = ctx.userProfiles;
  if (!profiles) {
    const reason = "个人资料服务未启用，无法校验报名资格。";
    if (dmOnly) {
      return dmOnlyFailure(ctx, silent, userId, reason);
    }
    const card = renderCard({ title: "报名未通过", lines: [reason] });
    return { ok: false, text: card.text, rich: card };
  }
  let profile;
  try {
    profile = profiles.requireComplete(userId);
    ctx.activity!.checkEligibility(activity, profile);
  } catch (error) {
    if (error instanceof UserProfileError || error instanceof ActivityRuleError) {
      return activityJoinFailure(ctx, groupId, userId, activity, error.message, dmOptions);
    }
    throw error;
  }
  let outcome;
  try {
    outcome = ctx.activity!.joinActivity({
      activityId: activity.activityId,
      userId,
      displayName: profile.name,
      note: parts.slice(3).join(" ").trim(),
    });
  } catch (error) {
    if (error instanceof ActivityRuleError) {
      return activityJoinFailure(ctx, groupId, userId, activity, error.message, dmOptions);
    }
    return activityJoinFailure(ctx,
      groupId,
      userId,
      activity,
      formatError(error),
      dmOptions,
    );
  }
  const total = ctx.activity!.listRegistrations(activity.activityId).length;
  const capacity = activity.capacity;
  const ticket = capacity === undefined ? `${total}` : `${total} / ${capacity}`;
  if (outcome.status === "waitlisted") {
    const card = joinReceiptCard(ctx, {
      title: "候补登记",
      body: `已进入候补 · 第 ${outcome.position} 位`,
      activity,
      ticket,
      ...(showFullReceipt ? { profile } : {}),
    });
    if (dmOnly) {
      const delivered = await deliverSilentReceipt(ctx, card, userId, groupId);
      return delivered
        ? silentReceiptResult(ctx, card, silent)
        : silentFallbackCard(ctx, groupId ?? "", userId);
    }
    return { ok: true, text: card.text, rich: card };
  }
  // 报名恰好满员 → 在所有绑定群广播一次「已满」卡（每个群只发一次）
  if (outcome.becameFull) {
    await announceActivityFull(ctx, activity.activityId);
  }
  const card = joinReceiptCard(ctx, {
    title: "报名成功",
    body: `报名成功 · 当前 ${ticket}`,
    activity,
    ticket,
    ...(showFullReceipt ? { profile } : {}),
  });
  if (dmOnly) {
    const delivered = await deliverSilentReceipt(ctx, card, userId, groupId);
    return delivered
      ? silentReceiptResult(ctx, card, silent)
      : silentFallbackCard(ctx, groupId ?? "", userId);
  }
  return { ok: true, text: card.text, rich: card };
}

/**
 * 取消报名（`/activity quit` 与 `cb:activity:quit` 共用）。
 *
 * - `auto` 模式：立刻递补候补第一位，并私信被递补者；
 * - `manual` 模式（默认）：名额被冻结（待释放名额 +1）；
 * - §B4：群里操作时**群内静默**，回执只私信本人（连「谁退出了」都不会出现在群里）。
 */
export async function quitActivityCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
  dmOptions?: ActivityDmOptions,
): Promise<CardResult | undefined> {
  const dmOnly = dmOptions?.dmOnly ?? false;
  const silent = dmOptions?.dmSilent ?? false;
  const found = requireActivity(ctx, parts[2]);
  if (!found.ok) {
    return dmOnly
      ? dmOnlyFailure(ctx, silent, userId, `活动不存在：${parts[2] ?? "（空短码）"}`)
      : activityNotFoundCard(ctx, parts[2] ?? "");
  }
  const returnCard = async (card: RichMessage): Promise<CardResult | undefined> => {
    if (dmOnly) {
      const delivered = await deliverSilentReceipt(ctx, card, userId, groupId);
      if (delivered) {
        return silentReceiptResult(ctx, card, silent);
      }
      return silentFallbackCard(ctx, groupId ?? "", userId);
    }
    return { ok: true, text: card.text, rich: card };
  };
  const { activity } = found;
  const registration = ctx.activity!.findRegistration(
    activity.activityId,
    userId,
  );
  if (!registration) {
    const card = renderCard({
      title: "取消报名",
      lines: ["**结果**：你还没有报名这个活动。"],
    });
    return returnCard(card);
  }
  const outcome = ctx.activity!.cancelRegistrationWithPromotion(
    registration.registrationId,
    userId,
  );
  const lines: string[] = ["**结果**：已取消报名。"];
  if (outcome.promoted && outcome.registration) {
    const total = ctx.activity!.listRegistrations(activity.activityId).length;
    await notifyPromoted(ctx,
      ctx.activity!.getActivity(activity.activityId),
      outcome.promoted,
      total,
    );
    lines.push("**结果**：已自动递补候补第一位（已私信通知本人）。");
  } else if (outcome.heldSlots > 0) {
    lines.push(
      `**结果**：名额已冻结，等待管理员释放（待释放名额 ${outcome.heldSlots}）。`,
    );
  }
  const fresh = ctx.activity!.getActivity(activity.activityId);
  lines.push(`**当前报名**：${ctx.activity!.listRegistrations(fresh.activityId).length}${
    fresh.capacity === undefined ? "" : ` / ${fresh.capacity}`
  }`);
  // 只有「私聊原地回复」才需要 mention；静默路径由 deliverSilentReceipt 处理落点
  const mention = dmOnly ? "" : ctx.helpers.mention(groupId, userId).trimEnd();
  const card = renderCard({
    title: "取消报名",
    lines: [...(mention ? [mention] : []), ...lines],
    footer: [
      `重新报名：/activity join ${activityCode(fresh)}`,
      ...(fresh.heldSlots > 0 && canManageActivity(ctx, userId, fresh)
        ? ["释放名额：管理卡上的「释放名额」按钮"]
        : []),
    ],
  });
  return returnCard(card);
}

/** 名单卡：管理者专用（非管理者回调也只得到「权限不足」卡）。 */
