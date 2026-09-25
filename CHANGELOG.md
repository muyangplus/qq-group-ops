# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本按 Git 提交时间线拆分：每个小版本对应一批「可独立发布」的改动，避免把长期积累的改动堆在一个 `Unreleased` 里。

## [Unreleased]

（暂无未发布改动）

## [0.1.9] - 2026-09-25

### 新增

- **规则菜单重构（`/rules`）**：从「只读子卡」升级为**字段级继承 + 卡片直改**。
  - 概览卡 + 子卡：概览正文标明「本群覆盖」了哪些字段（无覆盖写「全部继承全局」），入口为
    `开关设置` / `入群审核` / `违规处理` / `关键词` / `名单筛选` / `更多设置`，末行是
    `恢复全部继承`（二次确认）与（超管）`全局规则` / `规则帮助`。
  - **按钮显示当前状态**（`过滤 开` = 现在是开），点击即切换并回到同一张子卡；枚举用 `●` 标当前值；
    每张子卡正文逐条列 `字段：当前值（继承全局 / 本群覆盖）`，底部 `恢复本页继承` + `返回规则`。
  - **关键词逐条增删**：新增 `/rules add keyword <词>`、`/rules del keyword <词>`（权限同
    `canManageRules`；trim、去重、单条 ≤50 字）；关键词子卡每页 3 条、每条一个「删」回调，
    另有「加词」（指令按钮预填）与「清空」（二次确认）。
  - **学院 / 年级点选**：学院来自 `MemberRoster.listColleges()`（每页 4 个、`●` 标记、点击切换），
    年级用 `PROFILE_ENTRY_YEARS`（22–26）；白名单 / 黑名单同卡切换，落地为
    `allowColleges` / `denyColleges` / `allowYears` / `denyYears` 字段级覆盖。
  - **全局规则卡同构 + 覆盖率总览**：`/rules all` 用同一套子卡结构（目标 `DEFAULT_GROUP_ID`），
    正文标明「只影响未覆盖的群」；`覆盖率总览`（`/rules overrides [+页码]`）分页列出
    「群 + 覆盖字段数 / 字段名」。
  - **底层能力**（`src/services/groupConfig.ts`）：`overriddenFields(groupId)`、
    `clearFields(groupId, fields)`、`listOverrideSummaries()`；`clearFields` 只把 `group_configs`
    对应列置 `NULL`（仓储层新增 `clearColumns`）并删 `group_settings` 对应 KV 行，全局清字段回落种子默认。
  - **回调命名空间 `rules`** 新增 `resetPage`、`resetAll`、`delKeyword`、`clearKeyword`、
    `panelPage`、`rosterToggle`、`overrides`；每个 action 在 renderer 内重新做权限校验。
  - 保留 `/rules set <字段> <值>`（含 `all`）与 `/rules all` 的降级路径与权限。

### 变更

- `/help rules` 主题重写（含 add/del keyword、名单字段、恢复继承）；README / CONFIGURATION / ACCEPTANCE（J49–J56）同步。

### 已知限制

- 规则的 `allowColleges/denyColleges/allowYears/denyYears` 目前只做存储、继承与点选，**尚未接入
  `JoinRuleEvaluator`** 做入群白黑名单判定（`/help rules` 已注明「当前仅存储展示」）。
- 关键词子卡分页只有按钮，没有 `+页码` 文本降级；学院点选每页 4 个（受「每行 ≤12 字、整盘 ≤5 行」约束）。
- `/rules set rawMessageRetentionDays` 没有入口。

## [0.1.8] - 2026-09-25

### 新增

- **活动模块重构（配置卡 / 回调报名 / 候补 / 截止时间 / 订阅 / 统计 / 多群绑定）**
  - **三种视图 + 名单卡**（全部 `renderCard()`）：成员卡（`我要报名` / `取消报名`（回调 + modal 二次确认）、
    `活动详情`、`报名名单`（仅管理者可见）、`订阅 开/关`）；配置卡（`/activity create` 后自动返回：
    名额 `10/20/50/不限`、`学院限制` / `年级限制` 子卡、`截止`、`递补 自动/手动`、`报名通知 开/关`、
    `提醒@全体 开/关`、`预览卡片` / `开放报名` / `取消`）；管理卡（报名 X/Y、候补 N、**待释放名额 M**、
    学院/年级分布、`释放名额`（仅 `heldSlots>0`）、`重发卡片`、`开/关报名`、`取消活动`、`统计图片`）；
    名单卡（每页 10 人，**默认只显示序号/姓名/班级/备注**，`完整信息` 才含学号/学院，候补区单独列出）。
  - **回调命名空间 `activity`**（`cb:activity:<action>`）覆盖
    `join, quit, info, signups, page, config, manage, preview, open, cancel, release, resend, status, set, college, year, subscribe, stats, export`；
    每个 action 内部重新做权限校验（报名/取消/订阅 = 任意成员；配置/发布/关停/释放/名单/导出/统计 =
    `canManageActivity` 或超管），参数用活动短码。
  - **群内报名静默**：群里点回调或手输 `/activity join|quit` 都**不发任何群消息**，结果只私信本人
    （私信可含姓名/学号/序号/人数）；唯一例外是私信失败时群里回一条**不含结果**的提示。
    实现：`CommandResult.silent` → `EventRouter` 透传 → `gatewayRunner` 跳过群回复；
    回调 renderer 私信成功后返回 `undefined`。
  - **候补与名额**：新表 `activity_waitlist`（候补按报名顺序）；递补方式活动级配置
    `waitlistPromotion: auto|manual`（**默认 manual**）；手动模式取消报名时名额**冻结**
    （`heldSlots`），新人只能进候补，管理员「释放名额」→ 有候补则递补第一位、没有则放回公开池；
    `auto` 模式取消即递补。满员广播：某次报名恰好填满时，在**所有绑定群**发「活动已满 X/X」卡
    （含「后续报名自动进入候补队列（当前 N 人）」），**每群只发一次**（复用去重表，不占私信额度）。
  - **多群绑定**：新表 `activity_groups`；`ActivityService.bindGroup/unbindGroup/listBoundGroups`
    （`createActivity` 自动绑定创建群、`load()` 读回）；发布/重发改打**所有绑定群**，操作者回执列出
    逐群结果；新增 `/activity bind|unbind <#码> <群号|#群短码>` 与配置卡「绑定群」子卡。
  - **报名截止时间**：`closeAt` **懒校验**（到期即拒绝报名，不跑定时器），卡片显示 `MM-DD HH:mm`，
    过期显示「已截止」。
  - **订阅与通知**：新表 `activity_subscriptions`（按群订阅）、`activity_notifications`（去重 + 每人每日计数）；
    新服务 `src/services/activityNotifications.ts`（`subscribe/unsubscribe/listSubscribedGroups`、
    `publishNewActivity`、`notifyParticipants`），统一入口做「去重 → 每日封顶 → 私信 → 写去重行」，
    失败只记 warn；新 env `ACTIVITY_NOTIFY_DAILY_LIMIT`（默认 3，0 = 不限制）。
    命令：`/activity subscribe|unsubscribe [群号|#群短码]`。
  - **统计图片 / CSV 导出**：新服务 `activityStats`（`@napi-rs/canvas` 渲染 PNG：报名/候补/待释放/截止 +
    学院/年级分布；**字体系统优先**，缺失时从 `ACTIVITY_STATS_FONT_URL` 下载缓存到 `data/fonts/`；
    拿不到依赖或字体 → 返回 `undefined` 并降级为文字统计卡）与 `activityExport`（CSV：
    `序号,姓名,学号,班级,学院,备注,候补`，代码块私信操作者）；群图片走官方富媒体
    （`uploadGroupImage` 分片上传 + `sendGroupImage` `msg_type:7`，端点可配），
    `FakeQQOfficialAPI` 同步支持。
  - 保留 `/activity create|set|open|close|cancel|join|quit|info|signups|list` 作为降级路径；
    `/activity set` 新增 `closeAt` / `waitlistPromotion` / `mentionAll` / `notifyCreator`，
    改动当事人关心的字段会私信已报名 + 候补一次（去重 + 封顶）。

### 变更

- `/activity` 的活动卡与列表按钮从「指令按钮」改为「回调按钮」，纯文本降级仍在 footer 保留可复制指令；
  `/activity info` 改为卡片；名单默认脱敏；`/menu` 的活动子菜单补上新入口。
- **`@全体成员` 做不到**（真机穷举 5 种写法全失效）：`mentionAll on` 只给操作者私信
  「机器人无法 @全体成员，如需通知全群请手动 @ 一条」，群里不假装能 @。
- `cardTemplate` 的回调按钮也支持 `modal`（不可逆动作二次确认）。

### 已知限制

- 统计图片是**可选能力**：装不上 `@napi-rs/canvas` 时按钮不生成、回调降级为文字统计卡（设计如此）。
  官方群图片没有 multipart 直传，本地 PNG 走分片上传；平台若调整字段/路径需更新 `QQOfficialEndpoints`。
- CSV 超过单条消息上限时只提示用 `/export #短码`（当前没有对象存储，无法给下载链接）。
- 满员广播只在「本次报名恰好填满」时触发；管理员事后调小名额不会补发。
- 活动通知只有「去重 + 每人每日封顶」，没有更细的 qps 级节流（沿用既有 `SendThrottle`）。

## [0.1.7] - 2026-09-25

### 新增

- **`/testat`：@ 渲染真机自检**（仅全局超管，群里执行）：先发 3 条（纯文本 @、Markdown 首行 @、
  Markdown 正文中间 @），`/testat all` 再多发 5 条 @全体候选写法（`@everyone` / `<@!all>` /
  `<@!everyone>` / 纯文字 / 纯文本，按钮带二次确认），最后回一张汇总卡。
  **实测结论：Markdown 卡片里的 `<@!openid>` 生效；纯文本 `<@!openid>` 与 `@everyone` 都不生效。**
  为此新增 `RichMessageSender.sendPlainToGroup()/sendPlainToUser()`（纯文本通道，作对照与兜底）。

## [0.1.6] - 2026-09-25

### 新增

- **仓库隐私守卫**：文档示例里的真实 QQ号 / 群号 / openid 全部换成占位值，并新增
  `test/privacyGuard.test.ts`：按形状规则（9-12 位未登记数字、32 位十六进制 / 截断 openid）+ 占位白名单判断。
  **守卫自身不保存任何真实值**（连片段都不存）；需要精确兜底时用本地环境变量
  `PRIVACY_GUARD_IDS=<值1>,<值2>`（真实值只放本地）。

### 变更

- **`/whois` 结果只走私信**：群里发指令时结果私信给操作人，群里只回「已私信发送」提示卡；
  私信失败只提示「先私聊机器人再试」，**绝不在群里降级显示结果**；群内可用 `@` 指定目标
  （`/whois <@对方>` / `/whois profile <@对方>`，走官方 at 段；`@昵称` 无法反查会给出提示）。
- **短码只使用数字 + 大写字母**：字符表 62 → 36（`0-9A-Z`），`short_codes` 与活动短码同时生效；
  **启动时把含小写的旧短码重生成**并写回（旧短码失效，需重新获取）；手输仍大小写不敏感。
- **个人资料年级统一两位**：`/profile set year` 只接受 `22`/`23`…，四位年份报错；班级库四位年份写入时
  自动转两位；启动时历史四位值收敛并写回；活动 `allowYears` 输入同样只接受两位（历史四位仍能匹配）。

## [0.1.5] - 2026-09-24

### 新增

- **`/profile set` 智能识别**：一条消息填完（`/profile set 材化2211 张三 22123456789`），顺序随意、
  分隔符随意（空格 / `-` / `+` / `/` / `,` / `、` / `|` / `;` / 中英文括号），甚至完全不带分隔符，
  也支持 `字段=值` 消歧；识别规则：11 位数字 = 学号、班级库最长命中 = 班级、剩余 2-4 个连续汉字 = 姓名；
  **歧义或残留一律整体不写入**并列出识别结果。新增 `src/services/profileParser.ts`。
- **`/whois profile <QQ号|userId|#短码>`**（仅全局超管）：userId / QQ号 / 短码 + 姓名 / 学号 / 班级 / 学院 / 年级。
- **班级数据一次加工成 JSON + SQLite 双产物**：`pnpm class:index` 输出 `data/class-index.json`
  （`classes` / `majors` / `classInfo` + `colleges` / `collegeMajors` / `majorColleges`）与
  `data/class-index.sqlite`（`meta` / `colleges` / `majors` / `classes`）；`CLASS_INDEX_SQLITE_FILE=-` 可跳过；
  核心逻辑抽到 `scripts/classIndex.mjs`（可在进程内测试）。
- **班级 / 学院 / 专业别名表（`/alias`，全局超管）**：新表 `class_aliases` + `ClassAliasService`
  （内存 + 写穿透队列，重启不丢）；`/alias` / `/alias set <别名> <规范名>` / `/alias del <别名>`，
  目标类型自动判定；别名先展开成规范名再参与匹配，被 `/profile set` 与入群审核「班级+姓名」复用；
  忽略空白、长别名优先；入口 `/menu super`。

## [0.1.4] - 2026-09-23

### 新增

- **申请队列自动收敛过期 / 已处理项**：`JoinAuditService.expireStalePending()` 与
  `expireMissingFromRemote()`；待审批超过 `JOIN_REQUEST_TTL_DAYS`（默认 7 天，0 = 不过期）标记 `expired`；
  `/sync` 时与官方列表对账（官方已不返回且本地存在 >1 小时才判过期）；只改状态不删数据，
  `/audit` 记 `expire_join_request`，`/whois` 仍可追溯；启动 + 每 24 小时 + 查询 `/pending` 时懒清理。
- **`/whois` 申请短码详情**：补上群、申请人、理由、状态、申请时间、处理时间与处理人（系统自动过期 /
  机器人自动处理 / 具体审核人），并标明是否仍在本地队列。
- **`/whois` 不带参数查当前上下文**：群聊返回当前群、私聊返回你自己（都带群号/QQ号与短码）。

### 修复

- **回调翻页真机问题**：不再把 interaction id 当 `msg_id` 发被动消息（官方返回
  `400 请求参数msg_id无效或越权`），回包后直接主动发送新页；被动回复失败不再永久禁用键盘
  （只有「主动发送也带不上按钮」才判定平台不支持）。
- **`@机器人` 发指令收不到回复**：按官方实际格式剥离开头连续提及与不可见字符
  （`<@!appid>` / `<@id>` / `<@！id>` / 昵称形式 / 零宽与双向控制字符），正文里的提及不受影响。
- **全局超管在私信里看群指令帮助被误判权限不足**。
- **入群申请「回答」显示为（未填写）**：兼容 `verify_message` 与 `admin_review_qa` 两种验证方式。

## [0.1.3] - 2026-09-23

### 新增

- **批次 2（管理类）卡片**：`/audit` 分页卡、`/test` 自检卡、`/sync` 固定动作卡、`/approve` / `/reject`
  审批结果卡、`/notify` 订阅开关（全回调自动生效）。
- **批次 3**：`/activity` 列表分页卡 + `/menu` 各级导航全部改回调 + 通用回调 `cb:cmd:run:<指令>` +
  **`/menu` 覆盖全部指令**（系统 / 管理 / 超管 / 活动 / 审核操作 / 活动运营）。
- **全量卡片兜底**：`AdminCommandService.ensureCard` 把用法提示、权限提示、错误提示也统一包成卡片，
  「所有指令输出都是卡片」成为代码层不变量（测试锁住）。

### 变更

- **排版约束**：一行按钮文字总长 ≤12 字、单个按钮 ≤10 字、整盘 ≤5 行（模板强制）；开关类一行 2 个，
  枚举一行 2-3 个；按钮已表达的开关/枚举状态不再在正文重复；过挤的拆子卡。
- **回调反馈改为 @ 操作人**：不再内联「操作人：<QQ号>」，群内回复在开头单独一行 `<@!userId>`。
- **非 help 卡片不再罗列手动指令**（统一在 `/help` 里查，只保留分页 `+页码` 提示）。
- **`/notify test` 不再要求「可审批的群」**：没有可用群时也能发纯通道测试卡。

## [0.1.2] - 2026-09-23

### 新增

- **卡片标准（`docs/CARD-STANDARD.md`）**：所有指令输出统一为菜单式卡片，定为项目标准。
  - 按钮分两类：**导航 / 查看 / 翻页 / 刷新用回调**（`cb:<namespace>:<action>[:args]`），
    **执行动作用指令按钮**（与手输同一条权限、审计、二次确认路径）；
  - 列表分页标准：每页固定条数 + 回调翻页，正文给出 `+页码` 指令（如 `/pending +2`）作为纯文本降级；
  - 通用回调管道：`callbackData`（编码/解析）+ `CallbackRouter`（回包 → renderer → 主动发送），
    renderer 内部必须自行做权限校验；标准含「新增指令检查清单」。
- **首批样板指令改卡片**：`/help`（列表卡 + 主题卡）、`/status`（状态卡 + 回调入口 + 自检指令按钮）、
  `/pending`（每页 3 条，通过/拒绝带二次确认，翻页为回调）、`/rules`（当前生效值 + 快捷开关）。
- **`/testmenu`**：官方回调按钮翻页试验（仅全局超管，正式保留）——打通
  `INTERACTION (1<<26)` intent、`INTERACTION_CREATE` 映射与路由、`PUT /interactions/{id}` 回包；
  非超管点击回包并提示权限不足；发送失败自动降级。
- `cardTemplate` 支持回调按钮（`action.type=1`）与指令按钮混排同一键盘。

## [0.1.1] - 2026-09-23

### 新增

- **QQ 端系统交互菜单 `/menu`**：三级菜单（系统 / 管理 / 超管），入口按权限过滤；
  `/menu sys|admin|review|ops|super` 与中文别名；空 `@机器人`、私信空消息、私信首次交互都回主菜单；
  未知指令在报错后附菜单按钮；`MENU_FIRST_PUSH`（dev 默认 memory，正式默认 persistent，落库 `menu_deliveries`）。
- **统一卡片模板 `cardTemplate`**：菜单 / 入群申请卡 / 活动卡共用「标题 + 正文 + 按钮行 + 底部提示」，
  由同一份定义产出 Markdown / 按钮 / 纯文本降级，官方限制（行数 ≤5、每行 ≤5、按钮文字 ≤10）集中校验。
- **富消息被动回复**：`RichMessageSender.replyToUser/replyToGroup` 优先 `msg_id` 被动回复，
  失败降级主动发送（`active_fallback`）；三级降级「Markdown+按钮 → Markdown → 纯文本」。
- **指令帮助主题**：`/help <指令>` 详情（支持中文别名与前导斜杠），主题详情也做权限过滤；
  `/help rules` 附带当前群生效值、`/help bind` 显示绑定状态；主题抽到 `helpTopics.ts`。
- **权限模型拆分**：新增「本群超级管理员」（`/perm grant gsuper`，别名 `groupsuper` / `群超管` / 本群超管），
  只在该群内等价 `super_admin`，拿不到平台级能力；`/perm`、`/myperm` 分别展示全局 / 本群超管。
- **展示标识改为随机短码**：`join_request_id` / 未绑定 `user_openid` / 未绑定 `group_openid` 各得一个
  6 位短码（`short_codes` 表，`code` 主键 + `(kind, target_id)` 唯一，随机生成、查重重生成、不用自增 ID）；
  `/pending`、`/sync`、推送卡片、`/audit`、`/status`、`/perm list`、`/rules`、`/notify`、`/test` 只显示
  QQ号 / 群号 / 短码；所有命令参数接受短码，完整 `join_request_id` 仍兼容；`/whois` 是唯一能看到真实
  系统 id 的指令（超管限定）。
- **入群审核规则引擎**：`joinDecision` 5 档（manual / auto_approve / approve_on_match /
  reject_on_match / reject_on_mismatch）+ `joinRequireClass` / `joinRequireName` / `joinAnswerPattern` /
  `joinReviewOpinion`；索引缺失、正则无效或无法判定时一律回退人工审核。
- **班级 / 专业库**：`pnpm class:index` 把 `data/class.json` 转成 `data/class-index.json`（默认 2022-2026 级，
  `CLASS_INDEX_YEARS` 可调）；`MemberRoster` + `JoinRuleEvaluator`；原始数据与索引都在 `.gitignore`。
- **群扩展配置持久化**：`group_settings` 键值表承载 `keywordRecall` / `keywordPunish` / `joinDecision` /
  `joinRequire*` / `joinAnswerPattern` / `joinReviewOpinion` 等扩展字段，新增字段无需 ALTER。
- **关键词处罚动作**：`/rules set keywordRecall on|off` 与 `keywordPunish none|mute|kick|kick_blacklist`；
  每个动作尽力而为，单个失败只记日志，全部失败审计为 `pending`。
- **入群申请推送（卡片 + 快捷同意/拒绝）**：`/notify` 系列命令，推送 Markdown + 内嵌指令按钮；
  自定义按钮被拒后逐级降级；只推仍需人工处理的申请，同一 (群, 申请, 人) 只推一次；
  新表 `notification_subscriptions` / `notification_deliveries`；预设拒因按钮（红色样式）。
- **个人资料 `/profile`** 与**活动发布 / 报名 / 管理**：`user_profiles` 与 `activity_details` 两张新表；
  学号 11 位且前两位 22-26、班级必须在班级库（自动带出学院）、学院/年级可覆盖；活动支持链接、名额、
  简介与学院/年级白黑名单，报名前要求资料完整；权限：创建/修改/开停/看名单需群管理员及以上，
  发布者本人可管理自己的活动。
- **关键词豁免**：审核员及以上不再做关键词判断（不警告/不撤回/不处罚/不写审计）。
- **群配置 `notifyAutoApproved`**：机器人自动通过/拒绝的申请是否也推送（默认关闭）。

### 变更

- 官方调用域名从 `api.sgroup.qq.com` 迁移到 `api.bot.qq.com`（官方 2026-08-10 起统一域名）。
- `GroupConfigStore.setOverride({ groupId: "__default__" })` 从抛错改为更新全局默认配置；
  新增 `DEFAULT_GROUP_ID` 与 `builtinDefault`。
- 全局规则：`/rules all` 查看、`/rules set all <字段> <值>` 修改（`all` 也可写 `global` / `default` / 全局）；
  未单独配置的群继承全局，已配置的群按字段覆盖。
- **用户可见输出只显示解析号**：绑定过 QQ号/群号时不再暴露内部 `userId` / `group_openid`（未绑定才回退），
  纯文本降级里的指令也改用群号（`/approve 654321 <申请ID>`）。

## [0.1.0] - 2026-09-23

首个可运行版本：**仅使用 QQ 官方开放平台 API** 的群管理与运营机器人，覆盖群管、入群/内容审核、活动报名、信息导出与审计日志。

### 接入与网关

- 官方 REST 客户端 `QQOfficialClient`：鉴权、错误码映射、可替换 transport。
- 官方 WebSocket 网关：Hello / Identify / Resume / 心跳 / 事件分发。
- 自动重连：指数退避 + 抖动（1s 起、上限 60s），命中限流改用 120s 长冷却。
- 会话恢复：保存 `session_id` / `seq` / `resume_gateway_url`，重连优先 `op=6` Resume；`op=9` 失效时回退 Identify。
- 心跳 ACK 超时检测：一个周期内未收到 `op=11` 主动断开重连。
- 事件与回复失败容错：单个事件处理抛错只记录日志，不影响连接与后续事件。

### 限流防护

- access token 持久化缓存（`QQ_BOT_CACHE_FILE`），未过期直接复用，并发请求去重，401 自动刷新一次。
- 网关地址缓存，重连不再请求 `/gateway`；仅在连续失败且从未成功连接时才重新获取。
- 限流识别：解析 `err_code` / `code`（含嵌套与字符串）与 `retry-after`，覆盖 100017 / 40023001 / 22009 / HTTP 429。
- 出站消息节流：串行发送 + 最小间隔 400ms，22009 固定冷却重试最多 3 次。
- 被动回复配额拦截：单聊同一 `msg_id` 最多 5 次、群聊 5 分钟窗口，超限在发请求前拒绝。

### 群管理与审核

- 入群审批：`/pending`、`/sync`（按群 30 秒节流）、`/approve`、`/reject`，**先调用官方接口成功后再更新本地状态**；支持 `autoApproveJoin` 自动通过。
- 内容审核：群配置关键词真正驱动 `RuleEngine`，按群缓存规则引擎并在关键词变化时失效；命中发送该群警告文案并写入审计。
- 群规则：`/rules` 查看，`/rules set keywords|warning|muteDuration|wordFilter|joinAudit|autoApprove|export|enabled` 修改（局部合并，不会重置其他字段）。
- 官方管理动作：禁言（`restrict_chat_setting`，30 天上限）、踢人（`batch_remove_members`，需白名单）请求体已按官方文档核对。
- 审计查询：`/audit [数量]`。
- 权限：`/myperm`、`/perm`（超管授予/撤销超管、群管理员、审核员），动态 `/help` 只显示有权限执行的指令。
- 身份映射：`OpenID ↔ QQ号 / 群号`，`/bind qq|group|user|groupid`、`/whois`；除 `/help`、`/bind` 外强制绑定。
- 私信指令：群管理指令在私信中通过已绑定的群号或 `group_openid` 指定群。
- 活动报名与信息导出：领域服务、权限校验、CSV 导出与脱敏、导出审计。

### 持久化

- 默认 **SQLite**（Node.js 24 内置 `node:sqlite`，文件默认 `data/qq-group-ops.db`），零配置即可运行。
- 可选 PostgreSQL：`DATABASE_URL=postgres://...`。
- 同一套仓储 SQL 通过 `SqliteQueryable` 做方言转换为两种数据库服务，避免双份实现。
- 全部状态持久化并在启动时载入：绑定关系、权限、审计、入群申请、群配置、全量消息模式、活动报名。
- 写入策略：内存缓存 + 顺序写穿透队列，回复用户前与退出前 `flush()`。
- 数据保留清理：启动时与每 24 小时按 `AUDIT_LOG_RETENTION_DAYS` 清理过期审计记录与已审批申请（待审批不清理）。

### 可观测性

- 结构化日志：控制台 + 文件（JSON Lines），级别与 `LOG_COLOR=auto|always|never` 彩色策略。
- 统一 instrumentation：官方 API、HTTP、数据库、事件网关的调用与耗时日志。
- 敏感信息不入日志（token、secret、消息原文）。

### 工程化

- TypeScript 严格模式（`exactOptionalPropertyTypes` 等）、`tsc` 构建、Vitest 测试。
- 306 个测试（发布时）；SQLite（真实文件）与 PostgreSQL（pg-mem）双数据库覆盖，含 Phase 1 验收「干跑」端到端用例。
- Dockerfile（node:24-slim）与 Docker Compose（bot 默认 SQLite；PostgreSQL 走 `postgres` profile）。
- 文档：架构、配置、路线图、合规、决策记录（ADR）、验收清单。

[Unreleased]: https://github.com/muyangplus/qq-group-ops/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/muyangplus/qq-group-ops/releases/tag/v0.1.0
