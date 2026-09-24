import { renderCard, type CardButton } from "./cardTemplate.js";
import type { Activity, ActivityRegistration } from "./activity.js";
import type { DisplayNameService } from "./displayNames.js";
import type { RichMessage, RichMessageSender, RichSendResult } from "./richMessages.js";

/**
 * 活动卡片：Markdown 正文 + 指令按钮（报名 / 取消报名 / 详情 / 名单）。
 *
 * 布局交给统一的 `cardTemplate` 渲染，因此与系统菜单、入群申请卡片保持同一套
 * 「标题 + 正文 + 按钮 + 底部提示」结构；发送仍走 `RichMessageSender`，具备
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
    return renderCard({
      title: activity.title,
      lines: [
        ...(activity.description ? [activity.description, ""] : []),
        `- 活动群：${groupLabel}`,
        `- 报名人数：${count}${capacity > 0 ? ` / ${capacity}` : ""}`,
        ...formatRules(activity),
        ...formatLinks(activity),
      ],
      ...(this.sender.keyboardAvailable
        ? { rows: buildRows(activity), buttonHint: "点击下方按钮立即操作：" }
        : {}),
      footer: [
        `报名 / 取消报名：/activity join ${code(activity)} · /activity quit ${code(activity)}`,
        `活动详情：/activity info ${code(activity)}`,
      ],
    });
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

function buildRows(activity: Activity): readonly (readonly CardButton[])[] {
  const button = (
    id: string,
    label: string,
    command: string,
    style: 0 | 1 | 3 | 4,
    confirm?: string,
  ): CardButton => ({
    id,
    label,
    visitedLabel: label,
    style,
    command,
    permission: { type: 2 },
    unsupportTips: "当前 QQ 版本不支持按钮，请直接发送对应指令",
    ...(confirm
      ? {
          modal: { content: confirm, confirmText: "确认", cancelText: "取消" },
        }
      : {}),
  });
  return [
    [
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
    [
      button("info", "活动详情", `/activity info ${code(activity)}`, 0),
      button("signups", "报名名单", `/activity signups ${code(activity)}`, 0),
    ],
  ];
}
