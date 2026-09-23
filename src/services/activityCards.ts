import type {
  KeyboardButton,
  KeyboardPayload,
} from "../adapters/qqOfficial.js";
import type { Activity, ActivityRegistration } from "./activity.js";
import type { DisplayNameService } from "./displayNames.js";
import type { RichMessage, RichMessageSender, RichSendResult } from "./richMessages.js";

/**
 * 活动卡片：Markdown 正文 + 指令按钮（报名 / 取消报名 / 详情 / 名单）。
 *
 * 与入群申请卡片共用 `RichMessageSender`，因此同样具备
 * 「Markdown+按钮 → Markdown → 纯文本」三级降级。
 */
export interface ActivityCardInput {
  activity: Activity;
  registrations: readonly ActivityRegistration[];
  /** 展示用：群号（缺省用活动里的 groupNumber）。 */
  groupLabel?: string | undefined;
}

export class ActivityCardService {
  public constructor(
    private readonly sender: RichMessageSender,
    private readonly display?: DisplayNameService,
  ) {}

  public get keyboardAvailable(): boolean {
    return this.sender.keyboardAvailable;
  }

  public render(input: ActivityCardInput): RichMessage {
    const { activity } = input;
    const groupLabel =
      input.groupLabel ??
      (activity.groupNumber ||
        this.display?.group(activity.groupId) ||
        activity.groupId);
    const count = input.registrations.length;
    const capacity = activity.capacity ?? 0;
    const lines = [
      `## ${activity.title}`,
      ...(activity.description ? [activity.description, ""] : []),
      `- 活动群：${groupLabel}`,
      `- 报名人数：${count}${capacity > 0 ? ` / ${capacity}` : ""}`,
      ...formatRules(activity),
      ...formatLinks(activity),
      "",
      `报名 / 取消报名：/activity join ${code(activity)} · /activity quit ${code(activity)}`,
      `活动详情：/activity info ${code(activity)}`,
    ];
    const markdown = lines.join("\n");
    const text = markdown
      .replace(/^## /u, "【活动】")
      .replace(/\*\*/gu, "");
    return {
      markdown,
      text,
      ...(this.sender.keyboardAvailable
        ? { keyboard: buildKeyboard(activity) }
        : {}),
    };
  }

  public async publish(input: ActivityCardInput): Promise<RichSendResult> {
    return this.sender.sendToGroup(input.activity.groupId, this.render(input));
  }
}

export function code(activity: Activity): string {
  return `#${activity.code}`;
}

function formatRules(activity: Activity): string[] {
  const parts: string[] = [];
  if (activity.allowColleges.length > 0) {
    parts.push(`学院 ${activity.allowColleges.join("、")}`);
  }
  if (activity.allowYears.length > 0) {
    parts.push(`年级 ${activity.allowYears.join("、")}`);
  }
  const deny: string[] = [];
  if (activity.denyColleges.length > 0) {
    deny.push(`学院 ${activity.denyColleges.join("、")}`);
  }
  if (activity.denyYears.length > 0) {
    deny.push(`年级 ${activity.denyYears.join("、")}`);
  }
  const lines: string[] = [];
  if (parts.length > 0) {
    lines.push(`- 报名限制：${parts.join(" · ")}`);
  }
  if (deny.length > 0) {
    lines.push(`- 不接受：${deny.join(" · ")}`);
  }
  return lines;
}

function formatLinks(activity: Activity): string[] {
  if (activity.links.length === 0) {
    return [];
  }
  const rendered = activity.links
    .map((link) => `[${link.label}](${link.url})`)
    .join(" · ");
  return [`- 相关链接：${rendered}`];
}

function buildKeyboard(activity: Activity): KeyboardPayload {
  const button = (
    id: string,
    label: string,
    data: string,
    style: 0 | 1 | 3 | 4,
    confirm?: string,
  ): KeyboardButton => ({
    id,
    label,
    visitedLabel: label,
    style,
    action: {
      type: 2,
      data,
      permission: { type: 2 },
      enter: true,
      reply: false,
      unsupportTips: "当前 QQ 版本不支持按钮，请直接发送对应指令",
      ...(confirm
        ? {
            modal: { content: confirm, confirmText: "确认", cancelText: "取消" },
          }
        : {}),
    },
  });
  return {
    content: {
      rows: [
        {
          buttons: [
            button(
              "join",
              "报名",
              `/activity join ${code(activity)}`,
              1,
              "确认报名该活动？",
            ),
            button(
              "quit",
              "取消报名",
              `/activity quit ${code(activity)}`,
              3,
              "确认取消报名？",
            ),
          ],
        },
        {
          buttons: [
            button("info", "活动详情", `/activity info ${code(activity)}`, 0),
            button("signups", "报名名单", `/activity signups ${code(activity)}`, 0),
          ],
        },
      ],
    },
  };
}
