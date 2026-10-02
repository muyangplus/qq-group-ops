import type { ActivityService } from "./activity.js";
import type { Activity, UpdateActivityInput } from "./activityCore.js";
import {
  ACTIVITY_SET_USAGE,
  CLEAR_WORDS,
  formatError,
  normalize,
  parseCloseAt,
  parseLink,
  parseLinks,
  parseList,
  parsePositiveInt,
  parseToggle,
  parseYearList,
  TOGGLE_OFF,
  TOGGLE_ON,
} from "./commands/support.js";

/**
 * `/activity set` 与「管理后台改活动字段」的**共享解析层**。
 *
 * 为什么单独一个模块：字段解析与两个副作用（名额改到满员要广播「活动已满」、改完私信
 * 已报名 / 候补者）以前只写在 `commands/activityCommands.ts` 里；管理后台要搬这套字段时
 * 再写一遍必然漂移（漏通知、漏广播）。现在两边都从这里拿**同一份字段表 + 同一套解析**，
 * 副作用由各调用层按 `resolveActivitySetting` 返回的标记执行。
 */

/** 管理后台渲染输入控件用的字段类型。 */
export type ActivitySettingFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "link"
  | "datetime"
  | "toggle"
  | "list"
  | "years"
  | "mode";

export interface ActivitySettingField {
  /** 规范字段名（指令层小写写法，也是回执里显示的名字）。 */
  field: string;
  /** 界面 / 回执里的中文名。 */
  label: string;
  kind: ActivitySettingFieldKind;
  /** 指令层接受的全部写法（含中文别名），首项是规范名。 */
  aliases: readonly string[];
  /** 能否用 `clear` / `清空`（`CLEAR_WORDS`）复位。 */
  clearable: boolean;
  /** 一句话说明（管理后台的占位提示）。 */
  hint: string;
  /** 改动后是否私信已报名 / 候补者（与指令层 `ACTIVITY_NOTIFY_FIELDS` 一致）。 */
  notifiesParticipants: boolean;
}

/**
 * 字段表（顺序 = 管理后台下拉框顺序，按「常用 → 少用」排）。
 *
 * `link` 与 `links` 是两条不同语义：前者**追加**一条，后者**整体替换**（与指令层一致）。
 */
export const ACTIVITY_SETTING_FIELDS: readonly ActivitySettingField[] = [
  {
    field: "title",
    label: "标题",
    kind: "text",
    aliases: ["title", "标题"],
    clearable: false,
    hint: "活动标题；不能清空",
    notifiesParticipants: true,
  },
  {
    field: "desc",
    label: "简介",
    kind: "textarea",
    aliases: ["desc", "description", "描述"],
    clearable: true,
    hint: "活动简介；clear = 清空",
    notifiesParticipants: true,
  },
  {
    field: "capacity",
    label: "名额",
    kind: "number",
    aliases: ["capacity", "名额"],
    clearable: true,
    hint: "正整数；clear = 不限名额（调小到已满会广播「活动已满」）",
    notifiesParticipants: true,
  },
  {
    field: "group",
    label: "活动群号",
    kind: "text",
    aliases: ["group", "群号"],
    clearable: true,
    hint: "展示用群号（活动群，不是发布群）；clear = 清空",
    notifiesParticipants: true,
  },
  {
    field: "closeAt",
    label: "截止时间",
    kind: "datetime",
    aliases: ["closeat", "截止"],
    clearable: true,
    hint: "MM-DD HH:mm 或 YYYY-MM-DD HH:mm；clear = 取消截止",
    notifiesParticipants: true,
  },
  {
    field: "link",
    label: "链接（追加）",
    kind: "link",
    aliases: ["link", "链接"],
    clearable: true,
    hint: "http(s) 链接，可写 说明=url；只追加一条；clear = 清空全部链接",
    notifiesParticipants: true,
  },
  {
    field: "links",
    label: "链接列表（整体替换）",
    kind: "link",
    aliases: ["links", "链接列表"],
    clearable: true,
    hint: "逗号 / 空格分隔的链接列表，整体替换；clear = 清空",
    notifiesParticipants: true,
  },
  {
    field: "remindAt",
    label: "提醒时间",
    kind: "datetime",
    aliases: ["remindat", "提醒", "提醒时间"],
    clearable: true,
    hint: "到点在所有发布群广播一次报名提醒；clear = 取消提醒",
    notifiesParticipants: false,
  },
  {
    field: "waitlistPromotion",
    label: "递补方式",
    kind: "mode",
    aliases: ["waitlistpromotion", "递补"],
    clearable: true,
    hint: "auto 自动递补 / manual 手动释放；clear = 手动",
    notifiesParticipants: false,
  },
  {
    field: "mentionAll",
    label: "提醒全体",
    kind: "toggle",
    aliases: ["mentionall", "提醒全体"],
    clearable: false,
    hint: "开放报名时是否 @全体成员；开 / 关",
    notifiesParticipants: false,
  },
  {
    field: "notifyCreator",
    label: "通知发起人",
    kind: "toggle",
    aliases: ["notifycreator", "通知发起人"],
    clearable: false,
    hint: "有人报名时是否私信活动发起人；开 / 关",
    notifiesParticipants: false,
  },
  {
    field: "allowColleges",
    label: "允许学院",
    kind: "list",
    aliases: ["allowcolleges", "允许学院"],
    clearable: true,
    hint: "逗号 / 空格分隔的学院白名单；clear = 不限",
    notifiesParticipants: true,
  },
  {
    field: "denyColleges",
    label: "禁止学院",
    kind: "list",
    aliases: ["denycolleges", "禁止学院", "不允许学院"],
    clearable: true,
    hint: "逗号 / 空格分隔的学院黑名单；clear = 清空",
    notifiesParticipants: true,
  },
  {
    field: "allowYears",
    label: "允许年级",
    kind: "years",
    aliases: ["allowyears", "允许年级"],
    clearable: true,
    hint: "年级白名单（两位，如 22 / 23）；clear = 不限",
    notifiesParticipants: true,
  },
  {
    field: "denyYears",
    label: "禁止年级",
    kind: "years",
    aliases: ["denyyears", "禁止年级", "不允许年级"],
    clearable: true,
    hint: "年级黑名单（两位，如 22 / 23）；clear = 清空",
    notifiesParticipants: true,
  },
];

const FIELD_BY_ALIAS = new Map<string, ActivitySettingField>();
for (const field of ACTIVITY_SETTING_FIELDS) {
  for (const alias of field.aliases) {
    FIELD_BY_ALIAS.set(alias.toLowerCase(), field);
  }
}

/** 按指令层写法（含中文别名）取字段定义；认不出来返回 `undefined`。 */
export function activitySettingField(
  rawField: string,
): ActivitySettingField | undefined {
  return FIELD_BY_ALIAS.get(rawField.trim().toLowerCase());
}

export interface ResolvedActivitySetting {
  ok: true;
  /** 规范字段名。 */
  field: string;
  fieldLabel: string;
  /** 交给 `ActivityService.updateActivity` 的补丁。 */
  patch: UpdateActivityInput;
  /** 递补改成自动前要先释放冻结名额（与 `setWaitlistPromotion` 一致）。 */
  releaseHeldSlot: boolean;
  /** 改完要广播一次「活动已满」（名额被调小；`announceActivityFull` 自己会判重）。 */
  announceFull: boolean;
  /** 改动后是否要私信已报名 / 候补者。 */
  notifyParticipants: boolean;
  /** 成功回执（递补有专用文案）。 */
  successText: string;
}

export type ActivitySettingFailureKind =
  /** 字段不认识 / 用法不对：指令层回 `ACTIVITY_SET_USAGE`。 */
  | "usage"
  /** 语义上拒绝（如标题不能清空）：文案直接给用户看。 */
  | "refusal"
  /** 值解析失败：指令层包成「设置失败：…」，管理面直接回 400。 */
  | "invalid";

export type ActivitySettingResolution =
  | ResolvedActivitySetting
  | { ok: false; kind: ActivitySettingFailureKind; text: string };

/**
 * 解析一条 `/activity set`，返回**要落库的补丁 + 要跑的副作用标记**（纯函数，不碰服务）。
 *
 * 值不合法 / 字段不认识都以返回值报告，不抛异常：指令层要按类型区分文案
 * （`ACTIVITY_SET_USAGE` / 原话 / `设置失败：…`），管理面统一回 400。
 */
export function resolveActivitySetting(
  activity: Activity,
  rawField: string,
  value: string,
): ActivitySettingResolution {
  const target = activitySettingField(rawField);
  if (!target) {
    return { ok: false, kind: "usage", text: ACTIVITY_SET_USAGE };
  }
  const cleared = CLEAR_WORDS.has(value.trim().toLowerCase());
  const finish = (
    patch: UpdateActivityInput,
    options: {
      releaseHeldSlot?: boolean;
      announceFull?: boolean;
      successText?: string;
    } = {},
  ): ResolvedActivitySetting => ({
    ok: true,
    field: target.field,
    fieldLabel: target.label,
    patch,
    releaseHeldSlot: options.releaseHeldSlot ?? false,
    announceFull: options.announceFull ?? false,
    notifyParticipants: target.notifiesParticipants,
    successText:
      options.successText ?? `**结果**：已更新 ${rawField}（#${activity.code}）。`,
  });

  try {
    switch (target.field) {
      case "title":
        if (cleared) {
          return {
            ok: false,
            kind: "refusal",
            text: "标题不能清空，请填写新的标题。",
          };
        }
        return finish({ title: value });
      case "desc":
        return finish({ description: cleared ? "" : value });
      case "capacity":
        // 名额被调小到「已满」时也广播一次「活动已满」卡；
        // announceActivityFull 自己会判断是否真的满员，且 `(活动, 群, full)` 去重表保证每群只发一次。
        return finish(
          {
            capacity: cleared
              ? undefined
              : parsePositiveInt(rawField, value),
          },
          { announceFull: true },
        );
      case "group":
        return finish({ groupNumber: cleared ? "" : value });
      case "link":
        return finish(
          { links: cleared ? [] : [...activity.links, parseLink(value)] },
        );
      case "links":
        return finish({ links: cleared ? [] : parseLinks(value) });
      case "closeAt":
        return finish({
          closeAt: cleared ? undefined : parseCloseAt(value, target.label),
        });
      case "remindAt":
        return finish({
          remindAt: cleared ? undefined : parseCloseAt(value, target.label),
        });
      case "waitlistPromotion":
        return resolveWaitlistPromotion(activity, value, cleared, finish);
      case "mentionAll":
        return finish({ mentionAll: parseToggle(rawField, value) });
      case "notifyCreator":
        return finish({ notifyCreator: parseToggle(rawField, value) });
      case "allowColleges":
        return finish({ allowColleges: cleared ? [] : parseList(value) });
      case "denyColleges":
        return finish({ denyColleges: cleared ? [] : parseList(value) });
      case "allowYears":
        return finish({ allowYears: cleared ? [] : parseYearList(value) });
      case "denyYears":
        return finish({ denyYears: cleared ? [] : parseYearList(value) });
      default:
        return { ok: false, kind: "usage", text: ACTIVITY_SET_USAGE };
    }
  } catch (error) {
    return { ok: false, kind: "invalid", text: formatError(error) };
  }
}

/** 递补方式：`auto`（自动递补）会先把已有冻结名额释放掉；`clear` = 手动。 */
function resolveWaitlistPromotion(
  activity: Activity,
  value: string,
  cleared: boolean,
  finish: (
    patch: UpdateActivityInput,
    options?: { releaseHeldSlot?: boolean; successText?: string },
  ) => ResolvedActivitySetting,
): ResolvedActivitySetting {
  const normalized = normalize(value);
  const mode: "auto" | "manual" = cleared
    ? "manual"
    : normalized === "auto" ||
        normalized === "自动" ||
        normalized === "自动递补"
      ? "auto"
      : normalized === "manual" ||
          normalized === "手动" ||
          normalized === "手动释放"
        ? "manual"
        : TOGGLE_ON.has(normalized)
          ? "auto"
          : TOGGLE_OFF.has(normalized)
            ? "manual"
            : (() => {
                throw new Error("递补方式需要 auto（自动）或 manual（手动）");
              })();
  return finish(
    { waitlistPromotion: mode },
    {
      releaseHeldSlot: mode === "auto" && activity.heldSlots > 0,
      successText: `**结果**：递补方式已改为「${
        mode === "auto" ? "自动递补" : "手动释放名额"
      }」。`,
    },
  );
}

export interface ActivitySettingApplyOptions {
  /** 是否要在改动后私信已报名 / 候补者（指令层 = `ACTIVITY_NOTIFY_FIELDS.has(field)`）。 */
  notify: boolean;
  /** 名额改动后广播一次「活动已满」（指令层的 `announceActivityFull(ctx, id)`）。 */
  announceFull?(activityId: string): Promise<void>;
  /** 变更私信（指令层的 `voidNotifyActivityChanged(ctx, activity, field)`）。 */
  notifyParticipants?(activity: Activity, field: string): void;
}

/**
 * 执行一条 `/activity set`：解析 → 释放冻结名额 / 落库 / 满员广播 → 变更私信。
 *
 * 指令层与管理后台都调它（副作用以回调注入），所以两边行为逐字一致；
 * 返回值与指令层的 `applyActivitySetting` 形状一致（`**结果**：…` / `设置失败：…`）。
 */
export async function applyActivitySettingValue(
  activities: ActivityService,
  activity: Activity,
  field: string,
  value: string,
  options: ActivitySettingApplyOptions,
): Promise<{ ok: boolean; text: string }> {
  const resolved = resolveActivitySetting(activity, field, value);
  if (!resolved.ok) {
    return {
      ok: false,
      text:
        resolved.kind === "usage"
          ? ACTIVITY_SET_USAGE
          : resolved.kind === "refusal"
            ? resolved.text
            : `设置失败：${resolved.text}`,
    };
  }
  try {
    if (resolved.releaseHeldSlot && activity.heldSlots > 0) {
      activities.releaseHeldSlot(activity.activityId);
    }
    activities.updateActivity(activity.activityId, resolved.patch);
    if (resolved.announceFull) {
      await options.announceFull?.(activity.activityId);
    }
  } catch (error) {
    return { ok: false, text: `设置失败：${formatError(error)}` };
  }
  const updated = activities.getActivity(activity.activityId);
  if (options.notify && resolved.notifyParticipants) {
    options.notifyParticipants?.(updated, field);
  }
  return { ok: true, text: resolved.successText };
}

/** 当前值的**人话描述**（审计「旧值 → 新值」与界面展示用）。 */export function describeActivitySetting(
  activity: Activity,
  rawField: string,
): string {
  const target = activitySettingField(rawField);
  if (!target) {
    return "（未知字段）";
  }
  switch (target.field) {
    case "title":
      return activity.title;
    case "desc":
      return activity.description.length > 0 ? activity.description : "（空）";
    case "capacity":
      return activity.capacity === undefined
        ? "不限"
        : String(activity.capacity);
    case "group":
      return activity.groupNumber.length > 0 ? activity.groupNumber : "（未填）";
    case "closeAt":
      return activity.closeAt === undefined
        ? "（未设置）"
        : formatDateTime(activity.closeAt);
    case "remindAt":
      return activity.remindAt === undefined
        ? "（未设置）"
        : formatDateTime(activity.remindAt);
    case "link":
    case "links":
      return activity.links.length === 0
        ? "（无）"
        : activity.links.map((link) => link.url).join("、");
    case "waitlistPromotion":
      return activity.waitlistPromotion === "auto" ? "自动递补" : "手动释放";
    case "mentionAll":
      return activity.mentionAll ? "开" : "关";
    case "notifyCreator":
      return activity.notifyCreator ? "开" : "关";
    case "allowColleges":
      return formatList(activity.allowColleges);
    case "denyColleges":
      return formatList(activity.denyColleges);
    case "allowYears":
      return formatList(activity.allowYears);
    case "denyYears":
      return formatList(activity.denyYears);
    default:
      return "（未知字段）";
  }
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "（无）" : values.join("、");
}

/** 本地时间 `YYYY-MM-DD HH:mm`（与卡片口径一致，不带秒）。 */
export function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
