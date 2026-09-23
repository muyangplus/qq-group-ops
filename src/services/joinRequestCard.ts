import type {
  KeyboardButton,
  KeyboardPayload,
} from "../adapters/qqOfficial.js";

/**
 * 入群申请推送卡片。
 *
 * 官方「结构化卡片（Ark）」只支持接收、不支持机器人发送；能发送的富消息是
 * **Markdown + 内嵌按钮**（`msg_type=2` + `keyboard`），所以这里的「卡片」
 * 就是 Markdown 正文 + 底部指令按钮：
 * - 「同意」→ 发送 `/approve <group_openid> <申请ID>`
 * - 「拒绝」→ 发送 `/reject <group_openid> <申请ID> <原因>`
 * - 第二行是预设拒绝原因，一键把常用回复作为拒绝理由提交
 *
 * 自定义按钮属于官方内邀能力（需要白名单）；未开通时推送服务会自动降级为
 * 纯 Markdown / 纯文本，不影响审核通知本身。
 */
export interface JoinRequestCardInput {
  groupId: string;
  /** 已绑定群号（旧字段，等价于 groupLabel）。 */
  groupNumber?: string | undefined;
  /** 群展示名：群号或短码 `#XXXXXX`；由 DisplayNameService 生成。 */
  groupLabel?: string | undefined;
  /** 申请单号：短码 `#XXXXXX`（生产环境）或完整 join_request_id（兼容）。 */
  requestId: string;
  /** 申请人 openid（仅在没有任何展示名时兜底，生产环境不会用到）。 */
  userId: string;
  /** 申请人已绑定的 QQ 号（旧字段，等价于 applicantLabel）。 */
  applicantQq?: string | undefined;
  /** 申请人展示名：QQ号或短码 `#XXXXXX`。 */
  applicantLabel?: string | undefined;
  /** 申请人昵称（官方 `username`），可选。 */
  applicantName?: string | undefined;
  /** 入群问题/理由原文。 */
  reason: string;
  /** 管理员问答的题目（`admin_review_qa`），仅用于展示。 */
  questions?: readonly string[] | undefined;
  /** 规则引擎给出的审核意见（可选）。 */
  opinion?: string | undefined;
  /**
   * 处理结果：`manual` = 待人工审核（默认，带审批按钮）；
   * `auto_approved` / `auto_rejected` = 机器人已自动处理，只通知结果、不给按钮。
   */
  decision?: JoinRequestDecision | undefined;
  /** 接收者 userId：按钮只允许该用户点击。 */
  recipientId: string;
  /** 关闭按钮（例如已知按钮未开通）时只生成 Markdown。 */
  withButtons?: boolean | undefined;
}

export type JoinRequestDecision = "manual" | "auto_approved" | "auto_rejected";

const AUTO_DECISION_LABELS: Record<"auto_approved" | "auto_rejected", string> = {
  auto_approved: "已自动通过（按入群规则）",
  auto_rejected: "已自动拒绝（按入群规则）",
};

export interface JoinRequestCard {
  markdown: string;
  keyboard?: KeyboardPayload | undefined;
}

/** 预设拒绝理由：一键拒绝并把原因作为官方 `reject_reason` 回给申请人。 */
export const JOIN_REJECT_PRESETS = [
  {
    id: "reject-answer",
    label: "拒绝：回答错误",
    reason: "请正确回答问题。",
  },
  {
    id: "reject-class",
    label: "拒绝：班级姓名",
    reason: "请回答正确的班级姓名（如：环工2214小明）。",
  },
] as const;

/** 官方按钮样式：0 灰色线框 / 1 蓝色线框 / 3 白底红字 / 4 蓝底白字。 */
const STYLE_PRIMARY = 1 as const;
const STYLE_DANGER = 3 as const;
const DEFAULT_REJECT_REASON = "审核未通过";

export function buildJoinRequestCard(
  input: JoinRequestCardInput,
): JoinRequestCard {
  // 展示用：优先用 DisplayNameService 给的展示名（群号/QQ号/短码）
  const groupLabel = input.groupLabel ?? input.groupNumber ?? input.groupId;
  const applicantId = input.applicantLabel ?? input.applicantQq ?? input.userId;
  // 指令只用申请短码：短码唯一，处理时会自动定位所属群（群号/短码也可作为可选参数）
  const approveCommand = `/approve ${input.requestId}`;
  const rejectCommandFor = (reason: string): string =>
    `/reject ${input.requestId} ${reason}`;
  const autoDecision =
    input.decision === "auto_approved" || input.decision === "auto_rejected"
      ? AUTO_DECISION_LABELS[input.decision]
      : undefined;

  const applicantLabel = `${escapeText(applicantId)}${
    input.applicantName ? `（${escapeText(input.applicantName)}）` : ""
  }`;
  const questions = (input.questions ?? []).filter(
    (question) => question.trim().length > 0,
  );
  const lines = [
    "## 新的入群申请",
    `**群**：${escapeText(groupLabel)}`,
    `**申请人**：${applicantLabel}`,
    ...(questions.length > 0
      ? [`**入群问题**：${escapeText(questions.join(" / "))}`]
      : []),
    `**回答**：${escapeText(input.reason) || "（未填写）"}`,
    `**申请ID**：${escapeText(input.requestId)}`,
    ...(autoDecision ? [`**处理结果**：${autoDecision}`] : []),
  ];
  if (input.opinion) {
    lines.push("", ...toQuote(input.opinion));
  }

  if (autoDecision) {
    // 机器人已经处理完了：只通知结果，不给按钮
    lines.push("", "该申请已由机器人自动处理，无需操作。");
    return { markdown: lines.join("\n") };
  }

  if (input.withButtons === false) {
    // 没有按钮时把指令（含预设拒因）写进正文，否则这条消息无法直接审批
    lines.push(
      "",
      "请审核（按钮不可用，可直接发送指令）：",
      `同意：${approveCommand}`,
      `拒绝：${rejectCommandFor("[原因]")}`,
      ...JOIN_REJECT_PRESETS.map(
        (preset) => `${preset.label}：${rejectCommandFor(preset.reason)}`,
      ),
    );
    return { markdown: lines.join("\n") };
  }

  lines.push("", "请审核：点击下方按钮。");
  const markdown = lines.join("\n");

  const rejectButton = (
    id: string,
    label: string,
    reason: string,
  ): KeyboardButton => ({
    id,
    label,
    visitedLabel: "已拒绝",
    style: STYLE_DANGER,
    action: {
      type: 2,
      data: rejectCommandFor(reason),
      permission: { type: 0, specifyUserIds: [input.recipientId] },
      enter: true,
      reply: false,
      unsupportTips: "当前 QQ 版本不支持按钮，请直接发送 /reject 指令",
      modal: {
        content: "确认拒绝该入群申请？",
        confirmText: "拒绝",
        cancelText: "取消",
      },
    },
  });

  return {
    markdown,
    keyboard: {
      content: {
        rows: [
          {
            buttons: [
              {
                id: "approve",
                label: "同意",
                visitedLabel: "已同意",
                style: STYLE_PRIMARY,
                action: {
                  type: 2,
                  data: approveCommand,
                  permission: { type: 0, specifyUserIds: [input.recipientId] },
                  enter: true,
                  reply: false,
                  unsupportTips: "当前 QQ 版本不支持按钮，请直接发送 /approve 指令",
                  modal: {
                    content: "确认通过该入群申请？",
                    confirmText: "通过",
                    cancelText: "取消",
                  },
                },
              },
              rejectButton("reject", "拒绝", DEFAULT_REJECT_REASON),
            ],
          },
          {
            buttons: JOIN_REJECT_PRESETS.map((preset) =>
              rejectButton(`reject-${preset.id}`, preset.label, preset.reason),
            ),
          },
        ],
      },
    },
  };
}

/** 按钮不可用时的纯文本降级内容（包含同样的指令与预设拒因）。 */
export function renderJoinRequestCardText(input: JoinRequestCardInput): string {
  const groupLabel = input.groupLabel ?? input.groupNumber ?? input.groupId;
  const applicantId = input.applicantLabel ?? input.applicantQq ?? input.userId;
  const approveCommand = `/approve ${input.requestId}`;
  const rejectTextFor = (reason: string): string =>
    `/reject ${input.requestId} ${reason}`;
  const autoDecision =
    input.decision === "auto_approved" || input.decision === "auto_rejected"
      ? AUTO_DECISION_LABELS[input.decision]
      : undefined;
  const lines = [
    "【新的入群申请】",
    `群：${groupLabel}`,
    `申请人：${applicantId}${
      input.applicantName ? `（${singleLine(input.applicantName)}）` : ""
    }`,
    `申请ID：${input.requestId}`,
    ...(input.questions && input.questions.length > 0
      ? [`入群问题：${input.questions.map(singleLine).join(" / ")}`]
      : []),
    `回答：${singleLine(input.reason) || "（未填写）"}`,
    ...(autoDecision ? [`处理结果：${autoDecision}`] : []),
  ];
  if (input.opinion) {
    lines.push("", ...input.opinion.split("\n"));
  }
  if (autoDecision) {
    lines.push("", "该申请已由机器人自动处理，无需操作。");
    return lines.join("\n");
  }
  lines.push(
    "",
    `同意：${approveCommand}`,
    `拒绝：${rejectTextFor("[原因]")}`,
    ...JOIN_REJECT_PRESETS.map(
      (preset) => `${preset.label}：${rejectTextFor(preset.reason)}`,
    ),
  );
  return lines.join("\n");
}

/** Markdown 转义：去掉会破坏排版的字符，并压成单行。 */
function escapeText(text: string): string {
  return singleLine(text)
    .replace(/[\\`*_~#>]/gu, (char) => `\\${char}`)
    .slice(0, 200);
}

function singleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function toQuote(text: string): string[] {
  return text
    .split("\n")
    .map((line) => `> ${line.trim()}`.trimEnd());
}
