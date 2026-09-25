import { ActivityStatus } from "../core/enums.js";
import type {
  Activity,
  ActivityService,
} from "./activity.js";
import {
  ActivityStatsLike,
  ActivityExportLike,
  ActivityCardServiceOptions,
  SIGNUP_PAGE_SIZE,
  COLLEGE_PAGE_SIZE,
  BIND_GROUP_PAGE_SIZE,
  ActivityCardInput,
  code,
  codeOf,
  callbackButton,
  commandButton,
  capacityButton,
  statusLabel,
  restrictionLabel,
  formatCloseAt,
  formatRules,
  formatLinks,
  signupLine,
  waitlistSummary,
  distribution,
  clampPage,
} from "./activityCardsCore.js";
import {
  escapeCardText,
  renderCard,
  CardButton,
} from "./cardTemplate.js";
import type { RichMessage } from "./richMessages.js";
import {
  PROFILE_ENTRY_YEARS,
  UserProfile,
} from "./userProfiles.js";

export { BIND_GROUP_PAGE_SIZE, COLLEGE_PAGE_SIZE, SIGNUP_PAGE_SIZE, code, formatCloseAt } from "./activityCardsCore.js";
export type { ActivityCardInput, ActivityCardServiceOptions, ActivityExportLike, ActivityStatsLike } from "./activityCardsCore.js";

/**
 * activityCards 服务主体（类型、常量与纯函数见 activityCardsCore.ts）。
 */

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
