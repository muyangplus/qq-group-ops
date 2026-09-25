import { encodeCallback } from "./callbackData.js";
import type { KeyboardModal } from "../adapters/qqOfficial.js";
import {
  escapeCardText,
  renderCard,
  singleLine,
  type CardButton,
  type CardButtonStyle,
} from "./cardTemplate.js";
import { ActivityStatus } from "../core/enums.js";
import {
  PROFILE_ENTRY_YEARS,
  type UserProfile,
} from "./userProfiles.js";
import type {
  Activity,
  ActivityRegistration,
  ActivityService,
  ActivityWaitlistEntry,
} from "./activity.js";
import type { DisplayNameService } from "./displayNames.js";
import type { RichMessage } from "./richMessages.js";

/**
 * 活动卡片（§B2 用户确认的交互落点）。
 *
 * 三种视图 + 名单卡，全部走 `renderCard()`（Markdown 正文 + 内嵌按钮 + 纯文本降级）：
 *
 * - **成员卡**：发到群里的那张，报名 / 取消报名 / 详情 / 名单 / 订阅都是**回调按钮**；
 *   报名与取消报名带官方 `modal` 二次确认；
 * - **配置卡**：`/activity create` 之后返回，`cb:activity:config:<短码>` 也打开；
 * - **管理卡**：`cb:activity:manage:<短码>`，含待释放名额与班级/年级分布；
 * - **名单卡**：每页 10 人，默认只列「序号 姓名（班级）备注」（**不显示学号/学院**），
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

/** 名单卡每页人数（用户确认）。 */
export const SIGNUP_PAGE_SIZE = 10;
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

export class ActivityCardService {
  private readonly options: ActivityCardServiceOptions;
  private readonly now: () => Date;

  public constructor(options: ActivityCardServiceOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * §B3 后接线：装配统计图片 / CSV 导出。
   *
   * 未装配时管理卡不出「统计图片」、名单卡不出「导出 CSV」（条件渲染）；
   * runtime 在服务创建后调用一次即可（与 `AdminCommandService.setActivityExtras` 同套路）。
   */
  public setActivityExtras(extras: {
    stats?: ActivityStatsLike | undefined;
    exportService?: ActivityExportLike | undefined;
  }): void {
    if (extras.stats !== undefined) {
      this.options.stats = extras.stats;
    }
    if (extras.exportService !== undefined) {
      this.options.exportService = extras.exportService;
    }
  }

  public get statsAvailable(): boolean {
    return this.options.stats !== undefined;
  }

  public get exportAvailable(): boolean {
    return this.options.exportService !== undefined;
  }

  /** a) 成员卡：发到群里的那张。 */
  public memberCard(input: ActivityCardInput): RichMessage {
    const { activity, registrations } = input;
    const capacity = activity.capacity;
    const count = registrations.length;
    const waitlist = input.waitlist ?? [];
    const full = capacity !== undefined && count + activity.heldSlots >= capacity;
    const groupLabel =
      input.groupLabel ?? (activity.groupNumber || activity.groupId);
    const code = codeOf(activity);

    const lines: string[] = [];
    if (activity.description) {
      lines.push(escapeCardText(activity.description), "");
    }
    lines.push(`活动群：${escapeCardText(groupLabel)}`);
    lines.push(
      capacity === undefined
        ? `报名：${count} 人（不限名额）`
        : full
          ? `报名：${count} / ${capacity} · 已满，可进候补`
          : `报名：${count} / ${capacity}`,
    );
    lines.push(`候补：${waitlist.length} 人`);
    lines.push(`截止：${formatCloseAt(activity, this.now())}`);
    lines.push(...formatRules(activity));
    lines.push(...formatLinks(activity));

    const rows: CardButton[][] = [];
    rows.push([
      callbackButton("join", "我要报名", "activity", "join", code, {
        style: 1,
        modal: {
          content: "确认报名该活动？",
          confirmText: "报名",
          cancelText: "取消",
        },
      }),
      callbackButton("quit", "取消报名", "activity", "quit", code, {
        style: 3,
        modal: {
          content: "确认取消报名？",
          confirmText: "取消报名",
          cancelText: "返回",
        },
      }),
    ]);
    const secondRow: CardButton[] = [
      callbackButton("info", "活动详情", "activity", "info", code),
    ];
    // 「报名名单」只有管理者能看到（非管理者不生成按钮；回调里还会再校验一次）
    if (input.canManage ?? false) {
      secondRow.push(
        callbackButton("signups", "报名名单", "activity", "signups", code, 1),
      );
    }
    rows.push(secondRow);

    const groupId = activity.groupId;
    if (groupId.length > 0) {
      rows.push([this.subscribeButton(groupId, input.viewerId)]);
    }

    return renderCard({
      title: activity.title,
      lines,
      rows,
      buttonHint: "点击下方按钮立即操作：",
      // 纯文本降级里保留可复制的等价指令（按钮不可用时仍能报名 / 取消报名）
      footer: [
        `报名：/activity join ${code} · 取消报名：/activity quit ${code}`,
        `活动详情：/activity info ${code}`,
      ],
    });
  }

  /** b) 配置卡：`/activity create` 之后返回；`cb:activity:config:<短码>` 也打开。 */
  public configCard(input: ActivityCardInput): RichMessage {
    const { activity } = input;
    const code = codeOf(activity);
    // 绑定群列表由调用方提供（`ActivityService.listBoundGroups`），缺省回落到归属群
    const groups = input.boundGroups ?? (activity.groupId ? [activity.groupId] : []);
    const boundLabel =
      groups.length > 0
        ? groups
            .map((groupId) => escapeCardText(this.options.groupLabel?.(groupId) ?? groupId))
            .join("、")
        : "（未绑定）";
    const registrations = input.registrations.length;
    const capacity = activity.capacity;
    const lines = [
      `**短码**：${code}`,
      `**标题**：${escapeCardText(activity.title)}`,
      `**状态**：${statusLabel(activity, this.now())}`,
      capacity === undefined
        ? `**名额**：不限（已报名 ${registrations}）`
        : `**名额**：${capacity}（已报名 ${registrations} · 待释放 ${activity.heldSlots}）`,
      `**限制**：${restrictionLabel(activity)}`,
      `**截止**：${formatCloseAt(activity, this.now())}`,
      `**递补**：${activity.waitlistPromotion === "auto" ? "自动递补" : "手动释放名额"}`,
      `**提醒@全体**：${activity.mentionAll ? "开" : "关"}（机器人无法 @全体成员，开启后只提示操作者手动 @）`,
      `**报名通知**：${activity.notifyCreator ? "开" : "关"}（有人报名时私信发起人）`,
      `**绑定群**：${boundLabel}（发布与满员广播都发到这些群）`,
      ...formatLinks(activity),
    ];

    const rows: CardButton[][] = [];
    rows.push([
      ...capacityButton(code, 10, capacity),
      ...capacityButton(code, 20, capacity),
      ...capacityButton(code, 50, capacity),
      ...capacityButton(code, undefined, capacity),
      // 需要自由数值的动作 = 指令按钮（点击预填，用户补参数）
      commandButton("capacity-custom", "自定", `/activity set ${code} capacity `),
    ]);
    rows.push([
      callbackButton(
        "college",
        "学院限制",
        "activity",
        "college",
        code,
        "allow",
        1,
      ),
      callbackButton("year", "年级限制", "activity", "year", code, "allow", 1),
    ]);
    rows.push([
      callbackButton("closeAt-clear", "不限截止", "activity", "set", code, "closeAt", "clear"),
      commandButton("closeAt-custom", "自定义", `/activity set ${code} closeAt `),
      callbackButton("bindGroups", "绑定群", "activity", "bindings", code),
    ]);
    rows.push([
      callbackButton(
        "promotion",
        activity.waitlistPromotion === "auto" ? "递补 自动" : "递补 手动",
        "activity",
        "set",
        code,
        "waitlistPromotion",
        activity.waitlistPromotion === "auto" ? "manual" : "auto",
      ),
      callbackButton(
        "notifyCreator",
        activity.notifyCreator ? "报名通知 关" : "报名通知 开",
        "activity",
        "set",
        code,
        "notifyCreator",
        activity.notifyCreator ? "off" : "on",
      ),
    ]);
    // 起停动作：开放报名是固定动作（回调自动完成）；取消活动带二次确认（同一行省一行）
    rows.push([
      callbackButton("preview", "预览卡片", "activity", "preview", code),
      callbackButton("open", "开放报名", "activity", "open", code, {
        style: 1,
        modal: {
          content: "开放报名并把卡片发到群里？",
          confirmText: "开放",
          cancelText: "取消",
        },
      }),
      callbackButton("cancel", "取消", "activity", "cancel", code, {
        style: 3,
        modal: {
          content: "确认取消该活动？会私信通知已报名与候补同学。",
          confirmText: "确认",
          cancelText: "返回",
        },
      }),
    ]);

    return renderCard({
      title: `活动配置 ${code}`,
      lines,
      rows,
      buttonHint: "点击即生效：",
      footer: [`活动管理：/activity set ${code} <字段> <值>`],
    });
  }

  /** c) 管理卡：`cb:activity:manage:<短码>`。 */
  public manageCard(input: ActivityCardInput): RichMessage {
    const { activity, registrations } = input;
    const waitlist = input.waitlist ?? [];
    const code = codeOf(activity);
    const capacity = activity.capacity;
    const profiles = registrations
      .map((registration) => this.options.profiles?.get(registration.userId))
      .filter((profile): profile is UserProfile => profile !== undefined);
    const lines = [
      `**报名**：${registrations.length}${capacity === undefined ? " 人（不限名额）" : ` / ${capacity}`}`,
      `**候补**：${waitlist.length} 人`,
      `**待释放名额**：${activity.heldSlots}`,
      `**学院分布**：${distribution(profiles.map((profile) => profile.college))}`,
      `**年级分布**：${distribution(profiles.map((profile) => profile.year))}`,
      `**截止**：${formatCloseAt(activity, this.now())}`,
      `**递补**：${activity.waitlistPromotion === "auto" ? "自动递补" : "手动释放名额"}`,
    ];

    const rows: CardButton[][] = [];
    // 「统计图片」与「报名名单」都是查看类入口，放同一行；§B3 未装配时不生成（优雅降级）
    const signupRow: CardButton[] = [
      callbackButton("signups", "报名名单", "activity", "signups", code, 1),
    ];
    if (this.statsAvailable) {
      signupRow.push(callbackButton("stats", "统计图片", "activity", "stats", code));
    }
    rows.push(signupRow);
    const secondRow: CardButton[] = [];
    // 「释放名额」只在有冻结名额（手动递补模式下有人取消）时才生成
    if (activity.heldSlots > 0) {
      secondRow.push(
        callbackButton("release", "释放名额", "activity", "release", code, {
          style: 1,
          modal: {
            content: "释放一个冻结名额：优先递补候补第一位。",
            confirmText: "释放",
            cancelText: "返回",
          },
        }),
      );
    }
    secondRow.push(
      callbackButton("resend", "重发卡片", "activity", "resend", code),
    );
    rows.push(secondRow);
    rows.push([
      callbackButton(
        "status",
        activity.status === ActivityStatus.Open ? "关闭报名" : "开放报名",
        "activity",
        "status",
        code,
        activity.status === ActivityStatus.Open ? "close" : "open",
      ),
      callbackButton("cancel", "取消活动", "activity", "cancel", code, {
        style: 3,
        modal: {
          content: "确认取消该活动？会私信通知已报名与候补同学。",
          confirmText: "取消活动",
          cancelText: "返回",
        },
      }),
    ]);
    // 开关类一行 2 个（标准：描述 + 开/关）
    const toggleRow: CardButton[] = [
      callbackButton(
        "mentionAll",
        activity.mentionAll ? "提醒全体 关" : "提醒全体 开",
        "activity",
        "set",
        code,
        "mentionAll",
        activity.mentionAll ? "off" : "on",
      ),
      callbackButton(
        "notifyCreator",
        activity.notifyCreator ? "报名通知 关" : "报名通知 开",
        "activity",
        "set",
        code,
        "notifyCreator",
        activity.notifyCreator ? "off" : "on",
      ),
    ];
    rows.push(toggleRow);

    return renderCard({
      title: `活动管理 ${code}`,
      lines,
      rows,
      buttonHint: "点击操作：",
      footer: [`导出与统计：/activity signups ${code}`],
    });
  }

  /** d) 名单卡：每页 10 人，管理者专用。 */
  public signupsCard(
    input: ActivityCardInput & { page?: number; full?: boolean },
  ): RichMessage {
    const { activity, registrations } = input;
    const waitlist = input.waitlist ?? [];
    const code = codeOf(activity);
    const full = input.full ?? false;
    const pageSize = SIGNUP_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(registrations.length / pageSize));
    const page = clampPage(input.page ?? 1, pageCount);
    const slice = registrations.slice((page - 1) * pageSize, page * pageSize);

    const lines = [
      `**活动**：${code} ${escapeCardText(activity.title)}`,
      `**报名**：${registrations.length}${activity.capacity === undefined ? "" : ` / ${activity.capacity}`} · 第 ${page} / ${pageCount} 页`,
      `**显示**：${full ? "完整信息（含学号 / 学院）" : "默认（不含学号 / 学院）"}`,
      "",
    ];
    slice.forEach((registration, index) => {
      const profile = this.options.profiles?.get(registration.userId);
      const serial = (page - 1) * pageSize + index + 1;
      lines.push(`${serial}. ${signupLine(registration, profile, full)}`);
    });
    if (waitlist.length > 0) {
      lines.push("", `**候补**：${waitlistSummary(waitlist)}`);
    }

    const rows: CardButton[][] = [];
    const paging: CardButton[] = [];
    if (page > 1) {
      paging.push(
        callbackButton("prev", "上一页", "activity", "signups", code, page - 1, full ? "full" : undefined),
      );
    }
    if (page < pageCount) {
      paging.push(
        callbackButton("next", "下一页", "activity", "signups", code, page + 1, full ? "full" : undefined),
      );
    }
    paging.push(
      callbackButton(
        "full",
        full ? "默认信息" : "完整信息",
        "activity",
        "signups",
        code,
        page,
        full ? undefined : "full",
      ),
    );
    rows.push(paging);
    // §B3 未装配时不生成导出按钮
    if (this.exportAvailable) {
      rows.push([
        callbackButton("export", "导出 CSV", "activity", "export", code, {
          style: 1,
        }),
      ]);
    }

    const footer: string[] = [];
    if (page < pageCount) {
      footer.push(`下一页：/activity signups ${code} +${page + 1}`);
    }
    if (page > 1) {
      footer.push(`上一页：/activity signups ${code} +${page - 1}`);
    }
    footer.push("名单只对管理者可见；默认不含学号与学院。");

    return renderCard({
      title: `报名名单 ${code}`,
      lines,
      rows,
      buttonHint: "翻页与显示：",
      footer,
    });
  }

  /**
   * 满员广播卡（§B4）：报名后恰好满员时发到**所有绑定群**。
   *
   * 纯群消息（不属于任何人的私信），去重在 `activity_notifications` 里按
   * `(活动, "group:<群ID>", "full")` 记录，每个群只发一次。
   */
  public fullCard(input: ActivityCardInput): RichMessage {
    const { activity } = input;
    const capacity = activity.capacity;
    const waitlist = (input.waitlist ?? []).length;
    const code = codeOf(activity);
    const registered = input.registrations.length;
    const groupId = activity.groupId;
    return renderCard({
      title: `活动已满 ${code}`,
      lines: [
        `**${escapeCardText(activity.title)}**`,
        capacity === undefined
          ? `活动已满 ${registered} 人`
          : `活动已满 ${registered} / ${capacity}`,
        `后续报名将自动进入候补队列（当前候补 ${waitlist} 人）`,
        `截止：${formatCloseAt(activity, this.now())}`,
      ],
      rows: [
        [
          callbackButton("info", "活动详情", "activity", "info", code),
          ...(groupId.length > 0 ? [this.subscribeButton(groupId, input.viewerId)] : []),
        ],
      ],
      buttonHint: "点击查看：",
      footer: [`候补报名：/activity join ${code}`],
    });
  }

  /**
   * 绑定群子卡（§B4）：列出所有绑定群 + 解绑 + 绑定 / 解绑指令按钮。
   *
   * 新增 / 解绑需要群号（自由文本），因此走**指令按钮**（`/activity bind|unbind`）；
   * 解绑已有的群是固定动作，用**回调**（`cb:activity:unbind:<短码>:<群ID>`）。
   */
  public bindGroupsCard(input: {
    activity: Activity;
    groups: readonly string[];
    page?: number;
  }): RichMessage {
    const { activity } = input;
    const code = codeOf(activity);
    const perPage = BIND_GROUP_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(input.groups.length / perPage));
    const page = clampPage(input.page ?? 1, pageCount);
    const slice = input.groups.slice((page - 1) * perPage, page * perPage);
    const label = (groupId: string): string =>
      this.options.groupLabel?.(groupId) ?? groupId;
    const lines = [
      `**活动**：${code} ${escapeCardText(activity.title)}`,
      `**绑定群**：${input.groups.length} 个 · 第 ${page} / ${pageCount} 页`,
      "绑定群会收到发布卡片与满员广播；归属群：",
      "",
    ];
    if (slice.length === 0) {
      lines.push("（还没有绑定群，点下方「绑定群」补一个）");
    }
    slice.forEach((groupId, index) => {
      const serial = (page - 1) * perPage + index + 1;
      const own = groupId === activity.groupId ? "（归属群）" : "";
      lines.push(`${serial}. ${escapeCardText(label(groupId))}${own}`);
    });

    if (input.groups.length > perPage) {
      lines.push("", `（共 ${input.groups.length} 个，每页 ${perPage} 个，可翻页）`);
    }

    const rows: CardButton[][] = [];
    const unbindRow: CardButton[] = slice.map((groupId, index) =>
      callbackButton(
        `unbind-${index}`,
        "解绑",
        "activity",
        "unbind",
        code,
        groupId,
        page,
        { style: 3 },
      ),
    );
    if (unbindRow.length > 0) {
      rows.push(unbindRow);
    }
    rows.push([
      commandButton("bind", "绑定群", `/activity bind ${code} `),
      callbackButton("back", "返回配置", "activity", "config", code),
    ]);
    const paging: CardButton[] = [];
    if (page > 1) {
      paging.push(callbackButton("prev", "上一页", "activity", "bind", code, page - 1));
    }
    if (page < pageCount) {
      paging.push(callbackButton("next", "下一页", "activity", "bind", code, page + 1));
    }
    if (paging.length > 0) {
      rows.push(paging);
    }

    return renderCard({
      title: `绑定群 ${code}`,
      lines,
      rows,
      buttonHint: "点击操作：",
      footer: [
        `绑定：/activity bind ${code} <群号|#群短码>`,
        `解绑：/activity unbind ${code} <群号|#群短码>`,
      ],
    });
  }

  /** 学院 / 年级选择子卡（配置卡入口）。 */  public rulesCard(input: {
    activity: Activity;
    kind: "college" | "year";
    mode: "allow" | "deny";
    page?: number;
  }): RichMessage {
    const { activity, kind, mode } = input;
    const code = codeOf(activity);
    const isAllow = mode === "allow";
    const selected = new Set(
      kind === "college"
        ? isAllow
          ? activity.allowColleges
          : activity.denyColleges
        : isAllow
          ? activity.allowYears
          : activity.denyYears,
    );
    const options =
      kind === "college"
        ? (this.options.roster?.listColleges() ?? [])
        : [...PROFILE_ENTRY_YEARS];
    const pageSize = kind === "college" ? COLLEGE_PAGE_SIZE : options.length;
    const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
    const page = clampPage(input.page ?? 1, pageCount);
    const slice = options.slice((page - 1) * pageSize, page * pageSize);

    const lines = [
      `**活动**：${code} ${escapeCardText(activity.title)}`,
      `**模式**：${isAllow ? "白名单（仅这些可报名）" : "黑名单（这些不能报名）"}`,
      `**已选**：${selected.size > 0 ? [...selected].join("、") : "（未选择，表示不限）"}`,
      "",
      kind === "college"
        ? "点一下切换选中（● 表示已选）；学院来自班级库。"
        : "点一下切换选中（● 表示已选）。",
    ];

    const rows: CardButton[][] = [];
    const choiceRow: CardButton[] = [];
    for (const option of slice) {
      const marked = selected.has(option);
      choiceRow.push(
        callbackButton(
          `option-${option}`,
          `${marked ? "● " : ""}${option}`,
          "activity",
          kind,
          code,
          mode,
          page,
          option,
        ),
      );
    }
    const modeButton = callbackButton(
      "mode",
      isAllow ? "白名单" : "黑名单",
      "activity",
      kind,
      code,
      isAllow ? "deny" : "allow",
      1,
    );
    const clearButton = callbackButton(
      "clear",
      "清空",
      "activity",
      kind,
      code,
      mode,
      page,
      "clear",
      { style: 3 },
    );
    const paging: CardButton[] = [];
    if (pageCount > 1) {
      if (page > 1) {
        paging.push(
          callbackButton("prev", "上一页", "activity", kind, code, mode, page - 1),
        );
      }
      if (page < pageCount) {
        paging.push(
          callbackButton("next", "下一页", "activity", kind, code, mode, page + 1),
        );
      }
    }
    // 学院名一行 1 个（长名 + `● ` 标记会超 12 字），年级 5 个；其余行放模式 / 清空 / 翻页 / 返回
    const perRow = kind === "college" ? 1 : 5;
    while (choiceRow.length > 0) {
      rows.push(choiceRow.splice(0, perRow));
    }
    rows.push([modeButton, clearButton]);
    if (paging.length > 0) {
      rows.push(paging);
    }
    rows.push([
      callbackButton("back", "返回配置", "activity", "config", code),
    ]);

    return renderCard({
      title: kind === "college" ? `学院限制 ${code}` : `年级限制 ${code}`,
      lines,
      rows,
      buttonHint: "点击切换：",
      footer: [`第 ${page} / ${pageCount} 页`],
    });
  }

  /** 订阅开关按钮：`cb:activity:subscribe:<群ID>`；已订阅显示 `订阅 开`。 */
  public subscribeButton(groupId: string, userId?: string): CardButton {
    const subscribed =
      userId !== undefined && (this.options.isSubscribed?.(groupId, userId) ?? false);
    return callbackButton(
      "subscribe",
      `订阅 ${subscribed ? "开" : "关"}`,
      "activity",
      "subscribe",
      groupId,
      subscribed ? "off" : "on",
      { style: subscribed ? 4 : undefined },
    );
  }
}

/** 活动卡片里的短码展示：`#A7K2Q9`。 */
export function code(activity: Activity): string {
  return codeOf(activity);
}

function codeOf(activity: Activity): string {
  return `#${activity.code}`;
}

/** 回调按钮：`action.type=1`，`permission: { type: 2 }`（所有人）。 */
function callbackButton(
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
function commandButton(
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

function capacityButton(
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

function statusLabel(activity: Activity, now: Date): string {
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

function restrictionLabel(activity: Activity): string {
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

function formatMonthDayTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRules(activity: Activity): string[] {
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

function formatLinks(activity: Activity): string[] {
  if (activity.links.length === 0) {
    return [];
  }
  const rendered = activity.links
    .map((link) => `[${escapeCardText(link.label)}](${link.url})`)
    .join(" · ");
  return [`相关链接：${rendered}`];
}

/** 名单行：默认「姓名（班级）备注」；`full` 才带学号与学院。 */
function signupLine(
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
function waitlistSummary(waitlist: readonly ActivityWaitlistEntry[]): string {
  const names = waitlist
    .slice(0, 10)
    .map((entry) => escapeCardText(singleLine(entry.displayName) || "（未填姓名）"));
  const extra = waitlist.length > 10 ? `（还有 ${waitlist.length - 10} 人）` : "";
  return `${names.join("、")}${extra}`;
}

/** 学院 / 年级分布：前 3 个 + 「其他 N 人」。 */
function distribution(values: readonly string[]): string {
  if (values.length === 0) {
    return "（无资料）";
  }
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.length > 0 ? value : "（未填）";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
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

function clampPage(page: number, pageCount: number): number {
  const parsed = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(parsed, 1), pageCount);
}
