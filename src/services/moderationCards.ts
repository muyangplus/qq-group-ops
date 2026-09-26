import type { KeyboardModal } from "../adapters/qqOfficial.js";
import { formatDisplayTime } from "../core/timeFormat.js";
import { encodeCallback } from "./callbackData.js";
import {
  escapeCardText,
  renderCard,
  type CardButton,
  type CardButtonStyle,
} from "./cardTemplate.js";
import type { PunishmentActions } from "../db/punishmentRepository.js";

import type { RichMessage } from "./richMessages.js";

/**
 * 处罚 / 申诉卡片（§B7 / §B8）。
 *
 * 全部是**私信**卡片：正文是 Markdown，按钮是回调（固定动作）或指令按钮。
 * 每个按钮都带 `permission.specifyUserIds = [接收者]`，所以同一张卡推给多个审核员时，
 * 只有各自能点自己那份（也用于「拉黑全局」只出现在全局超管的卡上）。
 *
 * §卡片规范 v2：正文只写业务信息（谁 / 什么规则 / 什么动作 / 记录号）；
 * 回调按钮覆盖不了的动作（如「自定义禁言时长」）才在 footer 保留一行等价指令。
 */

/** 常用禁言时长预设（按钮点击即生效，自定义走 `/punish mute`）。 */
export const MUTE_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: "10分钟", seconds: 10 * 60 },
  { label: "1小时", seconds: 60 * 60 },
  { label: "1天", seconds: 24 * 60 * 60 },
  { label: "7天", seconds: 7 * 24 * 60 * 60 },
];

const STYLE_PRIMARY = 1 as const;
const STYLE_DANGER = 3 as const;

export interface PunishmentCardInput {
  /** 群展示名（群号 / #群短码）。 */
  groupLabel: string;
  /** 当事人展示名（QQ号 / #用户短码）。 */
  userLabel: string;
  /** 处罚记录短码（不含 `#`）。 */
  recordId: string;
  /** 命中的规则说明。 */
  ruleReason: string;
  /**
   * 触发处罚的消息原文（§B7，单行截断）。
   *
   * 只有本群 `rawMessageRetentionDays > 0` 时才有值；`''` 表示未保留
   * （卡片显示「（未保留原文）」）。**只在私信卡片里展示**——群内那张不带原文。
   */
  messageExcerpt: string;
  actions: PunishmentActions;
  /** 执行结果（`recall+mute_failed` …）。 */
  detail: string;
  createdAt: Date;
  /** 接收者：用于按钮可见性与回调鉴权。 */
  recipientId: string;
  /** 平台不支持按钮时只渲染 Markdown。 */
  withButtons: boolean;
  /** 该接收者是否有全局黑名单权限（全局超管）。 */
  canBlacklistGlobal: boolean;
}

/** 处罚通知卡（推送给订阅了「处罚通知」的审核员及以上成员）。 */
export function buildPunishmentNoticeCard(
  input: PunishmentCardInput,
): RichMessage {
  const record = `#${input.recordId}`;
  const lines = [
    // §B7：原文固定放在标题下第一段（引用段落）
    ...excerptLines(input.messageExcerpt),
    `**群**：${escapeCardText(input.groupLabel)}`,
    `**当事人**：${escapeCardText(input.userLabel)}`,
    `**处罚记录**：${record}`,
    `**命中规则**：${escapeCardText(input.ruleReason) || "（关键词）"}`,
    `**执行动作**：${describePunishmentActions(input.actions)}`,
    ...(input.detail ? [`**执行结果**：${escapeCardText(input.detail)}`] : []),
    "",
    `**时间**：${formatTimestamp(input.createdAt)}`,
  ];
  lines.push(
    "",
    "**说明**：解除会按记录逐项撤销（撤回与踢出无法撤销）。",
  );
  return renderCard({
    title: "处罚通知",
    lines,
    ...(input.withButtons
      ? {
          rows: punishmentRows(input),
        }
      : {}),
    footer: punishmentFooter(record),
  });
}

/** 预设时长子卡：点一下就改禁言时长。 */
export function buildMuteOptionsCard(input: {
  recordId: string;
  userLabel: string;
  groupLabel: string;
  currentSeconds: number;
  recipientId: string;
  withButtons: boolean;
}): RichMessage {
  const record = `#${input.recordId}`;
  const rows: CardButton[][] = [];
  if (input.withButtons) {
    const presets = MUTE_PRESETS.map((preset, index) =>
      callbackButton(
        `preset-${index}`,
        preset.label,
        encodeCallback("punish", "setmute", input.recordId, preset.seconds),
        input.recipientId,
        { style: STYLE_PRIMARY },
      ),
    );
    for (let index = 0; index < presets.length; index += 2) {
      rows.push(presets.slice(index, index + 2));
    }
    rows.push([
      callbackButton(
        "unmute",
        "解除禁言",
        encodeCallback("punish", "setmute", input.recordId, 0),
        input.recipientId,
      ),
      callbackButton(
        "back",
        "返回处罚",
        encodeCallback("punish", "view", input.recordId),
        input.recipientId,
      ),
    ]);
  }
  return renderCard({
    title: "修改禁言时长",
    lines: [
      `**处罚记录**：${record}`,
      `**当事人**：${escapeCardText(input.userLabel)}`,
      `**群**：${escapeCardText(input.groupLabel)}`,
      `**当前**：${input.currentSeconds > 0 ? `禁言 ${formatDuration(input.currentSeconds)}` : "未禁言"}`,
    ],
    ...(input.withButtons ? { rows } : {}),
    footer: [
      // 自定义时长按钮做不到 → 保留等价指令；「解除禁言」有按钮时不重复写
      `自定义时长：/punish mute ${record} <秒>`,
      ...(input.withButtons ? [] : [`解除禁言：/punish mute ${record} 0`]),
    ],
  });
}

/** 申诉通知卡（推送给处罚通知的订阅者；卡片上可直接调整处罚）。 */
export function buildAppealNoticeCard(input: {
  groupLabel: string;
  userLabel: string;
  recordId: string;
  appealId: string;
  reason: string;
  messageExcerpt: string;
  actions: PunishmentActions;
  createdAt: Date;
  recipientId: string;
  withButtons: boolean;
  canBlacklistGlobal: boolean;
}): RichMessage {
  const record = `#${input.recordId}`;
  const appeal = `#${input.appealId}`;
  return renderCard({
    title: "申诉通知",
    lines: [
      ...excerptLines(input.messageExcerpt),
      `**群**：${escapeCardText(input.groupLabel)}`,
      `**申诉人**：${escapeCardText(input.userLabel)}`,
      `**处罚记录**：${record}（申诉 ${appeal}）`,
      `**原处罚**：${describePunishmentActions(input.actions)}`,
      `**申诉理由**：${escapeCardText(input.reason) || "（未填写）"}`,
      "",
      `**时间**：${formatTimestamp(input.createdAt)}`,
    ],
    ...(input.withButtons
      ? {
          rows: [
            [
              callbackButton(
                "accept",
                "通过申诉",
                encodeCallback("appeal", "accept", input.appealId),
                input.recipientId,
                { style: STYLE_PRIMARY },
              ),
              callbackButton(
                "reject",
                "驳回申诉",
                encodeCallback("appeal", "reject", input.appealId),
                input.recipientId,
                { style: STYLE_DANGER },
              ),
            ],
            ...punishmentRows(input),
          ],
        }
      : {}),
    footer: punishmentFooter(record),
  });
}

/**
 * 申诉回执卡（发给申诉人本人）。
 *
 * §卡片规范 v2：正文只放业务信息；动作全部给按钮 ——
 * 「补充理由」是指令按钮（预填 `/appeal #码 `），「查看处罚」是回调。
 */
export function buildAppealReceiptCard(input: {
  recordId: string;
  reason: string;
  groupLabel: string;
  messageExcerpt: string;
  updated: boolean;
  recipientId: string;
  withButtons: boolean;
}): RichMessage {
  const record = `#${input.recordId}`;
  return renderCard({
    title: input.updated ? "申诉已更新" : "申诉已提交",
    lines: [
      ...excerptLines(input.messageExcerpt),
      `**处罚记录**：${record}`,
      `**群**：${escapeCardText(input.groupLabel)}`,
      `**申诉理由**：${escapeCardText(input.reason) || "（未填写）"}`,
      "",
      "已私信给该群的审核员及以上成员，处理结果会再私信通知你。",
    ],
    ...(input.withButtons
      ? {
          rows: [
            [
              // 同上：1:1 私信不需要 specifyUserIds（鉴权在服务端）
              {
                id: "appeal-again",
                label: "补充理由",
                command: `/appeal ${record} `,
                fillOnly: true,
                unsupportTips: `请直接发送 /appeal ${record} <理由>`,
              },
            ],
          ],
        }
      : {}),
  });
}

/**
 * 申诉引导卡（点群内「我要申诉」按钮后私信给当事人）。
 *
 * §B8（用户真机反馈后调整）：当事人**正在禁言**时，QQ 客户端会拦住指令按钮的发送
 * （PC 端弹「禁言中，请解禁后再试」），所以主按钮必须是**回调**：
 * 「直接提交」= 一键建**无理由**单（回调，不经过客户端发送）；
 * 「写理由提交」= 指令按钮（预填 `/appeal #码 `），能发出去时就带着理由提交。
 */
export function buildAppealGuideCard(input: {
  recordId: string;
  groupLabel: string;
  messageExcerpt: string;
  recipientId: string;
  withButtons: boolean;
}): RichMessage {
  const record = `#${input.recordId}`;
  const lines = [
    ...excerptLines(input.messageExcerpt),
    `**处罚记录**：${record}`,
    `**群**：${escapeCardText(input.groupLabel)}`,
  ];
  if (!input.withButtons) {
    // 没有按钮时（老客户端 / 键盘被平台拒绝）必须给出可复制的等价指令
    lines.push(
      "",
      "私聊机器人发送下面这条即可提交（可以补一句理由）：",
      `/appeal ${record} <理由>`,
    );
  }
  return renderCard({
    title: "我要申诉",
    lines,
    ...(input.withButtons
      ? {
          rows: [
            [
              // §B8：当事人卡片是 1:1 私信，**不带 permission.specifyUserIds**
              // （真机出现「无权限操作」）；鉴权全部在服务端做
              // （appealCallbackCard 会校验 record.userId === userId）。
              {
                id: "appeal-submit",
                label: "直接提交",
                style: STYLE_PRIMARY,
                callbackData: encodeCallback("appeal", "submit", input.recordId),
              },
              {
                id: "appeal",
                label: "写理由提交",
                command: `/appeal ${record} `,
                // 只填入输入框，用户补完理由再自己发送（否则客户端直接发出去、理由没地方写）
                fillOnly: true,
                unsupportTips: `请直接发送 /appeal ${record} <理由>`,
              },
            ],
          ],
        }
      : {}),
  });
}

/**
 * 原文行（§B7）：**只在私信卡片上调用**，群里那张（处罚通知）不带原文与规则名。
 *
 * 渲染格式（用户确认）：标签 + **Markdown 引用段落**，并且要放在**标题下第一段**：
 * ```
 * ## 标题
 * 原文：
 * > 违规内容全文
 * ```
 * 未保留原文时给一行提示：说明是「没开启保留」而不是「丢了」，并配一个「开启保留」按钮
 * （按钮由 `ModerationNotifier` 在只有群管理员及以上可见时追加，见 §B7）。
 */
export function excerptLines(excerpt: string): string[] {
  const text = excerpt.trim();
  if (text.length === 0) {
    return ["**原文**：（未保留 · 本群未开启消息保留）", ""];
  }
  return ["**原文**：", `> ${escapeCardText(text)}`, ""];
}

/**
 * 申诉处理结果卡（私信给**申诉人本人**）。
 *
 * §B8 真机反馈：此前只有审核员看到处理结果，申诉人永远收不到通知 —— 现在通过 / 驳回都发这张。
 */
export function buildAppealDecisionCard(input: {
  appealId: string;
  recordId: string;
  groupLabel: string;
  approved: boolean;
  reviewerLabel: string;
  note: string;
  createdAt: Date;
}): RichMessage {
  const lines = [
    `**申诉**：#${input.appealId}`,
    `**处罚记录**：#${input.recordId}`,
    `**群**：${escapeCardText(input.groupLabel)}`,
    `**结果**：${input.approved ? "已通过（处罚已解除）" : "已驳回（处罚保持不变）"}`,
    `**处理人**：${escapeCardText(input.reviewerLabel)}`,
    ...(input.note.trim().length > 0
      ? [`**处理备注**：${escapeCardText(input.note)}`]
      : []),
    "",
    `**时间**：${formatTimestamp(input.createdAt)}`,
  ];
  return renderCard({
    title: input.approved ? "申诉已通过" : "申诉已驳回",
    lines,
  });
}

/**
 * 申诉处理结果同步卡（私信给**其他订阅了处罚通知的审核员**）。
 *
 * 目的：一个人处理完之后，其余人不该再重复处理，也不该完全不知情。
 * 因此不写按钮 —— 只做「状态同步」。
 */
export function buildAppealHandledNoticeCard(input: {
  appealId: string;
  recordId: string;
  groupLabel: string;
  appellantLabel: string;
  approved: boolean;
  reviewerLabel: string;
}): RichMessage {
  return renderCard({
    title: "申诉已处理",
    lines: [
      `**申诉**：#${input.appealId}（处罚 #${input.recordId}）`,
      `**群**：${escapeCardText(input.groupLabel)}`,
      `**申诉人**：${escapeCardText(input.appellantLabel)}`,
      `**结果**：${input.approved ? "已通过（处罚已解除）" : "已驳回（处罚保持不变）"} · 由 ${escapeCardText(input.reviewerLabel)} 处理`,
    ],
  });
}

/** 通用处理回执卡（动作结果 + 返回入口）。 */
export function buildModerationReceipt(input: {
  title: string;
  lines: readonly string[];
  recordId: string;
  recipientId: string;
  withButtons: boolean;
}): RichMessage {
  const record = `#${input.recordId}`;
  return renderCard({
    title: input.title,
    lines: input.lines,
    ...(input.withButtons
      ? {
          rows: [
            [
              callbackButton(
                "view",
                "查看处罚",
                encodeCallback("punish", "view", input.recordId),
                input.recipientId,
              ),
            ],
          ],
        }
      : {}),
    footer: punishmentFooter(record),
  });
}

/** 处罚动作的中文描述（卡片正文用）。 */
export function describePunishmentActions(actions: PunishmentActions): string {
  const parts: string[] = [];
  if (actions.recalled) {
    parts.push("撤回消息");
  }
  if (actions.muted) {
    parts.push(
      actions.muteDurationSeconds > 0
        ? `禁言 ${formatDuration(actions.muteDurationSeconds)}`
        : "禁言",
    );
  }
  if (actions.kicked) {
    parts.push("移出群");
  }
  if (actions.blacklist === "group") {
    parts.push("拉黑（本群）");
  } else if (actions.blacklist === "global") {
    parts.push("拉黑（全局）");
  }
  return parts.length > 0 ? parts.join(" + ") : "仅警告";
}

/** 秒 → 中文时长（仅用于展示）。 */
export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value % (24 * 60 * 60) === 0 && value >= 24 * 60 * 60) {
    return `${value / (24 * 60 * 60)} 天`;
  }
  if (value % (60 * 60) === 0 && value >= 60 * 60) {
    return `${value / (60 * 60)} 小时`;
  }
  if (value % 60 === 0 && value >= 60) {
    return `${value / 60} 分钟`;
  }
  return `${value} 秒`;
}

function formatTimestamp(date: Date): string {
  // 展示时区默认 UTC+8（env 可配），库里仍存 UTC
  return formatDisplayTime(date);
}

/** 处罚动作按钮行（处罚通知卡与申诉卡共用）。 */
function punishmentRows(input: {
  recordId: string;
  recipientId: string;
  canBlacklistGlobal: boolean;
}): CardButton[][] {
  const rows: CardButton[][] = [
    [
      callbackButton(
        "release",
        "解除处罚",
        encodeCallback("punish", "release", input.recordId),
        input.recipientId,
        { style: STYLE_PRIMARY },
      ),
      callbackButton(
        "mute",
        "禁言时长",
        encodeCallback("punish", "mute", input.recordId),
        input.recipientId,
      ),
      callbackButton(
        "view",
        "详情",
        encodeCallback("punish", "view", input.recordId),
        input.recipientId,
      ),
    ],
    [
      callbackButton(
        "kick",
        "踢出",
        encodeCallback("punish", "kick", input.recordId),
        input.recipientId,
        { modal: confirmModal("确认把该成员移出群？") },
      ),
      callbackButton(
        "blacklist-group",
        "拉黑本群",
        encodeCallback("punish", "blacklist", input.recordId, "group"),
        input.recipientId,
        {
          style: STYLE_DANGER,
          modal: confirmModal("确认拉黑本群？会先移出群，并加入本群黑名单。"),
        },
      ),
      ...(input.canBlacklistGlobal
        ? [
            callbackButton(
              "blacklist-global",
              "拉黑全局",
              encodeCallback("punish", "blacklist", input.recordId, "global"),
              input.recipientId,
              {
                style: STYLE_DANGER,
                modal: confirmModal(
                  "确认拉黑全局？会在所有绑定群移出该成员，并拒绝其入群申请。",
                ),
              },
            ),
          ]
        : []),
    ],
  ];
  return rows;
}

/**
 * 卡片底部提示（§卡片规范 v2）：**按钮已经覆盖的动作不再写指令**
 * （解除 / 预设时长 / 踢出 / 拉黑都有回调按钮），只保留按钮做不到的「自定义禁言时长」。
 *
 * 回调按钮在纯文本降级里没有可复制指令，属于已知的降级损失；指令按钮的等价指令
 * 由 `cardTemplate` 自动列进 `text`。
 */
function punishmentFooter(record: string): string[] {
  return [`自定义禁言时长：/punish mute ${record} <秒>`];
}

function callbackButton(
  id: string,
  label: string,
  callbackData: string,
  recipientId: string,
  options: { style?: CardButtonStyle; modal?: KeyboardModal } = {},
): CardButton {
  return {
    id,
    label,
    callbackData,
    permission: { type: 0, specifyUserIds: [recipientId] },
    ...(options.style !== undefined ? { style: options.style } : {}),
    ...(options.modal !== undefined ? { modal: options.modal } : {}),
  };
}

function confirmModal(content: string): KeyboardModal {
  return { content, confirmText: "确认", cancelText: "取消" };
}
