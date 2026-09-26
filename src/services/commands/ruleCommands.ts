import { getLogger } from "../../core/logger.js";
import {
  describePunishActions,
  PUNISH_ACTION_KEYS,
  PUNISH_ACTION_LABELS,
  type PunishActionKey,
  type PunishActions,
} from "../groupConfigCore.js";
import { encodeCallback, extractPageToken } from "../callbackData.js";
import { renderCard, type CardButton } from "../cardTemplate.js";
import type { AdminCommandContext } from "./context.js";
import {
  type CardResult,
  type CommandResult,
  actionButton,
  cardFromText,
  confirmRuleResetModal,
  formatEffectiveConfig,
  formatError,
  GLOBAL_RULES_DENIED,
  GLOBAL_RULES_SET_USAGE,
  isGlobalTarget,
  isRosterField,
  normalize,
  normalizeRulePanel,
  parseRuleSetting,
  rosterModeButton,
  RULE_COLLEGE_PAGE_SIZE,
  RULE_KEYWORD_PAGE_SIZE,
  RULE_LIST_MAX_COUNT,
  RULE_PANEL_FIELDS,
  RULE_REGEX_MAX_LENGTH,
  ruleChoiceButton,
  ruleFieldLabel,
  ruleFieldShortLabel,
  RULES_ADD_USAGE,
  RULES_DEL_USAGE,
  RULES_SET_USAGE,
  ruleToggleButton,
  RuleToggleSpec,
  ruleValueLabel,
  requireValidRegex,
  viewButton,
  viewButtonWithOptions,
} from "./support.js";
import { DEFAULT_GROUP_ID, type GroupConfigOverride } from "../groupConfig.js";
import { resolveUserId } from "./targetResolvers.js";
import { PROFILE_ENTRY_YEARS } from "../userProfiles.js";

/**
 * 规则域：群规则概览 / 5 张子卡（开关、入群审核、违规处理、关键词、名单筛选、更多）/
 * 全局默认规则、字段级继承与恢复、关键词逐条增删、覆盖率总览。
 *
 * 门面 `AdminCommandService` 保留 9 个公开卡片方法（薄包装），业务逻辑集中在这里。
 */

/** 关键词单条上限（与卡片标准一致：太长会挤爆按钮）。 */
const RULE_KEYWORD_MAX_LENGTH = 50;

const log = getLogger("admin-commands");

/**
 * `/rules [群号|#群短码]`：规则概览卡（§C 重构）。
 *
 * 正文标明**本群覆盖了哪些字段**（其余继承全局），入口是 5 个子卡：
 * 开关设置 / 入群审核 / 违规处理 / 关键词 / 更多设置；
 * 末行是 `全局规则`（超管）/ `恢复全部继承`（二次确认）/ `规则帮助`。
 * 所有入口都是回调，点击即出对应子卡。
 */
export function rulesCard(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
  notice?: string,
): CardResult {
  if (isGlobalTarget(parts[1])) {
    return globalRulesCard(ctx, userId, 1);
  }
  const targetGroupId = ctx.helpers.resolveTargetGroupId(groupId, parts[1]);
  if (!targetGroupId) {
    if (!parts[1] && ctx.permissions.isSuperAdmin(userId)) {
      return globalRulesCard(ctx, userId, 1);
    }
    const card = renderCard({
      title: "群规则",
      lines: [
        "该指令需要在群内使用，或在私信中提供群号 / #群短码。",
        "用法：/rules <群号|#群短码>；全局默认规则：/rules all",
      ],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  if (!ctx.permissions.canReviewContent(userId, targetGroupId)) {
    const card = renderCard({
      title: "权限不足",
      lines: ["需要审核员或以上权限（查看）／群管理员或以上（修改）。"],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const config = ctx.configStore.get(targetGroupId);
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);

  const overridden = ctx.configStore.overriddenFields(targetGroupId);
  const overrideNames = [...overridden]
    .map((field) => ruleFieldLabel(field))
    .filter((label) => label.length > 0);
  const inheritanceLine =
    overrideNames.length > 0
      ? `**本群覆盖**：${overrideNames.join("、")}（其余继承全局）`
      : "**本群覆盖**：全部继承全局";

  const rows: CardButton[][] = [];
  if (canManage) {
    // 一行按钮文字总长 ≤12 字（见 docs/CARD-STANDARD.md）：
    // 4+4+4=12 刚好，再加一个字就超。
    rows.push([
      viewButton("panel-toggle", "开关设置", "rules", "panel", targetGroupId, "toggle"),
      viewButton("panel-decision", "入群审核", "rules", "panel", targetGroupId, "decision"),
      viewButton("panel-punish", "违规处理", "rules", "panel", targetGroupId, "punish"),
    ]);
    rows.push([
      viewButton("panel-keywords", "关键词", "rules", "panel", targetGroupId, "keyword"),
      viewButton("panel-roster", "名单筛选", "rules", "panel", targetGroupId, "roster"),
    ]);
  }
  const lastRow: CardButton[] = [];
  if (canManage) {
    rows.push([
      viewButton("panel-more", "更多设置", "rules", "panel", targetGroupId, "more"),
      viewButtonWithOptions(
        "resetAll",
        "恢复全部继承",
        encodeCallback("rules", "resetAll", targetGroupId, "1"),
        { modal: confirmRuleResetModal("本群全部规则") },
      ),
    ]);
  }
  if (ctx.permissions.isSuperAdmin(userId)) {
    lastRow.push(viewButton("global", "全局规则", "rules", "all"));
  }
  lastRow.push(viewButton("help", "规则帮助", "help", "topic", "rules"));
  rows.push(lastRow);

  const lines = [
    ...ctx.helpers.renderNotice(notice),
    inheritanceLine,
    "",
    `**关键词**：${config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）"}`,
    `**警告文案**：${config.warningMessage}`,
    `**禁言时长**：${config.muteDurationSeconds} 秒`,
    `**入群要求**：班级 ${config.joinRequireClass} · 姓名 ${config.joinRequireName} · 审核意见 ${config.joinReviewOpinion}`,
    `**名单筛选**：学院 ${config.allowColleges.length}/${config.denyColleges.length} · 年级 ${config.allowYears.length}/${config.denyYears.length}`,
    `**机器人启用**：${config.enabled ? "开" : "关"} · 导出 ${config.exportEnabled ? "开" : "关"}`,
  ];

  return cardFromText("群规则", lines.join("\n"), {
    rows,
    footer: [
      `本群：${ctx.helpers.displayGroup(targetGroupId)}`,
      "「恢复本页继承」只清本页字段；「恢复全部继承」清空本群全部覆盖。",
    ],
  });
}

/**
 * 子卡：开关设置 / 入群审核 / 违规处理 / 关键词 / 名单筛选 / 更多设置（§C 重构）。
 *
 * 按钮语义统一为**显示当前状态**（`关键词过滤 开`）；开关是回调，点击即切换并回到同一子卡；
 * 每张子卡底部是「恢复本页继承」（二次确认，清本页字段的覆盖）与「返回规则」。
 */
export function rulesPanelCard(
  ctx: AdminCommandContext,
  panel: string,
  targetGroupId: string,
  userId: string,
  notice?: string,
  page = 1,
  mode: "allow" | "deny" = "allow",
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    const card = renderCard({
      title: "权限不足",
      lines: ["修改规则需要群管理员或以上权限。"],
      rows: [[viewButton("back", "返回规则", "rules", "view", targetGroupId)]],
    });
    return { ok: false, text: card.text, rich: card };
  }

  const normalized = normalizeRulePanel(panel);
  switch (normalized) {
    case "keyword":
      return rulesKeywordPanel(ctx, targetGroupId, userId, page, notice);
    case "regex":
      return rulesRegexPanel(ctx, targetGroupId, userId, notice);
    case "roster":
      return rulesRosterPanel(ctx, targetGroupId, userId, mode, page, notice);
    case "toggle":
      return rulesTogglePanel(ctx, targetGroupId, userId, notice);
    case "decision":
      return rulesDecisionPanel(ctx, targetGroupId, userId, notice, normalized);
    case "punish":
      return rulesPunishPanel(ctx, targetGroupId, userId, notice);
    case "more":
      return rulesMorePanel(ctx, targetGroupId, userId, notice);
  }
}

/** 子卡：开关设置（一行 2 个，标签显示当前状态）。 */
export function rulesTogglePanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  notice?: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const overridden = ctx.configStore.overriddenFields(targetGroupId);
  const fields: Array<RuleToggleSpec> = [
    { field: "wordFilterEnabled", label: "过滤", panel: "toggle", value: config.wordFilterEnabled },
    { field: "joinAuditEnabled", label: "入群审核", panel: "toggle", value: config.joinAuditEnabled },
    { field: "exportEnabled", label: "导出", panel: "toggle", value: config.exportEnabled },
  ];
  return rulesBoolPanel(ctx, {
    title: "群规则 · 开关设置",
    targetGroupId,
    userId,
    panel: "toggle",
    notice,
    fields,
    overridden,
  });
}

/** 子卡：入群审核（5 个决策枚举 + 要求班级/姓名，`●` 标当前值）。 */
export function rulesDecisionPanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  notice: string | undefined,
  panel: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const rows: CardButton[][] = [];
  rows.push([
    ruleChoiceButton(
      "decision-manual",
      "人工",
      targetGroupId,
      "joinDecision",
      "manual",
      config.joinDecision === "manual",
      panel,
    ),
    ruleChoiceButton(
      "decision-match",
      "命中通过",
      targetGroupId,
      "joinDecision",
      "approve_on_match",
      config.joinDecision === "approve_on_match",
      panel,
    ),
    ruleChoiceButton(
      "decision-reject",
      "命中拒绝",
      targetGroupId,
      "joinDecision",
      "reject_on_match",
      config.joinDecision === "reject_on_match",
      panel,
    ),
  ]);
  rows.push([
    ruleChoiceButton(
      "decision-auto",
      "全自动",
      targetGroupId,
      "joinDecision",
      "auto_approve",
      config.joinDecision === "auto_approve",
      panel,
    ),
    ruleChoiceButton(
      "decision-mismatch",
      "未命中拒绝",
      targetGroupId,
      "joinDecision",
      "reject_on_mismatch",
      config.joinDecision === "reject_on_mismatch",
      panel,
    ),
  ]);
  rows.push([
    ruleToggleButton(
      "requireClass",
      "要求班级",
      targetGroupId,
      "joinRequireClass",
      config.joinRequireClass,
      panel,
    ),
    ruleToggleButton(
      "requireName",
      "要求姓名",
      targetGroupId,
      "joinRequireName",
      config.joinRequireName,
      panel,
    ),
  ]);
  rows.push([
    ruleRestoreButton(ctx, panel, targetGroupId, ["joinDecision", "joinRequireClass", "joinRequireName"]),
    ruleBackButton(ctx, targetGroupId),
  ]);
  return rulePanelCard(ctx,
    "群规则 · 入群审核",
    targetGroupId,
    userId,
    notice,
    rows,
    [
      ruleInheritanceLine(ctx, targetGroupId, "joinDecision"),
      `**回答正则**：${config.joinAnswerPattern || "（未设置，用指令按钮设置）"}`,
    ],
  );
}

/** 子卡：违规处理（**多选** 警告 / 撤回 / 禁言 / 踢出 / 拉黑 + 禁言时长）。 */
export function rulesPunishPanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  notice?: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const actions = config.punishActions;
  const rows: CardButton[][] = [];
  rows.push(
    (["warn", "recall", "mute"] as const).map((key) =>
      punishToggleButton(
        key,
        targetGroupId,
        actions[key],
      ),
    ),
  );
  rows.push(
    (["kick", "blacklist"] as const).map((key) =>
      punishToggleButton(
        key,
        targetGroupId,
        actions[key],
      ),
    ),
  );
  rows.push([
    ruleChoiceButton("mute-60", "60秒", targetGroupId, "muteDurationSeconds", "60", config.muteDurationSeconds === 60, "punish"),
    ruleChoiceButton("mute-600", "600秒", targetGroupId, "muteDurationSeconds", "600", config.muteDurationSeconds === 600, "punish"),
    ruleChoiceButton("mute-3600", "1小时", targetGroupId, "muteDurationSeconds", "3600", config.muteDurationSeconds === 3600, "punish"),
  ]);
  rows.push([
    viewButton("regex-panel", "正则白名单", "rules", "panel", targetGroupId, "regex"),
  ]);
  rows.push([
    ruleRestoreButton(ctx, "punish", targetGroupId, ["punishActions", "muteDurationSeconds"]),
    ruleBackButton(ctx, targetGroupId),
  ]);
  return rulePanelCard(ctx,
    "群规则 · 违规处理",
    targetGroupId,
    userId,
    notice,
    rows,
    [
      ruleInheritanceLine(ctx, targetGroupId, "punishActions"),
      `**当前动作**：${describePunishActions(actions)}（点按钮切换，可多选）`,
      `**禁言时长**：${config.muteDurationSeconds} 秒`,
      "**拉黑**：只落本群黑名单并尝试官方拉黑，**不会自动踢人**（官方要求目标不在群中）。",
    ],
  );
}

/** 违规处理动作开关按钮：标签显示当前状态，点击即切换（回调 `cb:rules:punishToggle`）。 */
function punishToggleButton(
  key: PunishActionKey,
  targetGroupId: string,
  enabled: boolean,
): CardButton {
  return viewButton(
    `punish-${key}`,
    `${PUNISH_ACTION_LABELS[key]} ${enabled ? "开" : "关"}`,
    "rules",
    "punishToggle",
    targetGroupId,
    key,
  );
}

/** 子卡：关键词（分页逐条删除 + 加词 / 清空）。 */
export function rulesKeywordPanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  page: number,
  notice?: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const keywords = [...config.keywords];
  const pageSize = RULE_KEYWORD_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(keywords.length / pageSize));
  const current = Math.min(Math.max(page, 1), pageCount);
  const slice = keywords.slice((current - 1) * pageSize, current * pageSize);

  const rows: CardButton[][] = [];
  for (const [index, keyword] of slice.entries()) {
    const serial = (current - 1) * pageSize + index;
    rows.push([
      viewButton(
        `del-${serial}`,
        // 卡片正文与按钮都**不带词**：群内明文列出违规词会被平台判「消息内容违规」
        // （真机踩过），也不该把词表摊在群里给所有人看。
        `删 #${serial + 1}`,
        "rules",
        "delKeyword",
        targetGroupId,
        serial,
        current,
      ),
    ]);
  }
  const paging: CardButton[] = [];
  if (current > 1) {
    paging.push(
      viewButton("prev", "上一页", "rules", "panelPage", targetGroupId, "keyword", current - 1),
    );
  }
  if (current < pageCount) {
    paging.push(
      viewButton("next", "下一页", "rules", "panelPage", targetGroupId, "keyword", current + 1),
    );
  }
  // 第 4 行：加词 / 看词表 / 翻页 / 清空（每行总长 ≤12 字）
  rows.push([
    actionButton("add-keyword", "加词", "/rules add keyword "),
    viewButton("list-keywords", "看词表", "rules", "keywords", targetGroupId, current),
    ...paging,
    viewButtonWithOptions(
      "clear-keywords",
      "清空",
      encodeCallback("rules", "clearKeyword", targetGroupId),
      { modal: confirmRuleResetModal("本群关键词") },
    ),
  ]);
  rows.push([
    ruleRestoreButton(ctx, "keyword", targetGroupId, ["keywords"], current),
    ruleBackButton(ctx, targetGroupId),
  ]);

  const body: string[] = [
    ...ctx.helpers.renderNotice(notice),
    `**关键词**：${keywords.length > 0 ? `共 ${keywords.length} 条 · 第 ${current} / ${pageCount} 页` : "（未配置）"}`,
    ...(keywords.length > 0
      ? [
          "词表**只走私信**：群内不列出词条（明文列出违规词会被平台判「消息内容违规」，也不该摊给全群看），",
          "点下方「看词表」会把完整编号列表私信给你。",
          `本页序号：#${(current - 1) * pageSize + 1} ~ #${(current - 1) * pageSize + slice.length}`,
        ]
      : ["", "暂无关键词：点「加词」发送 `/rules add keyword <词>`，或手输 `/rules set keywords 广告,刷屏`。"]),
    "",
    ruleInheritanceLine(ctx, targetGroupId, "keywords"),
  ];
  const footer = [`本群：${ctx.helpers.displayGroup(targetGroupId)}`];
  if (current < pageCount) {
    footer.push(`下一页：/rules keyword +${current + 1}`);
  }
  if (current > 1) {
    footer.push(`上一页：/rules keyword +${current - 1}`);
  }
  return cardFromText("群规则 · 关键词", body.join("\n"), {
    rows,
    footer,
  });
}

/**
 * 回调：`cb:rules:keywords:<群>:<页码>` —— 把整份关键词表**私信**发给操作人。
 *
 * 为什么不直接在卡片里列出来（真机踩过）：群内明文列出违规词（如「黄片 / 裸聊」）
 * 会被平台判 `400 消息内容违规`，整条卡片发不出去；而且词表本来也不该摊给全群看。
 */
export async function keywordListCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  page = 1,
  replyGroupId?: string,
): Promise<CardResult> {
  if (
    !ctx.permissions.canManageRules(userId, targetGroupId) &&
    !ctx.permissions.isSuperAdmin(userId)
  ) {
    return ruleDeniedCard(ctx, targetGroupId, "查看词表需要群管理员或以上权限。");
  }
  const notice = ctx.helpers.mention(replyGroupId, userId);
  const back = viewButton(
    "back",
    "返回关键词",
    "rules",
    "panelPage",
    targetGroupId,
    "keyword",
    page,
  );
  const keywords = [...ctx.configStore.get(targetGroupId).keywords];
  if (keywords.length === 0) {
    return cardFromText(
      "关键词词表",
      ctx.helpers.renderNotice(`${notice}本群还没有关键词。`).join("\n"),
      { rows: [[back]] },
    );
  }

  log.info("keyword list sent privately", {
    targetGroupId,
    userId,
    count: keywords.length,
  });
  const card = cardFromText(
    "关键词词表（仅私信）",
    [
      `群：${ctx.helpers.displayGroup(targetGroupId)} · 共 ${keywords.length} 条`,
      "",
      ...keywords.map((keyword, index) => `${index + 1}. ${keyword}`),
    ].join("\n"),
    { footer: ["词表只在私信里展示；群内卡片只给序号，避免触发平台内容审核。"] },
  );
  const sent = ctx.richMessages
    ? await ctx.richMessages.sendToUser(userId, card.rich)
    : { ok: false, detail: "未装配私信发送通道" };
  const result = cardFromText(
    "关键词词表",
    (sent.ok
      ? ctx.helpers.renderNotice(
          `${notice}已私信发送词表（共 ${keywords.length} 条），请查看私聊。`,
        )
      : [
          ...ctx.helpers.renderNotice(`${notice}私信发送失败：${sent.detail}`),
          "请先在私聊里给机器人发一条消息（打开会话窗口）后再点一次。",
        ]
    ).join("\n"),
    { rows: [[back]] },
  );
  return { ...result, ok: sent.ok };
}

/** 子卡：正则规则 + 用户白名单（§B1）。 */
export function rulesRegexPanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  notice?: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const regexRules = [...config.regexRules];
  const whitelist = [...config.userWhitelist];
  const rows: CardButton[][] = [
    [
      actionButton("add-regex", "加正则", "/rules add regex "),
      actionButton("add-whitelist", "加白名单", "/rules add whitelist "),
    ],
    [
      viewButtonWithOptions(
        "clear-regex",
        "清空正则",
        encodeCallback("rules", "clearList", targetGroupId, "regexRules"),
        { modal: confirmRuleResetModal("本群正则规则") },
      ),
      viewButtonWithOptions(
        "clear-whitelist",
        "清空白名单",
        encodeCallback("rules", "clearList", targetGroupId, "userWhitelist"),
        { modal: confirmRuleResetModal("本群用户白名单") },
      ),
    ],
    [
      ruleRestoreButton(ctx, "regex", targetGroupId, ["regexRules", "userWhitelist"]),
      ruleBackButton(ctx, targetGroupId),
    ],
  ];
  const body: string[] = [
    `**正则规则**：${regexRules.length > 0 ? `${regexRules.length} 条` : "（未配置）"}`,
    ...regexRules
      .slice(0, 5)
      .map((rule, index) => `${index + 1}. ${rule}`),
    ...(regexRules.length > 5
      ? [`…… 还有 ${regexRules.length - 5} 条（用 /rules del regex <序号> 删除）`]
      : []),
    `**用户白名单**：${whitelist.length > 0 ? `${whitelist.length} 人` : "（未配置）"}`,
    ...whitelist
      .slice(0, 5)
      .map((id, index) => `${index + 1}. ${ctx.helpers.displayUser(id)}`),
    "",
    "正则命中与关键词**同一条处罚管道**：按本群「命中处罚」执行，多个命中取最高动作。",
    "白名单内用户与审核员一样豁免判断（不警告、不撤回、不处罚、不写审计）。",
    "多条正则用顿号分隔；含顿号的正则请逐条 `/rules add regex <pattern>` 添加。",
  ];
  return rulePanelCard(ctx, "群规则 · 正则 / 白名单", targetGroupId, userId, notice, rows, body);
}

/** 子卡：名单筛选（学院点选 + 年级点选，白/黑名单切换）。 */
export function rulesRosterPanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  mode: "allow" | "deny",
  page: number,
  notice?: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const colleges = ctx.helpers.roster()?.listColleges() ?? [];
  const pageSize = RULE_COLLEGE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(colleges.length / pageSize));
  const current = Math.min(Math.max(page, 1), pageCount);
  const slice = colleges.slice((current - 1) * pageSize, current * pageSize);
  const selected = new Set(
    mode === "allow" ? config.allowColleges : config.denyColleges,
  );

  // 5 行键盘上限：学院（≤4 行）+ 模式/翻页（1 行）+ 年级（1 行）+ 恢复/返回（1 行）
  const rows: CardButton[][] = [];
  for (const college of slice) {
    rows.push([
      ruleChoiceButton(
        `college-${college}`,
        college,
        targetGroupId,
        mode === "allow" ? "allowColleges" : "denyColleges",
        college,
        selected.has(college),
        "roster",
      ),
    ]);
  }
  if (slice.length === 0) {
    rows.push([
      actionButton(
        "college-manual",
        "手输学院",
        `/rules set ${mode === "allow" ? "allowColleges" : "denyColleges"} `,
      ),
    ]);
  }
  const modePaging: CardButton[] = [
    rosterModeButton("roster-allow", "白名单", targetGroupId, "allow", mode === "allow"),
    rosterModeButton("roster-deny", "黑名单", targetGroupId, "deny", mode === "deny"),
  ];
  if (current > 1) {
    modePaging.push(
      viewButton("prev", "上一页", "rules", "panelPage", targetGroupId, "roster", current - 1, mode),
    );
  }
  if (current < pageCount) {
    modePaging.push(
      viewButton("next", "下一页", "rules", "panelPage", targetGroupId, "roster", current + 1, mode),
    );
  }
  rows.push(modePaging);
  rows.push(
    PROFILE_ENTRY_YEARS.map((year) =>
      ruleChoiceButton(
        `year-${year}`,
        year,
        targetGroupId,
        mode === "allow" ? "allowYears" : "denyYears",
        year,
        (mode === "allow" ? config.allowYears : config.denyYears).includes(year),
        "roster",
      ),
    ),
  );
  rows.push([
    ruleRestoreButton(ctx,
      "roster",
      targetGroupId,
      ["allowColleges", "denyColleges", "allowYears", "denyYears"],
      current,
      mode,
    ),
    ruleBackButton(ctx, targetGroupId),
  ]);

  const collegeLine =
    config.allowColleges.length > 0
      ? `允许学院：${config.allowColleges.join("、")}`
      : config.denyColleges.length > 0
        ? `禁止学院：${config.denyColleges.join("、")}`
        : "学院：不限";
  const yearLine =
    config.allowYears.length > 0
      ? `允许年级：${config.allowYears.join("、")}`
      : config.denyYears.length > 0
        ? `禁止年级：${config.denyYears.join("、")}`
        : "年级：不限";
  return cardFromText(
    "群规则 · 名单筛选",
    [
      ...ctx.helpers.renderNotice(notice),
      `**当前模式**：${mode === "allow" ? "白名单（允许）" : "黑名单（禁止）"}`,
      `**学院**：${collegeLine} · 第 ${current} / ${pageCount} 页`,
      `**年级**：${yearLine}（点一下切换选中）`,
      "",
      ruleInheritanceLine(ctx, targetGroupId, "allowColleges"),
    ].join("\n"),
    {
      rows,
      footer: [
        `本群：${ctx.helpers.displayGroup(targetGroupId)}`,
        "学院来自班级库点选；班级库缺失时可用指令按钮手输。",
      ],
    },
  );
}

/** 子卡：更多设置（补齐所有尚未有按钮的字段）。 */
export function rulesMorePanel(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  notice?: string,
): CardResult {
  const config = ctx.configStore.get(targetGroupId);
  const rows: CardButton[][] = [
    [
      ruleToggleButton("enabled", "机器人", targetGroupId, "enabled", config.enabled, "more"),
      ruleToggleButton("autoApprove", "自动通过", targetGroupId, "autoApprove", config.autoApproveJoin, "more"),
    ],
    [
      ruleToggleButton("notifyAuto", "处理通知", targetGroupId, "notifyAutoApproved", config.notifyAutoApproved, "more"),
      ruleToggleButton("joinNotify", "审核意见", targetGroupId, "joinReviewOpinion", config.joinReviewOpinion, "more"),
    ],
    [
      actionButton("warning", "警告文案", "/rules set warning "),
      actionButton("keyword-manual", "关键词", "/rules set keywords "),
    ],
    [
      actionButton("mute-custom", "禁言时长", "/rules set muteDuration "),
      actionButton("answer-pattern", "回答正则", "/rules set joinAnswerPattern "),
      actionButton("retention", "消息保留", "/rules set rawMessageRetentionDays "),
    ],
    [
      ruleRestoreButton(ctx, "more", targetGroupId, [
        "enabled",
        "autoApproveJoin",
        "notifyAutoApproved",
        "joinReviewOpinion",
        "warningMessage",
        "joinAnswerPattern",
        "rawMessageRetentionDays",
      ]),
      ruleBackButton(ctx, targetGroupId),
    ],
  ];
  return rulePanelCard(ctx,
    "群规则 · 更多设置",
    targetGroupId,
    userId,
    notice,
    rows,
    [
      ruleInheritanceLine(ctx, targetGroupId, "enabled"),
      `**警告文案**：${config.warningMessage}`,
      `**禁言时长**：${config.muteDurationSeconds} 秒 · **回答正则**：${config.joinAnswerPattern || "（未设置）"}`,
      `**消息保留**：${
        config.rawMessageRetentionDays > 0
          ? `${config.rawMessageRetentionDays} 天`
          : "不保留原始消息"
      }`,
      "要求班级 / 要求姓名在「入群审核」子卡；关键词在「关键词」子卡。",
    ],
  );
}

/** 通用布尔开关子卡：一行 2 个，正文逐条列出「字段：当前值（继承 / 本群覆盖）」。 */
export function rulesBoolPanel(
  ctx: AdminCommandContext,
  input: {
  title: string;
  targetGroupId: string;
  userId: string;
  panel: string;
  notice?: string | undefined;
  fields: readonly RuleToggleSpec[];
  overridden: ReadonlySet<keyof GroupConfigOverride>;
}): CardResult {
  const rows: CardButton[][] = [];
  for (let index = 0; index < input.fields.length; index += 2) {
    const pair = input.fields.slice(index, index + 2);
    rows.push(
      pair.map((spec) =>
        ruleToggleButton(
          spec.field,
          spec.label,
          input.targetGroupId,
          spec.field,
          spec.value,
          spec.panel,
        ),
      ),
    );
  }
  rows.push([
    ruleRestoreButton(ctx,
      input.panel,
      input.targetGroupId,
      input.fields.map((spec) => spec.field),
    ),
    ruleBackButton(ctx, input.targetGroupId),
  ]);
  const lines = input.fields.map(
    (spec) =>
      `${spec.label}：${spec.value ? "开" : "关"}（${
        input.overridden.has(spec.field) ? "本群覆盖" : "继承全局"
      }）`,
  );
  return rulePanelCard(ctx,
    input.title,
    input.targetGroupId,
    input.userId,
    input.notice,
    rows,
    lines,
  );
}

/** 规则子卡的统一外壳：正文行 + 权限已校验后的按钮。 */
export function rulePanelCard(
  ctx: AdminCommandContext,
  title: string,
  targetGroupId: string,
  userId: string,
  notice: string | undefined,
  rows: CardButton[][],
  body: readonly string[],
): CardResult {
  void userId;
  const isGlobal = targetGroupId === DEFAULT_GROUP_ID;
  return cardFromText(
    isGlobal ? `${title}（全局）` : title,
    [
      ...(isGlobal ? ["**全局默认规则**：只影响未单独覆盖该字段的群。"] : []),
      ...ctx.helpers.renderNotice(notice),
      ...body,
    ].join("\n"),
    {
      rows,
      footer: [
        isGlobal ? "全局规则仅超管可改。" : `本群：${ctx.helpers.displayGroup(targetGroupId)}`,
      ],
    },
  );
}

/** 正文里的「字段：当前值（继承全局 / 本群覆盖）」。 */
export function ruleInheritanceLine(
  ctx: AdminCommandContext,
  targetGroupId: string,
  field: keyof GroupConfigOverride,
): string {
  const overridden = ctx.configStore.overriddenFields(targetGroupId);
  return `**${ruleFieldLabel(field)}**：${
    overridden.has(field) ? "本群覆盖" : "继承全局"
  }`;
}

/** 「恢复本页继承」按钮（二次确认，调用 `clearFields`）。 */
export function ruleRestoreButton(
  ctx: AdminCommandContext,
  panel: string,
  targetGroupId: string,
  fields: readonly (keyof GroupConfigOverride)[],
  page = 1,
  mode: "allow" | "deny" = "allow",
): CardButton {
  return viewButtonWithOptions(
    `reset-${panel}`,
    "恢复本页继承",
    encodeCallback(
      "rules",
      "resetPage",
      targetGroupId,
      panel,
      fields.join(","),
      page,
      mode,
    ),
    { modal: confirmRuleResetModal("本页字段") },
  );
}

export function ruleBackButton(
  ctx: AdminCommandContext,
  targetGroupId: string): CardButton {
  return viewButton("back", "返回规则", "rules", "view", targetGroupId);
}

/** 回调：规则开关/枚举切换（固定动作 → 自动执行并回刷新后的卡片）。 */
export async function toggleRulesCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  field: string,
  value: string,
  userId: string,
  panel?: string,
  replyGroupId?: string,
  page = 1,
  mode: "allow" | "deny" = "allow",
): Promise<CardResult> {
  // 回调里本来就带着群 id，**不要**再按「私信指令」口径去反查 `#短码/绑定群号`：
  // 群没绑定过时反查会失败，于是点了开关却回一句「私信中设置规则需要提供已绑定的群号」
  // （真机现象），而卡片又已经写死「已更新」，看起来就是自相矛盾的报错。
  const isGlobal =
    targetGroupId === DEFAULT_GROUP_ID || isGlobalTarget(targetGroupId);
  const result = isGlobal
    ? await handleGlobalRulesSet(ctx, userId, [field, value])
    : await handleRulesSet(ctx, targetGroupId, userId, ["rules", "set", field, value]);
  const targetPanel = normalizeRulePanel(panel);
  const label = `${ruleFieldLabel(field)} → ${ruleValueLabel(field, value)}`;
  const renderMenu = (body: string): CardResult => {
    const notice = `${ctx.helpers.mention(replyGroupId, userId)}${body}`;
    return panel
      ? rulesPanelCard(ctx, targetPanel, targetGroupId, userId, notice, page, mode)
      : rulesCard(ctx, undefined, userId, ["rules", targetGroupId], notice);
  };

  if (!result.ok) {
    log.warn("rule update via callback failed", {
      targetGroupId,
      field,
      value,
      userId,
      reason: result.text,
    });
    // 失败也回**同一张菜单**：原因写在菜单顶部，当前状态一眼可见（不再谎报「已更新」）；
    // `ok: false` 保留下来，调用方仍能识别这次没有改动
    const reason = result.text.split("\n")[0] ?? result.text;
    return { ...renderMenu(`未修改：${reason}`), ok: false };
  }
  log.info("rule updated via callback", {
    targetGroupId,
    field,
    value,
    userId,
  });
  return renderMenu(`已更新：${label}`);
}

/**
 * 回调：关键词逐条删除（`cb:rules:delKeyword:<群>:<序号>:<页码>`）。
 *
 * 序号是**当前页内**的序号，删除后回到同一页（页尾自动收敛到上一页）。
 */
export function delKeywordCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  serial: number,
  page: number,
  userId: string,
  replyGroupId?: string,
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    return ruleDeniedCard(ctx, targetGroupId, "删除关键词需要群管理员或以上权限。");
  }
  const config = ctx.configStore.get(targetGroupId);
  const keywords = [...config.keywords];
  const index = serial;
  if (index < 0 || index >= keywords.length) {
    return ruleDeniedCard(ctx, targetGroupId, "该关键词已不存在，可能已被其它操作删除。");
  }
  const removed = keywords[index]!;
  keywords.splice(index, 1);
  ctx.configStore.setOverride({
    groupId: targetGroupId,
    keywords: keywords.length > 0 ? keywords : [],
  });
  log.info("rule keyword deleted via callback", {
    targetGroupId,
    removed,
    userId,
  });
  const nextPage = Math.min(
    Math.max(page, 1),
    Math.max(1, Math.ceil(keywords.length / RULE_KEYWORD_PAGE_SIZE)),
  );
  const notice = `${ctx.helpers.mention(replyGroupId, userId)}已删除关键词：${removed}`;
  return rulesKeywordPanel(ctx, targetGroupId, userId, nextPage, notice);
}

/** 回调：清空关键词（二次确认后走 setOverride，保留字段级覆盖语义）。 */
export function clearKeywordsCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  replyGroupId?: string,
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    return ruleDeniedCard(ctx, targetGroupId, "清空关键词需要群管理员或以上权限。");
  }
  ctx.configStore.setOverride({ groupId: targetGroupId, keywords: [] });
  log.info("rule keywords cleared via callback", { targetGroupId, userId });
  return rulesKeywordPanel(ctx,
    targetGroupId,
    userId,
    1,
    `${ctx.helpers.mention(replyGroupId, userId)}已清空关键词。`,
  );
}

/**
 * 回调：恢复本页继承（`cb:rules:resetPage:<群>:<panel>:<字段列表>`）。
 *
 * 字段列表由按钮带过来，但仍会按面板白名单过滤，避免按钮伪造清掉别的字段。
 */
export function resetRulePageCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  panel: string,
  rawFields: string,
  userId: string,
  replyGroupId?: string,
  page = 1,
  mode: "allow" | "deny" = "allow",
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    return ruleDeniedCard(ctx, targetGroupId, "恢复继承需要群管理员或以上权限。");
  }
  const normalized = normalizeRulePanel(panel);
  const allowed = new Set<keyof GroupConfigOverride>(
    RULE_PANEL_FIELDS[normalized],
  );
  const fields = rawFields
    .split(",")
    .map((field) => field.trim())
    .filter((field): field is keyof GroupConfigOverride =>
      allowed.has(field as keyof GroupConfigOverride),
    );
  if (fields.length === 0) {
    return ruleDeniedCard(ctx, targetGroupId, "本页没有可恢复的字段。");
  }
  ctx.configStore.clearFields(targetGroupId, fields);
  log.info("rule page reset", { targetGroupId, panel: normalized, fields, userId });
  const notice = `${ctx.helpers.mention(replyGroupId, userId)}已恢复本页继承：${fields
    .map((field) => ruleFieldLabel(field))
    .join("、")}`;
  return rulesPanelCard(ctx,
    normalized,
    targetGroupId,
    userId,
    notice,
    page,
    mode,
  );
}

/**
 * 回调：恢复全部继承（`cb:rules:resetAll:<群>`）。
 *
 * 与「恢复本页继承」不同，这里清空该群的全部字段级覆盖，等价于旧 `removeOverride`。
 */
export function resetAllRulesCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  userId: string,
  replyGroupId?: string,
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    return ruleDeniedCard(ctx, targetGroupId, "恢复继承需要群管理员或以上权限。");
  }
  ctx.configStore.removeOverride(targetGroupId);
  log.info("rule overrides reset", { targetGroupId, userId });
  return rulesCard(ctx, undefined, userId, ["rules", targetGroupId], `${ctx.helpers.mention(replyGroupId, userId)}已恢复全部继承。`);
}

/**
 * 回调：违规处理动作开关（`cb:rules:punishToggle:<群>:<动作>`）。
 *
 * §B2 多选：警告 / 撤回 / 禁言 / 踢出 / 拉黑 互相独立，点一下切换该动作并回到同一张子卡。
 */
export function punishToggleCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  keyRaw: string,
  userId: string,
  replyGroupId?: string,
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    return ruleDeniedCard(ctx, targetGroupId, "修改规则需要群管理员或以上权限。");
  }
  const key = PUNISH_ACTION_KEYS.find((item) => item === keyRaw);
  if (!key) {
    return ruleDeniedCard(ctx, targetGroupId, "未知的违规处理动作。");
  }
  const config = ctx.configStore.get(targetGroupId);
  const next: PunishActions = {
    ...config.punishActions,
    [key]: !config.punishActions[key],
  };
  ctx.configStore.setOverride({ groupId: targetGroupId, punishActions: next });
  log.info("punish action toggled via callback", {
    targetGroupId,
    key,
    enabled: next[key],
    userId,
  });
  const notice =
    `${ctx.helpers.mention(replyGroupId, userId)}` +
    `已把「${PUNISH_ACTION_LABELS[key]}」设为${next[key] ? "开" : "关"}；` +
    `当前动作：${describePunishActions(next)}`;
  return rulesPunishPanel(ctx, targetGroupId, userId, notice);
}

/**
 * 回调：学院 / 年级点选（`cb:rules:rosterToggle:<群>:<字段>:<模式>:<取值>`）。
 *
 * `field` 必须是名单类字段；取值按当前列表切换（有则删、无则加）。
 */
export function rosterToggleCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  field: string,
  mode: "allow" | "deny",
  option: string,
  userId: string,
  replyGroupId?: string,
  page = 1,
): CardResult {
  const canManage =
    ctx.permissions.canManageRules(userId, targetGroupId) ||
    ctx.permissions.isSuperAdmin(userId);
  if (!canManage) {
    return ruleDeniedCard(ctx, targetGroupId, "修改名单需要群管理员或以上权限。");
  }
  if (!isRosterField(field)) {
    return ruleDeniedCard(ctx, targetGroupId, "未知的名单字段。");
  }
  const cleaned = option.trim();
  if (cleaned.length === 0) {
    return ruleDeniedCard(ctx, targetGroupId, "没有识别到要切换的取值。");
  }
  const config = ctx.configStore.get(targetGroupId);
  const current = new Set<string>(config[field]);
  if (current.has(cleaned)) {
    current.delete(cleaned);
  } else {
    current.add(cleaned);
  }
  const next = [...current].sort();
  ctx.configStore.setOverride({
    groupId: targetGroupId,
    [field]: next,
  } as GroupConfigOverride);
  log.info("rule roster toggled via callback", {
    targetGroupId,
    field,
    option: cleaned,
    userId,
  });
  const action = current.has(cleaned) ? "已选中" : "已取消";
  const notice = `${ctx.helpers.mention(replyGroupId, userId)}${action}：${cleaned}`;
  return rulesPanelCard(ctx,
    "roster",
    targetGroupId,
    userId,
    notice,
    page,
    mode,
  );
}

/** 权限不足 / 目标非法时的统一子卡提示（可返回规则概览）。 */
export function ruleDeniedCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  reason: string,
): CardResult {
  const card = renderCard({
    title: "权限不足",
    lines: [reason],
    rows: [
      [viewButton("back", "返回规则", "rules", "view", targetGroupId)],
    ],
  });
  return { ok: false, text: card.text, rich: card };
}

/**
 * `/rules all`：全局默认规则卡（仅超级管理员）。
 *
 * 与群规则**同一套子卡结构**，目标 `DEFAULT_GROUP_ID`；正文标明「只影响未覆盖的群」，
 * 底部是「覆盖率总览」（列出 `listOverrideSummaries()`）+ 刷新 + 规则帮助。
 */
export function globalRulesCard(
  ctx: AdminCommandContext,
  userId: string, page = 1): CardResult {
  if (!ctx.permissions.isSuperAdmin(userId)) {
    const card = renderCard({
      title: "权限不足",
      lines: [GLOBAL_RULES_DENIED],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const rows: CardButton[][] = [
    [
      viewButton("panel-toggle", "开关设置", "rules", "panel", DEFAULT_GROUP_ID, "toggle"),
      viewButton("panel-decision", "入群审核", "rules", "panel", DEFAULT_GROUP_ID, "decision"),
      viewButton("panel-punish", "违规处理", "rules", "panel", DEFAULT_GROUP_ID, "punish"),
    ],
    [
      viewButton("panel-keywords", "关键词", "rules", "panel", DEFAULT_GROUP_ID, "keyword"),
      viewButton("panel-roster", "名单筛选", "rules", "panel", DEFAULT_GROUP_ID, "roster"),
      viewButton("panel-more", "更多设置", "rules", "panel", DEFAULT_GROUP_ID, "more"),
    ],
    [
      viewButton("overrides", "覆盖率总览", "rules", "overrides", "1"),
      viewButton("refresh", "刷新", "rules", "all"),
      viewButton("help", "规则帮助", "help", "topic", "rules"),
    ],
  ];
  return cardFromText("全局规则（默认）", formatGlobalRules(ctx), {
    rows,
    footer: [
      "只影响未单独覆盖该字段的群；单个群可用「恢复本页继承」回落到这里。",
      "手输：/rules set all <字段> <值>",
    ],
  });
}

/**
 * 回调：全局规则覆盖率总览（`cb:rules:overrides:<页>`）。
 *
 * 每页 5 个群（§卡片规范 v2），列出该群显式覆盖的字段；没有覆盖的显示「全部继承全局」。
 */
export function ruleOverridesCard(
  ctx: AdminCommandContext,
  userId: string, page = 1): CardResult {
  if (!ctx.permissions.isSuperAdmin(userId)) {
    const card = renderCard({
      title: "权限不足",
      lines: [GLOBAL_RULES_DENIED],
      rows: [[viewButton("help", "指令帮助", "help", "home")]],
    });
    return { ok: false, text: card.text, rich: card };
  }
  const summaries = ctx.configStore.listOverrideSummaries();
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(summaries.length / pageSize));
  const current = Math.min(Math.max(page, 1), pageCount);
  const slice = summaries.slice((current - 1) * pageSize, current * pageSize);
  const lines: string[] = [
    "全局默认规则只影响**未覆盖**的群；下面是各群的字段级覆盖情况。",
    `共 ${summaries.length} 个群有覆盖 · 第 ${current} / ${pageCount} 页`,
    "",
  ];
  if (slice.length === 0) {
    lines.push("目前没有任何群覆盖全局规则（全部继承全局）。");
  }
  for (const summary of slice) {
    lines.push(
      `**${ctx.helpers.displayGroup(summary.groupId)}**：${summary.fields.length} 个字段（${summary.fields
        .map((field) => ruleFieldShortLabel(field))
        .join("、")}）`,
    );
  }
  const rows: CardButton[][] = [];
  const paging: CardButton[] = [];
  if (current > 1) {
    paging.push(viewButton("prev", "上一页", "rules", "overrides", current - 1));
  }
  if (current < pageCount) {
    paging.push(viewButton("next", "下一页", "rules", "overrides", current + 1));
  }
  rows.push(
    paging.length > 0
      ? paging
      : [viewButton("overrides", "刷新总览", "rules", "overrides", current)],
  );
  rows.push([
    viewButton("back-global", "返回全局规则", "rules", "all"),
    viewButton("help", "规则帮助", "help", "topic", "rules"),
  ]);
  const footer = [`全局：${formatGlobalRules(ctx).split("\n")[0] ?? ""}`];
  return cardFromText("规则覆盖率总览", lines.join("\n"), {
    rows,
    footer,
  });
}

export async function handleRules(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const action = normalize(parts[1]);
  if (action === "set" || action === "设置") {
    return handleRulesSet(ctx, groupId, userId, parts);
  }
  if (action === "add" || action === "新增" || action === "加") {
    const peek = resolveRuleTarget(ctx, groupId, parts);
    if (peek.ok && listFieldOf(peek.field) !== undefined) {
      return handleRulesListAdd(ctx, groupId, userId, parts);
    }
    return handleRulesKeywordAdd(ctx, groupId, userId, parts);
  }
  if (action === "del" || action === "delete" || action === "删除") {
    const peek = resolveRuleTarget(ctx, groupId, parts);
    if (peek.ok && listFieldOf(peek.field) !== undefined) {
      return handleRulesListDelete(ctx, groupId, userId, parts);
    }
    return handleRulesKeywordDelete(ctx, groupId, userId, parts);
  }
  if (action === "overrides" || action === "覆盖") {
    const { page } = extractPageToken(parts.slice(1));
    return ruleOverridesCard(ctx, userId, page);
  }
  if (action === "keyword" || action === "keywords" || action === "关键词") {
    const args = parts.slice(2);
    let targetGroupId = groupId;
    let rest = args;
    // 私信里允许 `<群号|#群短码>` 前缀；纯页码（如 `+2`）不算群参数
    if (!targetGroupId && args[0] !== undefined && !/^\+?\d+$/u.test(args[0])) {
      targetGroupId = ctx.helpers.resolveTargetGroupId(undefined, args[0]);
      if (!targetGroupId) {
        return {
          ok: false,
          text: "私信中需要提供已绑定的群号或 #群短码：/rules keyword <群号|#群短码> +页码",
        };
      }
      rest = args.slice(1);
    }
    if (!targetGroupId) {
      return rulesCard(ctx, groupId, userId, parts);
    }
    // extractPageToken 会跳过一个「动作名」占位元素，这里补上 action 本身
    const { page } = extractPageToken(["keyword", ...rest]);
    return rulesPanelCard(ctx, "keyword", targetGroupId, userId, undefined, page);
  }
  return rulesCard(ctx, groupId, userId, parts);
}

/**
 * `/rules add keyword <词>`：逐条追加关键词（权限同 `/rules set`）。
 *
 * 去重、trim、单条 ≤ {@link RULE_KEYWORD_MAX_LENGTH} 字；目标群解析与 `/rules set` 一致。
 */
export async function handleRulesKeywordAdd(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const target = resolveRuleTarget(ctx, groupId, parts);
  if (!target.ok) {
    return { ok: false, text: target.text };
  }
  if (!ctx.permissions.canManageRules(userId, target.groupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  const { field, value } = target;
  if (field !== "keyword" && field !== "keywords" && field !== "关键词") {
    return { ok: false, text: RULES_ADD_USAGE };
  }
  const keyword = value.trim();
  if (keyword.length === 0) {
    return { ok: false, text: RULES_ADD_USAGE };
  }
  if (keyword.length > RULE_KEYWORD_MAX_LENGTH) {
    return {
      ok: false,
      text: `关键词单条不能超过 ${RULE_KEYWORD_MAX_LENGTH} 个字符。`,
    };
  }
  const config = ctx.configStore.get(target.groupId);
  if (config.keywords.includes(keyword)) {
    return {
      ok: false,
      text: `关键词已存在：${keyword}`,
    };
  }
  const next = [...config.keywords, keyword];
  ctx.configStore.setOverride({ groupId: target.groupId, keywords: next });
  log.info("rule keyword added", { targetGroupId: target.groupId, keyword, userId });
  const base =
    target.groupId === DEFAULT_GROUP_ID
      ? "已更新全局规则"
      : "已更新群规则";
  return {
    ok: true,
    text: `${base}。\n\n${formatRules(ctx, target.groupId)}`,
  };
}

/**
 * `/rules del keyword <词>`：逐条删除关键词（权限同 `/rules set`）。
 *
 * 不存在时明确报错，不静默成功。
 */
export async function handleRulesKeywordDelete(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const target = resolveRuleTarget(ctx, groupId, parts);
  if (!target.ok) {
    return { ok: false, text: target.text };
  }
  if (!ctx.permissions.canManageRules(userId, target.groupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  const { field, value } = target;
  if (field !== "keyword" && field !== "keywords" && field !== "关键词") {
    return { ok: false, text: RULES_DEL_USAGE };
  }
  const keyword = value.trim();
  if (keyword.length === 0) {
    return { ok: false, text: RULES_DEL_USAGE };
  }
  const config = ctx.configStore.get(target.groupId);
  if (!config.keywords.includes(keyword)) {
    return { ok: false, text: `关键词不存在：${keyword}` };
  }
  const next = config.keywords.filter((item) => item !== keyword);
  ctx.configStore.setOverride({ groupId: target.groupId, keywords: next });
  log.info("rule keyword deleted", {
    targetGroupId: target.groupId,
    keyword,
    userId,
  });
  const base =
    target.groupId === DEFAULT_GROUP_ID
      ? "已更新全局规则"
      : "已更新群规则";
  return {
    ok: true,
    text: `${base}。\n\n${formatRules(ctx, target.groupId)}`,
  };
}

/**
 * `/rules add|del keyword` 的目标解析：与 `/rules set` 相同的「群内 / 私信带群号 / all」规则。
 *
 * 私信：`/rules add <群号|#群短码> keyword <词>`；
 * 全局：`/rules add all keyword <词>`。
 */
export function resolveRuleTarget(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  parts: readonly string[],
): { ok: true; groupId: string; field: string; value: string } | { ok: false; text: string } {
  const args = parts.slice(2);
  if (isGlobalTarget(args[0])) {
    return { ok: true, groupId: DEFAULT_GROUP_ID, field: args[1] ?? "", value: args.slice(2).join(" ") };
  }
  if (groupId) {
    return { ok: true, groupId, field: args[0] ?? "", value: args.slice(1).join(" ") };
  }
  const targetGroupId = ctx.helpers.resolveTargetGroupId(undefined, args[0]);
  if (!targetGroupId) {
    return {
      ok: false,
      text: "私信中需要提供已绑定的群号或 #群短码：/rules add <群号|#群短码> keyword <词>",
    };
  }
  return {
    ok: true,
    groupId: targetGroupId,
    field: args[1] ?? "",
    value: args.slice(2).join(" "),
  };
}

/** 全局规则：仅超级管理员可查看。 */
/** §B1 列表字段（正则 / 白名单）的字段名归一化。 */
const RULE_LIST_FIELDS: Record<string, "regexRules" | "userWhitelist"> = {
  regex: "regexRules",
  regexrules: "regexRules",
  正则: "regexRules",
  正则规则: "regexRules",
  whitelist: "userWhitelist",
  userwhitelist: "userWhitelist",
  白名单: "userWhitelist",
  用户白名单: "userWhitelist",
};

function listFieldOf(field: string): "regexRules" | "userWhitelist" | undefined {
  return RULE_LIST_FIELDS[normalize(field)];
}

/** `/rules add regex|whitelist`：逐条追加（权限与目标群解析同 `/rules set`）。 */
export async function handleRulesListAdd(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const target = resolveRuleTarget(ctx, groupId, parts);
  if (!target.ok) {
    return { ok: false, text: target.text };
  }
  if (!ctx.permissions.canManageRules(userId, target.groupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  const field = listFieldOf(target.field);
  const raw = target.value.trim();
  if (!field || raw.length === 0) {
    return { ok: false, text: RULES_ADD_USAGE };
  }
  const config = ctx.configStore.get(target.groupId);
  const current = [...config[field]];
  if (current.length >= RULE_LIST_MAX_COUNT) {
    return {
      ok: false,
      text: `${ruleFieldLabel(field)}最多 ${RULE_LIST_MAX_COUNT} 条。`,
    };
  }
  let entry = raw;
  if (field === "regexRules") {
    if (raw.length > RULE_REGEX_MAX_LENGTH) {
      return {
        ok: false,
        text: `单条正则不能超过 ${RULE_REGEX_MAX_LENGTH} 个字符。`,
      };
    }
    try {
      requireValidRegex(raw, "内容审核正则");
    } catch (error) {
      return { ok: false, text: `正则不合法：${formatError(error)}` };
    }
  } else {
    const resolved = resolveUserId(ctx, raw);
    if (!resolved) {
      return { ok: false, text: "请提供 QQ号 / #用户短码 / userId。" };
    }
    entry = resolved;
  }
  if (current.includes(entry)) {
    return { ok: false, text: `${ruleFieldLabel(field)}已存在：${entry}` };
  }
  const patch: GroupConfigOverride =
    field === "regexRules"
      ? { groupId: target.groupId, regexRules: [...current, entry] }
      : { groupId: target.groupId, userWhitelist: [...current, entry] };
  ctx.configStore.setOverride(patch);
  log.info("rule list entry added", { targetGroupId: target.groupId, field, entry, userId });
  return {
    ok: true,
    text: `已添加${ruleFieldLabel(field)}：${entry}\n\n${formatRules(ctx, target.groupId)}`,
  };
}

/** `/rules del regex|whitelist`：正则支持按序号或内容删，白名单支持 QQ号 / 短码 / userId。 */
export async function handleRulesListDelete(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const target = resolveRuleTarget(ctx, groupId, parts);
  if (!target.ok) {
    return { ok: false, text: target.text };
  }
  if (!ctx.permissions.canManageRules(userId, target.groupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  const field = listFieldOf(target.field);
  const raw = target.value.trim();
  if (!field || raw.length === 0) {
    return { ok: false, text: RULES_DEL_USAGE };
  }
  const config = ctx.configStore.get(target.groupId);
  const current = [...config[field]];
  const entry =
    field === "userWhitelist" ? (resolveUserId(ctx, raw) ?? raw) : raw;
  let index = current.indexOf(entry);
  if (field === "regexRules" && index < 0) {
    const serial = Number.parseInt(raw, 10);
    if (Number.isInteger(serial) && serial >= 1 && serial <= current.length) {
      index = serial - 1;
    }
  }
  if (index < 0) {
    return { ok: false, text: `${ruleFieldLabel(field)}里没有：${raw}` };
  }
  const removed = current[index]!;
  const next = current.filter((_item, i) => i !== index);
  const patch: GroupConfigOverride =
    field === "regexRules"
      ? { groupId: target.groupId, regexRules: next }
      : { groupId: target.groupId, userWhitelist: next };
  ctx.configStore.setOverride(patch);
  log.info("rule list entry removed", { targetGroupId: target.groupId, field, removed, userId });
  return {
    ok: true,
    text: `已删除${ruleFieldLabel(field)}：${removed}\n\n${formatRules(ctx, target.groupId)}`,
  };
}

/** 回调：清空正则 / 白名单（`cb:rules:clearList:<群>:<字段>`）。 */
export function clearRuleListCard(
  ctx: AdminCommandContext,
  targetGroupId: string,
  rawField: string,
  userId: string,
  replyGroupId?: string,
): CardResult {
  if (!ctx.permissions.canManageRules(userId, targetGroupId)) {
    const card = cardFromText("群规则", "权限不足：需要群管理员或以上权限。");
    return { ok: false, text: card.text, rich: card.rich };
  }
  const field = listFieldOf(rawField);
  if (!field) {
    return cardFromText("群规则", "未知字段。");
  }
  const patch: GroupConfigOverride =
    field === "regexRules"
      ? { groupId: targetGroupId, regexRules: [] }
      : { groupId: targetGroupId, userWhitelist: [] };
  ctx.configStore.setOverride(patch);
  log.info("rule list cleared via callback", { targetGroupId, field, userId });
  return rulesRegexPanel(
    ctx,
    targetGroupId,
    userId,
    `${ctx.helpers.mention(replyGroupId, userId)}已清空${ruleFieldLabel(field)}。`,
  );
}

export function handleGlobalRulesView(
  ctx: AdminCommandContext,
  userId: string): CommandResult {
  if (!ctx.permissions.isSuperAdmin(userId)) {
    return { ok: false, text: GLOBAL_RULES_DENIED };
  }
  return { ok: true, text: formatGlobalRules(ctx) };
}

export async function handleRulesSet(
  ctx: AdminCommandContext,
  groupId: string | undefined,
  userId: string,
  parts: readonly string[],
): Promise<CommandResult> {
  const args = parts.slice(2);
  if (isGlobalTarget(args[0])) {
    return handleGlobalRulesSet(ctx, userId, args.slice(1));
  }

  const targetGroupId = groupId ?? ctx.helpers.resolveTargetGroupId(undefined, args[0]);
  const field = groupId ? args[0] : args[1];
  const valueParts = groupId ? args.slice(1) : args.slice(2);

  if (!targetGroupId) {
    return {
      ok: false,
      text: "私信中设置规则需要提供已绑定的群号或 #群短码。用法：/rules set <群号|#群短码> <字段> <值>",
    };
  }
  if (!ctx.permissions.canManageRules(userId, targetGroupId)) {
    return { ok: false, text: "权限不足：需要群管理员或以上权限。" };
  }
  if (!field || valueParts.length === 0) {
    return { ok: false, text: RULES_SET_USAGE };
  }

  const value = valueParts.join(" ").trim();
  let override: GroupConfigOverride;
  try {
    override = parseRuleSetting(targetGroupId, field, value, ctx.configStore);
  } catch (error) {
    return { ok: false, text: `设置失败：${formatError(error)}` };
  }

  ctx.configStore.setOverride(override);
  log.info("group rules updated", {
    groupId: targetGroupId,
    userId,
    field: normalize(field),
  });
  return {
    ok: true,
    text: `已更新群规则。\n\n${formatRules(ctx, targetGroupId)}`,
  };
}

/** 全局规则：仅超级管理员可修改。 */
export async function handleGlobalRulesSet(
  ctx: AdminCommandContext,
  userId: string,
  args: readonly string[],
): Promise<CommandResult> {
  if (!ctx.permissions.isSuperAdmin(userId)) {
    return { ok: false, text: GLOBAL_RULES_DENIED };
  }
  const field = args[0];
  const valueParts = args.slice(1);
  if (!field || valueParts.length === 0) {
    return { ok: false, text: GLOBAL_RULES_SET_USAGE };
  }

  const value = valueParts.join(" ").trim();
  let override: GroupConfigOverride;
  try {
    override = parseRuleSetting(DEFAULT_GROUP_ID, field, value, ctx.configStore);
  } catch (error) {
    return { ok: false, text: `设置失败：${formatError(error)}` };
  }

  ctx.configStore.setOverride(override);
  log.info("global rules updated", { userId, field: normalize(field) });
  return {
    ok: true,
    text: `已更新全局规则（影响所有未单独覆盖的群）。\n\n${formatGlobalRules(ctx)}`,
  };
}

export function formatRules(
  ctx: AdminCommandContext,
  targetGroupId: string): string {
  return formatEffectiveConfig(
    ctx.configStore.get(targetGroupId),
    `群 ${ctx.helpers.displayGroup(targetGroupId)} 规则配置：`,
  );
}

export function formatGlobalRules(
  ctx: AdminCommandContext,
  ): string {
  return formatEffectiveConfig(
    ctx.configStore.default,
    "全局默认规则（未单独配置的群继承）：",
  );
}
