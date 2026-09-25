import { PermissionLevel } from "../core/enums.js";
import type { EffectiveGroupConfig, GroupConfigStore } from "./groupConfig.js";
import type { IdentityMapService } from "./identityMap.js";
import type { PermissionService } from "./permissions.js";

export interface HelpContext {
  permissions: PermissionService;
  configStore: GroupConfigStore;
  identityMap: IdentityMapService | undefined;
  /** 当前会话所在群；私信为 undefined。 */
  groupId: string | undefined;
  userId: string;
}

export interface HelpTopic {
  /** 规范名，用于 `/help <name>` 与错误提示。 */
  name: string;
  aliases: readonly string[];
  title: string;
  /** 权限要求说明（用于提示与正文）。 */
  requirement: string;
  /** 当前用户是否可以查看该主题的详细帮助。 */
  allows: (context: HelpContext) => boolean;
  /** 主题正文。 */
  body: (context: HelpContext) => string[];
}

const MODERATOR_ONLY = "审核员或以上";
const GROUP_ADMIN_ONLY = "群管理员或以上";
const SUPER_ADMIN_ONLY = "仅全局超级管理员";

function isModerator(context: HelpContext): boolean {
  // 全局超管在私信里没有群上下文，也要能看到群级指令的帮助
  if (context.permissions.isSuperAdmin(context.userId)) {
    return true;
  }
  return context.groupId
    ? context.permissions.canReviewContent(context.userId, context.groupId)
    : context.permissions.hasAnyGroupRole(
        context.userId,
        PermissionLevel.Moderator,
      );
}

function isGroupAdmin(context: HelpContext): boolean {
  if (context.permissions.isSuperAdmin(context.userId)) {
    return true;
  }
  return context.groupId
    ? context.permissions.canApproveJoin(context.userId, context.groupId)
    : context.permissions.hasAnyGroupRole(
        context.userId,
        PermissionLevel.GroupAdmin,
      );
}

/** 群规则的「当前生效值」精简展示。 */
function configSummary(config: EffectiveGroupConfig): string[] {
  const keywords =
    config.keywords.length > 0 ? config.keywords.join("、") : "（未配置）";
  const keywordActions = [
    config.keywordRecall ? "撤回" : undefined,
    config.keywordPunish !== "none" ? config.keywordPunish : undefined,
  ].filter((item): item is string => item !== undefined);
  return [
    "当前生效值：",
    `  启用 ${config.enabled} · 关键词过滤 ${config.wordFilterEnabled} · 入群审核 ${config.joinAuditEnabled} · 自动通过 ${config.autoApproveJoin} · 导出 ${config.exportEnabled}`,
    `  关键词：${keywords}`,
    `  警告文案：${config.warningMessage}`,
    `  禁言时长：${config.muteDurationSeconds} 秒`,
    `  命中动作：${keywordActions.length > 0 ? `警告 + ${keywordActions.join(" + ")}` : "仅警告"}`,
    `  入群决策：${config.joinDecision} · 要求班级 ${config.joinRequireClass} · 要求姓名 ${config.joinRequireName} · 审核意见 ${config.joinReviewOpinion} · 自动处理也通知 ${config.notifyAutoApproved}`,
  ];
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    name: "help",
    aliases: ["帮助"],
    title: "查看指令帮助",
    requirement: "无",
    allows: () => true,
    body: () => [
      "用法：",
      "  /help                 查看你有权限执行的指令列表",
      "  /help <指令>          查看某个指令的详细用法（如 /help rules）",
      "",
      "可用主题（按你的权限显示）：",
      "  help menu profile alias activity bind myperm rules perm pending sync approve reject audit status test testmenu testat whois",
      "",
      "输出形式：",
      "  · 所有指令回复都是菜单式卡片（Markdown + 按钮），按钮不可用时自动降级为纯文本；",
      "  · 导航/查看/翻页按钮点击即出下一张卡；执行动作的按钮等于发送对应指令；",
      "  · 规范见 docs/CARD-STANDARD.md。",
    ],
  },
  {
    name: "menu",
    aliases: ["菜单"],
    title: "系统交互菜单",
    requirement: "无",
    allows: () => true,
    body: () => [
      "用法：",
      "  /menu           主菜单（按你的权限显示入口按钮）",
      "  /menu sys       系统菜单：帮助 / 绑定 / 我的权限 / 个人资料 / 活动",
      "  /menu admin     管理菜单：待审批 / 同步 / 规则 / 审计 / 状态 / 自检 / 通知订阅",
      "  /menu review    审核操作（群管理员及以上）",
      "  /menu ops       活动运营与导出（群管理员及以上）",
      "  /menu super     超管菜单（仅全局超级管理员：权限 / 全局规则 / 通知订阅 / 翻页测试）",
      "  /menu activity  活动列表（分页卡，可直接报名 / 看详情 / 看名单）",
      "",
      "说明：",
      "  · 菜单现在覆盖全部指令；导航按钮是**回调**：点击即出下一张卡片，不用再发消息；",
      "  · 无参数的固定动作（订阅开关、规则开关、同步、测试推送、通过审批等）也是回调，",
      "    点击即自动生效，返回的卡片会标明「操作人」；",
      "  · 需要参数的指令（如 /approve <申请ID>、/bind qq <QQ号>）在正文里给用法，不提供死按钮；",
      "  · 自定义按钮是官方内邀能力，未开通时会自动降级为纯文本；手动指令统一用 /help 查看；",
      "  · 群里 @机器人 不带内容、私信里第一次和机器人交互，都会收到主菜单。",
    ],
  },
  {
    name: "testmenu",
    aliases: ["翻页测试"],
    title: "回调按钮翻页试验",
    requirement: SUPER_ADMIN_ONLY,
    allows: (context) => context.permissions.isSuperAdmin(context.userId),
    body: () => [
      "用法：",
      "  /testmenu          从第 1 页开始",
      "  /testmenu <页码>   直接跳到某一页（1-3）",
      "",
      "说明：",
      "  · 卡片上的「上一页 / 下一页 / 返回第 1 页」是官方**回调按钮**（action.type=1）：",
      "    点击后官方推送 INTERACTION_CREATE，机器人回包后把目标页作为新消息发出去；",
      "  · 官方没有「更新原消息」的接口，所以翻页不是改写同一张卡，而是点击后直接来一张新的；",
      "  · 回调发送失败（或未开通互动事件）时，会自动改用主动发送，仍然能看到新的一页；",
      "  · 双通道兜底：正文与第二行按钮给出 /testmenu <页码>，可随时手输。",
    ],
  },
  {
    name: "testat",
    aliases: ["@测试", "atest"],
    title: "@ 渲染自检（仅全局超级管理员）",
    requirement: SUPER_ADMIN_ONLY,
    allows: (context) => context.permissions.isSuperAdmin(context.userId),
    body: () => [
      "用法（在**群里**执行）：",
      "  /testat           发 3 条测试消息：纯文本 @、Markdown 首行 @、Markdown 正文中间 @",
      "  /testat all       再多发 5 条 @全体候选写法（会打扰全群，谨慎）",
      "",
      "真机实测结论（本机群聊）：",
      "  · Markdown 卡片里的 `<@!openid>` **生效**（首行与正文中间都可以）→ 所有 @ 反馈都用卡片内 @；",
      "  · 纯文本 `content` 里的 `<@!openid>` 与 `@everyone` **都不生效**；",
      "  · 也就是说官方「内嵌格式只在 content 生效」的文档在群聊 Markdown 上不成立，以实测为准；",
      "  · **@全体成员做不到**：/testat all 穷举 5 种写法（markdown @everyone / <@!all> / <@!everyone> /",
      "    纯文字 / 纯文本 <@!all>）全部不生效；需要全群提醒时只能由管理员手动 @全体。",
    ],
  },
  {
    name: "bind",
    aliases: ["绑定"],
    title: "绑定 QQ号 / 群号",
    requirement: "无",
    allows: () => true,
    body: (context) => {
      const lines = [
        "作用：官方只提供 OpenID（形如 A1B2C3D4...），不能反推 QQ号，所以需要手工建立映射。",
        "除 /help、/bind 外，所有指令都要求先完成绑定。",
        "",
        "绑定自己的 QQ 号（所有用户）",
        "  /bind qq <QQ号>                     例如 /bind qq 123456789",
        "",
        "绑定当前群（群管理员或超管，需在群内执行）",
        "  /bind group <群号>                  例如 /bind group 654321",
        "",
        "超管专用",
        "  /bind user <userId> <QQ号>          绑定任意用户",
        "  /bind groupid <group_openid> <群号>  绑定任意群",
        "",
        "绑定后可直接用 QQ号/群号执行命令：",
        "  /perm grant mod 123456",
        "  /rules set 654321 autoApprove on",
        "  /status 654321",
        "",
        "说明：",
        "  · 一个 QQ号只能绑定一个 userId，重复绑定会顶掉旧映射",
        "  · 绑定关系持久化在数据库，重启不丢",
        "  · 展示规则：已绑定只显示 QQ号/群号；未绑定显示随机短码（如 #M7K2Q9），不暴露内部 id",
        "  · 查询映射：/whois <QQ号|userId|群号|group_openid|#短码>（超管，唯一能看到真实系统 id 的指令）",
      ];
      const qq = context.identityMap?.getQq(context.userId);
      lines.push(
        "",
        "你当前的绑定：",
        qq
          ? `  QQ ${qq}`
          : `  尚未绑定（当前识别为 ${context.userId}），请执行 /bind qq <QQ号>`,
      );
      if (context.groupId) {
        const groupNumber = context.identityMap?.getGroupNumber(context.groupId);
        lines.push(
          groupNumber
            ? `  本群：群号 ${groupNumber}`
            : `  本群：${context.groupId}（群管理员执行 /bind group <群号> 后可只显示群号）`,
        );
      }
      return lines;
    },
  },
  {
    name: "myperm",
    aliases: ["我的权限"],
    title: "查看自己的权限",
    requirement: "无",
    allows: () => true,
    body: (context) => {
      const lines = [
        "用法：",
        "  /myperm",
        "",
        "会显示你的权限等级、是否为全局/本群超级管理员，以及各项能力（审核入群、管理规则、内容审核、导出数据、配置权限）。",
        "",
        "权限等级从低到高：guest < member < moderator < group_admin < super_admin",
        "  · moderator    审核员：/pending /sync /audit /test /rules(只读) /status",
        "  · group_admin  群管理员：额外可 /approve /reject /rules set /bind group",
        "  · super_admin  超级管理员：全局超管拥有平台级能力；本群超管只在该群内生效",
      ];
      if (context.groupId) {
        lines.push(
          "",
          "你在此群的权限等级：",
          `  ${context.permissions.levelFor(context.userId, context.groupId)}`,
        );
      }
      return lines;
    },
  },
  {
    name: "profile",
    aliases: ["资料", "个人信息"],
    title: "个人资料（班级/学院/姓名/学号）",
    requirement: "无",
    allows: () => true,
    body: () => [
      "用法：",
      "  /profile                                 查看个人资料",
      "  /profile set <班级> <姓名> <11位学号>      智能识别：顺序随意、分隔符随意",
      "  /profile set name <姓名>                  姓名",
      "  /profile set id <11位学号>                学号（前两位必须是 22-26，决定年级）",
      "  /profile set class <班级>                 班级（必须在班级库里，自动带出学院）",
      "  /profile set college <学院>               学院（可手动覆盖）",
      "  /profile set year <年级>                  年级（可手动覆盖，**只写两位**，如 22）",
      "  /profile set <字段> clear                 清除单个字段",
      "  /profile clear                            清空整份资料",
      "",
      "智能识别（一条消息填完）：",
      "  /profile set 材化2211 张三 22123456789",
      "  /profile set 张三-22123456789-材化2211",
      "  /profile set 22123456789+材化2211+张三",
      "  /profile set 材化2211张三22123456789     ← 完全不带分隔符也能识别",
      "  /profile set 班级=材化2211 姓名=张三 学号=22123456789",
      "",
      "说明：",
      "  · 识别规则：11 位数字=学号；能在班级库匹配到的班级名=班级；剩余 2-4 个汉字=姓名；",
      "    也支持手填学院（学院名能在班级库里匹配到）与「年级=23」",
      "  · 识别到多个班级/姓名，或存在认不出的内容时**不会写入**，会列出识别结果并提示改用 字段=值",
      "  · 学号必须是 11 位数字，例如 22123456789；前两位 22/23/24/25/26 对应年级",
      "  · 年级**只接受两位**（22），四位年份（2022）会被拒绝；班级库里的四位年份会自动转成两位",
      "  · 班级必须在 data/class-index.json 的 classes 里，学院会从班级库自动带出",
      "  · 报名活动前要求「姓名 + 学号 + 班级」齐全",
      "  · 资料持久化在 user_profiles 表，重启不丢",
    ],
  },
  {
    name: "alias",
    aliases: ["别名"],
    title: "班级/学院/专业别名表（仅全局超级管理员）",
    requirement: SUPER_ADMIN_ONLY,
    allows: (context) => context.permissions.isSuperAdmin(context.userId),
    body: () => [
      "用法：",
      "  /alias                            查看别名表",
      "  /alias set <别名> <规范名>         新增/覆盖（类型自动判定）",
      "  /alias del <别名>                 删除",
      "",
      "示例：",
      "  /alias set 环工2214 环境类2214",
      "  /alias set 化生学院 化学与生命科学学院",
      "",
      "说明：",
      "  · 规范名必须来自 data/class-index.json（必须是班级 / 学院 / 专业之一）",
      "  · 别名会用于 /profile set 的智能识别，以及入群审核的「班级+姓名」匹配",
      "  · 匹配忽略空白差异、长别名优先；全局生效，持久化在 class_aliases 表，重启不丢",
    ],
  },
  {
    name: "activity",
    aliases: ["活动"],
    title: "活动发布 / 报名 / 管理",
    requirement: "报名：无；发布与管理：群管理员或以上",
    allows: () => true,
    body: () => [
      "用法：",
      "  /activity                                查看本群活动列表",
      "  /activity list <群号|#群短码>             查看指定群活动",
      "  /activity create <标题>                   创建活动（群管理员+；私信需先写群号）",
      "  /activity set <#活动短码> <字段> <值>       配置活动",
      "  /activity open <#活动短码>                 开放报名并把卡片发到群里",
      "  /activity close <#活动短码>                关闭报名",
      "  /activity cancel <#活动短码>               取消活动",
      "  /activity join <#活动短码> [备注]           报名",
      "  /activity quit <#活动短码>                 取消报名",
      "  /activity info <#活动短码>                 活动详情",
      "  /activity signups <#活动短码>              报名名单（群管理员/发布者）",
      "",
      "可配置字段（/activity set）：",
      "  title 标题 · desc 简介 · capacity 名额 · group 活动群号",
      "  link <url> 或 link <说明=url>（可多次追加，卡片里显示为链接）",
      "  allowColleges / denyColleges 学院白名单 / 黑名单",
      "  allowYears / denyYears 年级白名单 / 黑名单（22/23/…，用学号前两位判断）",
      "",
      "说明：",
      "  · 卡片是 Markdown + 「报名 / 取消报名 / 详情 / 名单」指令按钮，未开通按钮会降级为纯文本",
      "  · 报名要求 /profile 完整；黑名单优先，白名单为空表示不限",
      "  · 活动与报名记录持久化，重启不丢",
    ],
  },
  {
    name: "rules",
    aliases: ["规则"],
    title: "群规则配置",
    requirement: `审核员或以上（查看）／${GROUP_ADMIN_ONLY}（修改）`,
    allows: isModerator,
    body: (context) => {
      const lines = [
        "群规则分两层：本群规则（优先）与全局默认规则（未单独配置的群继承）。",
        "所有字段按「字段」合并：某群只覆盖了关键词，仍继承全局的其他字段。",
        "",
        `查看（${MODERATOR_ONLY}）`,
        "  /rules                              查看本群规则",
        "  /rules <#群短码|群号|group_openid>           私信中查看指定群",
        "  /rules all                          查看全局默认规则（仅超管）",
        "",
        `修改本群规则（${GROUP_ADMIN_ONLY}）`,
        "  /rules set keywords 广告,刷屏,加群     设置关键词（逗号/顿号/空格分隔）",
        "  /rules set keywords clear           清空关键词",
        "  /rules set warning 请勿发广告。       命中后发送的文案",
        "  /rules set warning clear            恢复默认文案",
        "  /rules set wordFilter on|off        关键词过滤总开关",
        "  /rules set joinAudit on|off         入群审核开关（自动决策的总开关）",
        "  /rules set autoApprove on|off       新入群申请全部自动通过（等价 joinDecision auto_approve）",
        "  /rules set muteDuration 600         禁言时长（秒，上限 2592000）",
        "  /rules set export on|off            导出开关（当前仅存储展示）",
        "  /rules set enabled on|off           本群机器人总开关",
        "",
        "关键词处罚（命中后除了警告之外的额外动作）：",
        "  /rules set keywordRecall on|off     是否撤回命中消息",
        "  /rules set keywordPunish none|mute|kick|kick_blacklist",
        "      none=只警告  mute=禁言(muteDuration)  kick=移出  kick_blacklist=移出并拉黑",
        "",
        "入群审核规则（班级库由 pnpm class:index 生成）：",
        "  /rules set joinDecision manual|auto_approve|approve_on_match|reject_on_match|reject_on_mismatch",
        "      自动通过 / 命中规则通过 / 命中规则拒绝 / 未命中拒绝 / 全部人工",
        "  /rules set joinRequireClass on|off  答案必须包含班级库中的班级",
        "  /rules set joinRequireName on|off   答案必须包含姓名",
        "  /rules set joinAnswerPattern <正则> 额外正则要求（clear 清空）",
        "  /rules set joinReviewOpinion on|off 人工审核时在 /pending 显示审核意见",
        "  /rules set notifyAutoApproved on|off 机器人自动通过/拒绝的申请是否也推送通知",
        "",
        "私信中修改指定群：",
        "  /rules set <#群短码|群号|group_openid> <字段> <值>",
        "",
        `修改全局默认规则（${SUPER_ADMIN_ONLY}）`,
        "  /rules set all <字段> <值>           别名 all / global / default / 全局 / 默认",
        "",
        "注意事项：",
        "  · 关键词命中后先发送该群警告文案并写入审计（用 /audit 查看），再用 keywordRecall / keywordPunish 追加撤回与处罚",
        "  · 撤回/禁言/移出等动作尽力而为：单个失败不影响其他动作，失败详情见日志（带 _failed 后缀），全部失败时 /audit 状态为 pending",
        "  · 每次 set 只更新指定字段，不会重置其他字段",
        "  · 关键词会去重、去空白并按字典序保存",
        "  · 修改立即生效，不需要重启机器人",
      ];
      if (context.groupId) {
        lines.push("", ...configSummary(context.configStore.get(context.groupId)));
      } else {
        lines.push("", "提示：在群内执行 /help rules 可看到该群的当前生效值。");
      }
      return lines;
    },
  },
  {
    name: "perm",
    aliases: ["权限"],
    title: "权限配置",
    requirement: SUPER_ADMIN_ONLY,
    allows: (context) => context.permissions.isSuperAdmin(context.userId),
    body: () => [
      "权限分两层，全部为手工配置（不根据 QQ 群主/管理员身份自动授予）。",
      "",
      "查看：",
      "  /perm list [#群短码|群号]",
      "",
      "全局超级管理员（平台级能力）：",
      "  /perm grant super <userId|QQ号>",
      "  /perm revoke super <userId|QQ号>",
      "",
      "本群超级管理员（只在该群内是最高权限）：",
      "  /perm grant gsuper [#群短码|群号] <userId|QQ号>",
      "  /perm revoke gsuper [#群短码|群号] <userId|QQ号>",
      "  别名：gsuper / groupsuper / 群超管 / 本群超管 / 群超级管理员",
      "",
      "群管理员 / 审核员：",
      "  /perm grant|revoke admin [#群短码|群号] <userId|QQ号>",
      "  /perm grant|revoke mod [#群短码|群号] <userId|QQ号>",
      "",
      "说明：",
      "  · 参数可以用 QQ号（需对方已绑定）或直接写 userId",
      "  · 本群超管拿不到 /perm、/rules all、/bind user|groupid、/whois 等平台级能力",
      "  · 不能撤销最后一个全局超级管理员",
    ],
  },
  {
    name: "whois",
    aliases: ["查询"],
    title: "查询 OpenID ↔ QQ号 / 群号 映射",
    requirement: SUPER_ADMIN_ONLY,
    allows: (context) => context.permissions.isSuperAdmin(context.userId),
    body: () => [
      "用法：",
      "  /whois                              不带参数：群聊查当前群，私聊查你自己",
      "  /whois <QQ号|userId|群号|group_openid|#短码>",
      "  /whois profile <QQ号|userId|#短码>   查个人资料（姓名/学号/班级/学院/年级）",
      "",
      "示例：",
      "  /whois                  → 当前群 / 你自己的映射（含短码）",
      "  /whois 123456789        → 返回对应的 userId",
      "  /whois A1B2C3D4...      → 返回对应的 QQ号",
      "  /whois 654321           → 返回对应的 group_openid",
      "",
      "说明：",
      "  · 查入群申请短码时会给完整详情：群、申请人、理由、状态、申请/处理时间与处理人；",
      "  · 过期的申请仍可用 /whois 追溯（只是不再出现在 /pending 里）；",
      "  · /whois profile 查的是「QQ ↔ 个人资料」的关系：userId、QQ号、短码 + 姓名/学号/班级/学院/年级，",
      "    仅超级管理员可用（资料属个人信息，不开放给群管理员）。",
    ],
  },
  {
    name: "pending",
    aliases: ["待审批"],
    title: "查看待审批入群申请",
    requirement: MODERATOR_ONLY,
    allows: isModerator,
    body: () => [
      "用法：",
      "  /pending                            群内查看本群待审批",
      "  /pending <#群短码|群号|group_openid>         私信中查看指定群",
      "  /pending +2                         翻到第 2 页（+页码 是通用分页写法）",
      "",
      "示例：",
      "  /pending",
      "  /pending 654321",
      "  /pending 654321 +2",
      "",
      "输出为菜单式卡片：每页 3 条，每条带「通过 / 拒绝」按钮（点击=发送 /approve、/reject，",
      "权限与手输完全一致），翻页用「上一页 / 下一页」按钮；按钮不可用时用 `+页码` 手动翻页。",
      "卡片会列出申请短码（形如 #M7K2Q9）、申请人展示名与入群理由；审批用 /approve、/reject。",
      "所有用户可见输出只显示短码/QQ号/群号，不暴露内部系统 id；/whois #短码 可由超管还原真实 id。",
      "开通 /notify 后，新申请会自动私聊推送给审核员（带快捷按钮）。",
      "申请有有效期（默认 7 天，可由超管用 JOIN_REQUEST_TTL_DAYS 调整）：过期或被官方列表对账判定",
      "散失的申请会自动标记为 expired，不再出现在待审批里；/audit 与 /whois 仍可追溯。",
    ],
  },
  {
    name: "sync",
    aliases: ["同步"],
    title: "从官方同步待审批申请",
    requirement: MODERATOR_ONLY,
    allows: isModerator,
    body: () => [
      "作用：机器人离线期间或事件丢失时，本地待审批队列可能缺数据，用该指令从官方补齐。",
      "",
      "用法：",
      "  /sync                               群内同步本群",
      "  /sync <#群短码|群号|group_openid>            私信中同步指定群",
      "",
      "说明：",
      "  · 同一群 30 秒内只能同步一次，重复执行会提示冷却剩余秒数",
      "  · 已同步过的申请不会重复写入",
    ],
  },
  {
    name: "approve",
    aliases: ["通过"],
    title: "通过入群申请",
    requirement: GROUP_ADMIN_ONLY,
    allows: isGroupAdmin,
    body: () => [
      "用法：",
      "  /approve <#申请短码>                             群内审批本群",
      "  /approve <#群短码|群号|group_openid> <#申请短码>          私信中审批指定群",
      "",
      "示例：",
      "  /approve AURi8Rr6MfGdUNedupWf2uV5XiayURHaetzwGyOdrj6mHYOsfJFkbe9u8...",
      "",
      "说明：",
      "  · 会先调用官方审批接口，成功后才更新本地状态；接口失败时申请保持待审批并返回错误",
      "  · 申请短码用 /pending 或 /sync 获取（也可以直接传完整申请 id）",
    ],
  },
  {
    name: "reject",
    aliases: ["拒绝"],
    title: "拒绝入群申请",
    requirement: GROUP_ADMIN_ONLY,
    allows: isGroupAdmin,
    body: () => [
      "用法：",
      "  /reject <#申请短码> [原因]                        群内审批本群",
      "  /reject <#群短码|群号|group_openid> <#申请短码> [原因]     私信中审批指定群",
      "",
      "示例：",
      "  /reject AURi8Rr6MfGdUNedupWf2uV5XiayURHaetzw... 资料不完整",
      "",
      "说明：",
      "  · 原因会随官方接口一起提交，并记入审计日志（/audit 可查）",
      "  · 同样遵循「先官方、后本地」的顺序",
    ],
  },
  {
    name: "notify",
    aliases: ["push", "推送", "订阅"],
    title: "入群申请推送（卡片 + 快捷按钮）",
    requirement: GROUP_ADMIN_ONLY,
    allows: isGroupAdmin,
    body: () => [
      "用法：",
      "  /notify                              查看当前推送订阅",
      "  /notify on|off                       群内=本群；私信=你担任群管理员的全部群",
      "  /notify all on|off                   全部群（群内/私信均可）",
      "  /notify <#群短码|群号|group_openid> on|off    指定群",
      "  /notify test                         给自己发一张推送测试卡片",
      "",
      "卡片操作：",
      "  · 「本群 / 全部群 开|关」是回调按钮：点击即订阅/退订并自动回一张带操作人的卡；",
      "  · 「测试推送」也是回调，点击即给自己发一张测试卡片；",
      "  · 手动等价指令：/notify on|off · /notify all on|off · /notify <群号> on|off · /notify test",
      "",
      "推送内容：",
      "  · 有新的待审批申请时，用 Markdown 卡片私聊推送，底部是「同意 / 拒绝」按钮",
      "  · 点击按钮等于发送 /approve、/reject 指令，会先弹出二次确认",
      "  · 第二行是预设拒绝原因（红色按钮），一键把回复作为拒绝理由提交给申请人：",
      "      「拒绝：回答错误」→ 请正确回答问题。",
      "      「拒绝：班级姓名」→ 请回答正确的班级姓名（如：环工2214小明）。",
      "  · 卡片正文含群号、申请人、回答、申请 ID 与审核意见（不再堆完整指令）",
      "  · 所有用户可见输出只显示绑定的群号/QQ号，未绑定时才显示内部 openid（/whois 例外，它本身就是映射查询）",
      "  · 只推送仍需人工处理的申请；自动通过/拒绝的不会打扰",
      "",
      "说明：",
      "  · 只有在该群能审批（群管理员或以上）的人才会收到；越权订阅无效",
      "  · 订阅保存在数据库，重启不丢",
      "  · 同一申请对同一个人只推送一次（重启后也不会重复）",
      "  · 自定义按钮是官方内邀能力：未开通时自动降级为纯 Markdown / 纯文本，仍可用指令审批",
      "  · 主动消息需要机器人有主动消息额度，且用户未在 QQ 客户端关闭「允许主动发送」",
    ],
  },
  {
    name: "audit",
    aliases: ["日志"],
    title: "查看审计记录",
    requirement: MODERATOR_ONLY,
    allows: isModerator,
    body: () => [
      "用法：",
      "  /audit [数量]                          群内查看本群，默认每页 10 条，最多 50 条",
      "  /audit <#群短码|群号|group_openid> [数量]       私信中查看指定群",
      "  /audit +2                             翻到第 2 页（+页码 是通用分页写法）",
      "",
      "示例：",
      "  /audit",
      "  /audit 20",
      "  /audit 20 +2",
      "",
      "输出为菜单式卡片：底部有「上一页 / 下一页 / 刷新」按钮（点击即翻页），",
      "按钮不可用时用 `+页码` 手动翻页。",
      "记录内容包括时间、动作、状态、操作人和目标用户，例如：",
      "  approve_join_request / reject_join_request / moderation:warn / export_*",
    ],
  },
  {
    name: "status",
    aliases: ["状态"],
    title: "查看群运行状态",
    requirement: MODERATOR_ONLY,
    allows: isModerator,
    body: () => [
      "用法：",
      "  /status                                群内查看本群",
      "  /status <#群短码|群号|group_openid>             私信中查看指定群",
      "",
      "会显示：群号、机器人启用、消息过滤、全量消息模式（all/at_only/unknown）、",
      "入群审核、导出功能、禁言时长。",
      "",
      "其中「全量消息模式」用于判断群是否开启了「接收所有消息」：",
      "  all      = 已开启，可识别非 @ 的 / 指令",
      "  at_only  = 未开启，只接收 @ 消息",
      "  unknown  = 还没收到开启/关闭事件",
    ],
  },
  {
    name: "test",
    aliases: ["测试"],
    title: "机器人自检",
    requirement: MODERATOR_ONLY,
    allows: isModerator,
    body: () => [
      "用法：",
      "  /test",
      "",
      "返回当前会话的群 / 用户（已绑定则显示群号/QQ号）与待审批申请数量，用于确认机器人能收到消息并回复。",
    ],
  },
];

/** 用规范名或别名查找帮助主题；输入可带前导 `/`。 */
export function findHelpTopic(input: string | undefined): HelpTopic | undefined {
  const normalized = (input ?? "").replace(/^\//u, "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return HELP_TOPICS.find(
    (topic) =>
      topic.name === normalized ||
      topic.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}
