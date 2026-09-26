import type { KeyboardModal } from "../adapters/qqOfficial.js";
import { ActivityStatus } from "../core/enums.js";
import { compareLabels } from "../core/collation.js";
import type {
  Activity,
  ActivityRegistration,
  ActivityService,
  ActivityWaitlistEntry,
} from "./activity.js";
import { encodeCallback } from "./callbackData.js";
import {
  escapeCardText,
  renderCard,
  singleLine,
  CardButton,
  CardButtonStyle,
} from "./cardTemplate.js";
import type { DisplayNameService } from "./displayNames.js";
import type { UserProfile } from "./userProfiles.js";

/**
 * activityCards 的类型、常量与纯函数（从 activityCards.ts 拆出；主文件会原样再导出公开名字）。
 */


/**
 * 活动卡片（§B2 用户确认的交互落点）。
 *
 * 三种视图 + 名单卡，全部走 `renderCard()`（Markdown 正文 + 内嵌按钮 + 纯文本降级）：
 *
 * - **成员卡**：发到群里的那张，报名 / 取消报名 / 详情 / 名单 / 订阅都是**回调按钮**；
 *   报名与取消报名带官方 `modal` 二次确认；
 * - **配置卡**：`/activity create` 之后返回，`cb:activity:config:<短码>` 也打开；
 * - **管理卡**：`cb:activity:manage:<短码>`，含待释放名额与班级/年级分布；
 * - **名单卡**：每页 5 人（§卡片规范 v2），默认只列「序号 姓名（班级）备注」（**不显示学号/学院**），
 *   `完整信息` 开关才切到含学号/学院；只对管理者可用。
 *
 * 需要 §B3 提供的能力（统计图片、CSV 导出）在这里是**可选依赖**：没装配时
 * 对应的按钮不生成（条件渲染），因此 B2 可以独立交付，之后接线即可。
 */

/**
 * 统计图片渲染（§B3）。
 *
 * - `render(...)` 拿不到 canvas 依赖 / 字体时返回 `undefined`，调用方降级为文字统计卡；
 * - `sendToGroup(...)` 可选：装配了解释「怎么把 PNG 发到群里」的实现（上传 + `msg_type=7`）
 *   才会生成「统计图片」按钮。只实现了渲染、没实现发送时按钮不生成，
 *   避免出现「点了没反应」的入口。
 */
export interface ActivityStatsLike {
  /**
   * 是否具备「把渲染结果发到群里」的能力。
   *
   * 管理卡据此决定是否生成「统计图片」按钮：只有渲染、没有发送通道时按钮不生成，
   * 避免出现「点了却没反应」的入口。
   */
  readonly canSend?: boolean | undefined;
  render(
    activity: Activity,
    registrations: readonly ActivityRegistration[],
    profiles?: ReadonlyMap<string, UserProfile> | undefined,
  ): Promise<Buffer | undefined>;
  /** 把渲染好的 PNG 发到活动群；失败返回 `{ ok: false }`，调用方降级。 */
  sendImageToGroup?(
    groupId: string,
    png: Buffer,
    fileName: string,
  ): Promise<{ ok: boolean; detail: string }>;
}

/** CSV 导出（§B3）：由调用方保证只私信给操作者本人。 */
export interface ActivityExportLike {
  exportCsv(input: {
    activity: Activity;
    registrations: readonly ActivityRegistration[];
    /** 候补名单（带「候补」标记，排在正式报名之后）。 */
    waitlist?: readonly ActivityWaitlistEntry[] | undefined;
    operatorId: string;
  }): Promise<{ ok: boolean; text: string }>;
}

export interface ActivityCardServiceOptions {
  activity?: ActivityService | undefined;
  /** 私信订阅查询（`cb:activity:subscribe:<群ID>` 的当前状态）。 */
  isSubscribed?: ((groupId: string, userId: string) => boolean) | undefined;
  /** 展示名解析（群号 / 短码）；缺省时回退到活动里的群号或内部 id。 */
  display?: DisplayNameService | undefined;
  /** 班级/学院解析（名单与分布统计）。 */
  profiles?: {
    get(userId: string): UserProfile | undefined;
  } | undefined;
  /** 班级库（学院/年级按钮）；缺省时对应按钮不生成。 */
  roster?: { listColleges(): string[] } | undefined;
  /** §B3 统计图片；未装配时不生成「统计图片」按钮。 */
  stats?: ActivityStatsLike | undefined;
  /** §B3 CSV 导出；未装配时不生成「导出 CSV」按钮。 */
  exportService?: ActivityExportLike | undefined;
  /** 群展示名解析（绑定群子卡）；缺省时直接显示内部群 ID。 */
  groupLabel?: ((groupId: string) => string) | undefined;
  now?: (() => Date) | undefined;
}

/** 名单卡每页人数（§卡片规范 v2：列表类每页目标 5 条；条目是纯文本行，不受键盘约束）。 */
export const SIGNUP_PAGE_SIZE = 5;
/**
 * 学院按钮每页个数。
 *
 * 用户确认「每页 5 个」，但学院名很长（「化学与生命科学学院」= 9 字，加 `● ` 标记
 * 后 11 字），而标准要求一行按钮文字总长 ≤12 字、整盘 ≤5 行：学院**一行只能 1 个**，
 * 5 行减去「模式/清空 + 翻页 + 返回」只剩 2 行，所以每页 2 个。
 *
 * 长名单由「下一页」翻页承担，不牺牲排版约束；年级（2 字）仍是一行 5 个、单页够用。
 */
export const COLLEGE_PAGE_SIZE = 2;

/** 绑定群子卡每页个数（用户确认：每页 5 个）。 */
export const BIND_GROUP_PAGE_SIZE = 5;

export interface ActivityCardInput {
  activity: Activity;
  registrations: readonly ActivityRegistration[];
  waitlist?: readonly ActivityWaitlistEntry[] | undefined;
  /** 绑定群列表（配置卡 / 绑定群子卡展示）；缺省回落到归属群。 */
  boundGroups?: readonly string[] | undefined;
  /** 展示用：群号 / 群短码（缺省用活动里的 groupNumber）。 */
  groupLabel?: string | undefined;
  /** 当前查看者：用于「只有管理者看到报名名单按钮」与订阅开关状态。 */
  viewerId?: string | undefined;
  /** 当前查看者是否有管理权限（`canManageActivity`）。 */
  canManage?: boolean | undefined;
}

export function code(activity: Activity): string {
  return codeOf(activity);
}

export function codeOf(activity: Activity): string {
  return `#${activity.code}`;
}

/** 回调按钮：`action.type=1`，`permission: { type: 2 }`（所有人）。 */
export function callbackButton(
  id: string,
  label: string,
  namespace: string,
  action: string,
  ...rest: readonly (
    | string
    | number
    | undefined
    | { style?: CardButtonStyle | undefined; modal?: KeyboardModal | undefined }
  )[]
): CardButton {
  const tail = rest.at(-1);
  const options =
    typeof tail === "object" && tail !== null
      ? (tail as { style?: CardButtonStyle | undefined; modal?: KeyboardModal | undefined })
      : undefined;
  const args = (options ? rest.slice(0, -1) : rest).filter(
    (arg): arg is string | number => arg !== undefined,
  );
  return {
    id,
    label,
    callbackData: encodeCallback(namespace, action, ...args),
    permission: { type: 2 },
    ...(options?.style !== undefined ? { style: options.style } : {}),
    ...(options?.modal !== undefined ? { modal: options.modal } : {}),
  };
}

/** 指令按钮（需要自由文本参数：自定义名额 / 自定义截止）。 */
export function commandButton(
  id: string,
  label: string,
  command: string,
  options: { style?: CardButtonStyle | undefined } = {},
): CardButton {
  return {
    id,
    label,
    command,
    permission: { type: 2 },
    ...(options.style !== undefined ? { style: options.style } : {}),
  };
}

export function capacityButton(
  code: string,
  value: number | undefined,
  current: number | undefined,
): CardButton[] {
  const label = value === undefined ? "不限" : String(value);
  const selected = value === current;
  return [
    callbackButton(
      `capacity-${label}`,
      selected ? `● ${label}` : label,
      "activity",
      "set",
      code,
      "capacity",
      value === undefined ? "clear" : String(value),
      { style: selected ? 4 : undefined },
    ),
  ];
}

export function statusLabel(activity: Activity, now: Date): string {
  if (activity.status === ActivityStatus.Open) {
    return activity.closeAt !== undefined && now.getTime() >= activity.closeAt.getTime()
      ? "已截止（等待管理）"
      : "报名中";
  }
  if (activity.status === ActivityStatus.Draft) {
    return "草稿（未开放报名）";
  }
  if (activity.status === ActivityStatus.Cancelled) {
    return "已取消";
  }
  return "已结束";
}

export function restrictionLabel(activity: Activity): string {
  const parts: string[] = [];
  if (activity.allowColleges.length > 0) {
    parts.push(`限学院：${activity.allowColleges.join("、")}`);
  }
  if (activity.allowYears.length > 0) {
    parts.push(`限年级：${activity.allowYears.join("、")}`);
  }
  if (activity.denyColleges.length > 0) {
    parts.push(`不接受学院：${activity.denyColleges.join("、")}`);
  }
  if (activity.denyYears.length > 0) {
    parts.push(`不接受年级：${activity.denyYears.join("、")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "不限";
}

/** `closeAt` 展示成 `MM-DD HH:mm`；已过则显示「MM-DD HH:mm（已截止）」。 */
export function formatCloseAt(activity: Activity, now: Date = new Date()): string {
  const closeAt = activity.closeAt;
  if (!closeAt) {
    return "不限";
  }
  const text = formatMonthDayTime(closeAt);
  return now.getTime() >= closeAt.getTime() ? `${text}（已截止）` : text;
}

export function formatMonthDayTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRules(activity: Activity): string[] {
  const lines: string[] = [];
  const allow: string[] = [];
  if (activity.allowColleges.length > 0) {
    allow.push(`学院 ${activity.allowColleges.join("、")}`);
  }
  if (activity.allowYears.length > 0) {
    allow.push(`年级 ${activity.allowYears.join("、")}`);
  }
  if (allow.length > 0) {
    lines.push(`报名限制：${allow.join(" · ")}`);
  }
  const deny: string[] = [];
  if (activity.denyColleges.length > 0) {
    deny.push(`学院 ${activity.denyColleges.join("、")}`);
  }
  if (activity.denyYears.length > 0) {
    deny.push(`年级 ${activity.denyYears.join("、")}`);
  }
  if (deny.length > 0) {
    lines.push(`不接受：${deny.join(" · ")}`);
  }
  return lines;
}

export function formatLinks(activity: Activity): string[] {
  if (activity.links.length === 0) {
    return [];
  }
  const rendered = activity.links
    .map((link) => `[${escapeCardText(link.label)}](${link.url})`)
    .join(" · ");
  return [`相关链接：${rendered}`];
}

/** 名单行：默认「姓名（班级）备注」；`full` 才带学号与学院。 */
export function signupLine(
  registration: ActivityRegistration,
  profile: UserProfile | undefined,
  full: boolean,
): string {
  const name = escapeCardText(registration.displayName || "（未填姓名）");
  const className = profile?.className ? escapeCardText(profile.className) : "";
  const note = registration.note ? ` 备注：${escapeCardText(registration.note)}` : "";
  if (!full) {
    return `${name}${className ? `（${className}）` : ""}${note}`;
  }
  const detail = [profile?.studentId, profile?.college]
    .filter((item): item is string => Boolean(item))
    .map((item) => escapeCardText(item))
    .join(" · ");
  return `${name}${className ? `（${className}）` : ""}${detail ? ` · ${detail}` : ""}${note}`;
}

/** 候补区：最多 10 个姓名 + 「还有 N 人」。 */
export function waitlistSummary(waitlist: readonly ActivityWaitlistEntry[]): string {
  const names = waitlist
    .slice(0, 10)
    .map((entry) => escapeCardText(singleLine(entry.displayName) || "（未填姓名）"));
  const extra = waitlist.length > 10 ? `（还有 ${waitlist.length - 10} 人）` : "";
  return `${names.join("、")}${extra}`;
}

/** 学院 / 年级分布：前 3 个 + 「其他 N 人」。 */
export function distribution(values: readonly string[]): string {
  if (values.length === 0) {
    return "（无资料）";
  }
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.length > 0 ? value : "（未填）";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || compareLabels(left[0], right[0]),
  );
  const head = sorted
    .slice(0, 3)
    .map(([label, count]) => `${escapeCardText(label)} ${count}`)
    .join(" · ");
  const rest = sorted.slice(3);
  if (rest.length === 0) {
    return head;
  }
  const restCount = rest.reduce((sum, [, count]) => sum + count, 0);
  return `${head} · 其他 ${restCount}`;
}

export function clampPage(page: number, pageCount: number): number {
  const parsed = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(parsed, 1), pageCount);
}
