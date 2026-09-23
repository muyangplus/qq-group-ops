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
  return context.groupId
    ? context.permissions.canReviewContent(context.userId, context.groupId)
    : context.permissions.hasAnyGroupRole(
        context.userId,
        PermissionLevel.Moderator,
      );
}

function isGroupAdmin(context: HelpContext): boolean {
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
    `  入群决策：${config.joinDecision} · 要求班级 ${config.joinRequireClass} · 要求姓名 ${config.joinRequireName} · 审核意见 ${config.joinReviewOpinion}`,
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
      "  help bind myperm rules perm pending sync approve reject audit status test whois",
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
        "  · 查询映射：/whois <QQ号|userId|群号|group_openid>（超管）",
      ];
      const qq = context.identityMap?.getQq(context.userId);
      lines.push(
        "",
        "你当前的绑定：",
        qq
          ? `  userId ${context.userId} ↔ QQ ${qq}`
          : "  尚未绑定，请执行 /bind qq <QQ号>",
      );
      if (context.groupId) {
        const groupNumber = context.identityMap?.getGroupNumber(context.groupId);
        lines.push(
          groupNumber
            ? `  本群 ${context.groupId} ↔ 群号 ${groupNumber}`
            : `  本群 ${context.groupId} 尚未绑定群号（群管理员执行 /bind group <群号>）`,
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
        "  /rules <group_openid|群号>           私信中查看指定群",
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
        "",
        "私信中修改指定群：",
        "  /rules set <group_openid|群号> <字段> <值>",
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
      "  /perm list [group_openid|群号]",
      "",
      "全局超级管理员（平台级能力）：",
      "  /perm grant super <userId|QQ号>",
      "  /perm revoke super <userId|QQ号>",
      "",
      "本群超级管理员（只在该群内是最高权限）：",
      "  /perm grant gsuper [group_openid|群号] <userId|QQ号>",
      "  /perm revoke gsuper [group_openid|群号] <userId|QQ号>",
      "  别名：gsuper / groupsuper / 群超管 / 本群超管 / 群超级管理员",
      "",
      "群管理员 / 审核员：",
      "  /perm grant|revoke admin [group_openid|群号] <userId|QQ号>",
      "  /perm grant|revoke mod [group_openid|群号] <userId|QQ号>",
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
      "  /whois <QQ号|userId|群号|group_openid>",
      "",
      "示例：",
      "  /whois 123456789        → 返回对应的 userId",
      "  /whois A1B2C3D4...      → 返回对应的 QQ号",
      "  /whois 654321           → 返回对应的 group_openid",
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
      "  /pending <group_openid|群号>         私信中查看指定群",
      "",
      "示例：",
      "  /pending",
      "  /pending 654321",
      "",
      "输出会列出申请 ID、申请人 userId 和入群理由；审批用 /approve、/reject。",
      "开通 /notify 后，新申请会自动私聊推送给审核员（带快捷按钮）。",
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
      "  /sync <group_openid|群号>            私信中同步指定群",
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
      "  /approve <申请ID>                             群内审批本群",
      "  /approve <group_openid|群号> <申请ID>          私信中审批指定群",
      "",
      "示例：",
      "  /approve AURi8Rr6MfGdUNedupWf2uV5XiayURHaetzwGyOdrj6mHYOsfJFkbe9u8...",
      "",
      "说明：",
      "  · 会先调用官方审批接口，成功后才更新本地状态；接口失败时申请保持待审批并返回错误",
      "  · 申请 ID 用 /pending 或 /sync 获取",
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
      "  /reject <申请ID> [原因]                        群内审批本群",
      "  /reject <group_openid|群号> <申请ID> [原因]     私信中审批指定群",
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
      "  /notify <group_openid|群号> on|off    指定群",
      "  /notify test                         给自己发一张推送测试卡片",
      "",
      "推送内容：",
      "  · 有新的待审批申请时，用 Markdown 卡片私聊推送，底部是「同意 / 拒绝」按钮",
      "  · 点击按钮等于发送 /approve、/reject 指令，会先弹出二次确认",
      "  · 卡片会附带审核意见（识别到的班级/姓名、缺少项、建议）",
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
      "  /audit [数量]                          群内查看本群，默认 10 条，最多 50 条",
      "  /audit <group_openid|群号> [数量]       私信中查看指定群",
      "",
      "示例：",
      "  /audit",
      "  /audit 20",
      "",
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
      "  /status <group_openid|群号>             私信中查看指定群",
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
      "返回当前会话的群 ID / 用户 ID 与待审批申请数量，用于确认机器人能收到消息并回复。",
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
