# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **活动卡片 / 回调 / 订阅（§B2）**：活动管理从「指令按钮 + 手动指令」升级为**回调驱动**，并补上按群订阅推送。
  - **三种视图 + 名单卡**（全部 `renderCard()`，Markdown + 内嵌按钮 + 纯文本降级）：
    - **成员卡**（群里那张）：`我要报名` / `取消报名`（回调 + 官方 `modal` 二次确认）、
      `活动详情`、`报名名单`（**只有管理者能看到这个按钮**）、`订阅 开/关`；
      正文含简介、活动群、报名 `X/Y`（满员显示「已满，可进候补」）、候补 N、截止 `MM-DD HH:mm`
      （过期显示「已截止」）、限制与链接；footer 保留 `/activity join|quit #码`；
    - **配置卡**（`/activity create` 后自动返回，`cb:activity:config:<短码>` 也打开）：短码/标题/状态/
      名额/限制/截止/递补/@全体提示/报名通知；按钮：名额 `10/20/50/不限` + `自定义`（指令按钮预填）、
      `学院限制` / `年级限制` 子卡、`不限截止` + `自定义`、`递补 自动/手动`、`报名通知 开/关`、
      `提醒@全体 开/关`、`预览卡片` / `开放报名` / `取消`（带 modal）；
    - **管理卡**（`cb:activity:manage:<短码>`）：报名 `X/Y`、候补 N、**待释放名额 M**、学院分布（前 3）、
      年级分布、截止、递补方式；按钮：`报名名单`、`释放名额`（**仅当 `heldSlots>0` 时生成**）、
      `重发卡片`、`开/关报名`、`取消活动`、`统计图片`（§B3 未装配时不生成）；
    - **名单卡**：每页 10 人，默认只列 `序号 姓名（班级）备注`（**默认不显示学号/学院**），
      `完整信息` 开关才切到含学号/学院；候补区单独列出（最多 10 个 + 「还有 N 人」）；
      只有 `canManageActivity` 可用，非管理者回调得到「权限不足」卡；`导出 CSV`（§B3 未装配时不生成）。
  - **回调命名空间 `activity`**（`cb:activity:<action>[:args]`）覆盖
    `join, quit, info, signups, page, config, preview, open, cancel, release, resend, status, set, college, year, subscribe, stats, export`；
    renderer 在 `runtime.ts` 的 `callbackRenderers` 里注册，**每个 action 内部重新做权限校验**
    （报名/取消/订阅 = 任意成员；配置/发布/关停/释放/名单/导出/统计 = `canManageActivity` 或超管）；
    回调参数用**活动短码**，解析失败返回一张「活动不存在」卡。
  - **消息落点（隐私优先，用户确认）**：群里报名只回 `<@!申请人>` + `报名成功 · 当前 X/Y`，
    **不出现姓名/学号/班级/学院**；报名失败群里只说「原因已私信」，**具体原因只走私信**
    （私信失败时提示「请先私聊机器人再试」，绝不降级到群里）；私聊操作可含姓名/学号/序号/人数；
    `manual` 模式取消报名只在管理卡的「待释放名额」里体现，**不在群里公开谁退出了**。
  - **递补与变更通知**：`auto` 模式取消即递补、管理卡「释放名额」递补候补第一位，
    被递补者**私信**收到「你已递补成功（当前 Y/Z）」（不往群里发）；活动发布/变更/取消
    分别私信订阅者 / 已报名+候补，`mentionAll on` 时给操作者私信提示
    「机器人无法 @全体成员，如需通知全群请手动 @ 一条」，**不假装能 @全体**。
  - **新表 + 仓储**：`activity_subscriptions`（按群订阅）与 `activity_notifications`
    （`(activity_id, user_id, kind)` 去重 + 每人每日计数）；新增
    `src/db/activitySubscriptionRepository.ts`、`src/db/activityNotificationRepository.ts`，并接入
    `persistence.ts` / `runtime.ts` / `main.ts` / `test/helpers/persistenceRuntime.ts`。
  - **新服务 `src/services/activityNotifications.ts`**：`load/flush`、
    `isSubscribed/subscribe/unsubscribe/listSubscribedGroups`、
    `publishNewActivity`（给该群所有订阅者私信活动卡）、`notifyParticipants`（当事人）；
    统一入口 `deliver()` 做「去重 → 每人每日封顶 → `sendPrivateCard` → 写去重行」，
    **失败只记 warn 不抛错**（活动状态不受通知失败影响）。
  - **新 env `ACTIVITY_NOTIFY_DAILY_LIMIT`**（默认 `3`，非负整数，`0` = 不限制）：
    主动私信有官方额度（单用户每天 1000 条、单关系 20 qpm、未认证机器人 5 qps & 30 qpm），
    封顶避免一次活动变更把额度打满。
  - `/activity list` 改为**按状态分组**（报名中 / 草稿 / 已结束），每个活动一行
    `详情 / 报名 / 管理（仅管理者）/ 订阅`（全部回调）；`/activity signups <#码> +页码 [full]` 降级可用。
  - 保留 `/activity create|set|open|close|cancel|join|quit|info|signups|list` 作为**降级路径**；
    `/activity join|quit` 改用 `joinActivity()` / `cancelRegistrationWithPromotion()` 并返回 `CardResult`；
    新增 `/activity subscribe|unsubscribe [群号|#群短码]`。
  - **§B3 可选依赖**：统计图片与 CSV 导出做成**条件生成按钮**（`ActivityCardService` 的
    `stats` / `exportService` 注入项，未装配时按钮不生成；`cb:activity:stats` 降级为文字统计卡，
    `cb:activity:export` 提示未装配），B2 因此可以独立交付、之后接线即可。
- **活动统计图片 / 群图片上传 / CSV 导出（§B3）**：
  - **群图片上传与发送**（`src/adapters/qqOfficial.ts`）：新增 `uploadGroupImage`（官方
    「群聊富媒体上传」`POST /v2/groups/{group_openid}/files`，本地 PNG 没有公网 URL，因此走
    `upload_prepare` → 逐片 `PUT` 预签名 URL → `upload_part_finish` → 带 `upload_id` 合并的分片路径）
    与 `sendGroupImage`（`msg_type: 7` + `media.file_info`，官方要求 `file_info` 原样透传）；
    三个端点路径都可在 `QQOfficialEndpoints` 覆盖（`groupFileUpload` / `groupFileUploadPrepare` /
    `groupFileUploadPartFinish`）。`AsyncTransport` 新增**可选**的 `requestRaw`（分片 `PUT` 既不是 JSON
    也不带机器人鉴权头），`FetchTransport` 实现它；`FakeQQOfficialAPI` 记录
    `uploadedGroupImages` / `sentGroupImages` 并提供 `failGroupImages` 失败开关。
  - **新服务 `src/services/activityStats.ts`**：用 `@napi-rs/canvas` 渲染 PNG（宽度 720、高度自适应）——
    标题、`报名 X/Y`、`候补 N`、`待释放名额 M`、`截止`、学院分布与年级分布（横向条形 + 人数）。
    **字体系统优先**（Windows 雅黑 / Linux Noto CJK / 文泉驿 / macOS 苹方），找不到才从
    `ACTIVITY_STATS_FONT_URL` 下载并缓存到 `data/fonts/`（`data/` 已 gitignore，**缓存不随包提交**）。
    `@napi-rs/canvas` 是**可选依赖**，用变量拼包名动态 `import()`（静态写法会变成编译期硬依赖）；
    拿不到依赖或字体时 `render()` 返回 `undefined`，调用方降级为**文字统计卡**，
    **绝不影响启动或活动回调**。
  - **新服务 `src/services/activityExport.ts`**：CSV 列固定
    `序号,姓名,学号,班级,学院,备注,候补`（候补行最后一列 `候补`），以代码块**私信给操作者本人**
    （群里不回执内容）；超过单条消息长度上限（默认 1800 字符）时不硬塞，改为提示用 `/export #短码`
    拿完整文件（避免被平台截断成半份名单）。
  - **接线**（`src/runtime.ts`）：装配 `ActivityStatsService` + `ActivityExportService`，通过
    `setActivityExtras()` 注入 `AdminCommandService` 与 `ActivityCardService`（两处同步，
    否则会出现「有实现没入口」）；`cb:activity:stats` 渲染并发送图片，成功回「已发送统计图」卡，
    渲染降级 / 上传失败 → 文字统计卡；`cb:activity:export` 生成 CSV 并私信操作者。
    `ActivityStatsLike` 新增 `canSend`：只有**既能渲染又能发送**时才生成「统计图片」按钮。
  - **新 env `ACTIVITY_STATS_FONT_URL`**（默认 Noto Sans SC 官方发布地址，留空 = 只用系统字体）。
- `cardTemplate` 的**回调按钮也支持 `modal`**（报名 / 取消报名 / 取消活动等不可逆动作的二次确认）。
- **活动群内静默 + 多群绑定 + 满员广播（§B4）**：
  - **群内报名 / 取消报名一律静默**：群里点回调或手输 `/activity join|quit` 都**不发任何群消息**
    （连「原因已私信」都不发），成功 / 候补 / 失败原因一律私信本人（私信可含姓名/学号/班级/序号/人数）。
    实现链路：`CommandResult` 新增 `silent?: boolean`（`ensureCard` 原样保留）→
    `EventRouter` 透传到 `kind:"command"` → `gatewayRunner` 在 `result.silent === true` 时
    **跳过一次 `sendReply`**；`cb:activity:join|quit` 的 renderer 在私信成功后**返回 `undefined`**
    （只回包、不发言）。
  - **唯一例外**：私信发送失败（没私聊过机器人 / 关闭主动消息 / 被限流）时，群里只回一条
    **不含任何结果**的提示「`<@!申请人> 私信发送失败，请先私聊机器人再试`」；私聊里用同样的指令
    仍然原地回复。
  - **活动可绑定多个群**：新增 `activity_groups (activity_id, group_id, created_at)` 表与
    `src/db/activityGroupRepository.ts`（接入 `persistence.ts` / `runtime.ts` / `main.ts` /
    `test/helpers/persistenceRuntime.ts`）；`ActivityService` 新增
    `bindGroup` / `unbindGroup` / `listBoundGroups`（幂等），`createActivity` **自动绑定创建群**，
    `load()` 读回绑定关系；`activities.group_id` 仍是「归属群」，绑定全部解绑后回落到归属群。
  - **新增命令 ` /activity bind|unbind <#活动短码> <群号|#群短码>`** 与配置卡的「绑定群」子卡
    （每页 5 个 + `解绑` 回调 + `绑定群` 指令按钮 + `返回配置`）。
  - **发布 / 重发改打所有绑定群**：`/activity open` 与「重发卡片」逐个群发送，
    操作者的私信回执列出「成功 N 个 / 失败 N 个」与失败群号（展示用群号，不暴露 openid）。
  - **满员广播**：`joinActivity` 的 registered 分支新增 `becameFull`（本次报名后恰好满员），
    调用方随后在**所有绑定群**发一张「活动已满 X/X」卡（含「后续报名将自动进入候补队列
    （当前候补 N 人）」与截止时间、`活动详情` / `订阅` 按钮）；**每个群只发一次**——
    复用 `activity_notifications` 去重，键为 `(活动, group:<群ID>, full)`（群消息不占用户私信额度）。
  - `ActivityNotificationKind` 新增 `full`；`ActivityNotificationService` 新增可选 `groupSender`
    与 `notifyGroupsCard()` / `isGroupCardSent()`（只在发送成功的群写去重行，失败可重试；
    未装配通道时返回 `available: false`，静默跳过）。

### 变更

- `/activity` 的活动卡片由「指令按钮」改为「回调按钮」：点击即出卡 / 生效，不用再发消息；
  纯文本降级仍在 footer 保留 `/activity join|quit #码` 等可复制指令。
- `/activity info` 改为**卡片**（原先只回文本），并根据查看者权限给出「管理 / 配置」或「订阅」入口。
- 名单默认脱敏：`/activity signups` 与名额回调不再默认显示学号/学院，需点「完整信息」。
- `/menu` 的「活动」「活动运营」子菜单补充订阅、配置卡、管理卡与 `[+页码] [full]` 等新用法。
- `/activity set` 新增 `closeAt` / `waitlistPromotion` / `mentionAll` / `notifyCreator` 字段，
  并在改到「当事人关心」的字段时给已报名 + 候补私信一次变更通知（`kind: "changed"`，去重 + 封顶）。
- **活动消息落点改为「群内静默」（§B4，覆盖 §B2 的群内回执）**：报名 / 候补 / 取消报名 / 报名失败
  在群里都不再有回执，结果只私信本人；发布回执与成员卡、满员卡仍然是群消息（不含隐私字段）。
- `/activity open` 的群内回执与操作者私信回执改为**逐群结果**（多群绑定后一个群一句话）；
  `/activity list` 的按钮不变，`/activity set` 的「群号」字段仍然只影响卡片展示。
- `<@!>` 与 `msg_type=7` 共用「发送群聊消息」接口：图片发送复用 `sendGroupMessage` 的节流与
  被动回复配额，`sendGroupImage(groupId, fileInfo, msgId?)` 支持被动回复。

### 修复

- 无（§B2 / §B3 不含 B1 的修复项）。

### 已知限制

- **无法自动修改群成员昵称/群名片**：官方开放平台「群聊管理」接口中没有该能力，已核对接口列表。入群审核识别到的「班级+姓名」会展示在 `/pending` 审核意见与日志中，供人工改名；若官方后续开放该接口，可在 `JoinRuleEvaluator` 输出之上直接接入。
- **统计图片是可选能力**：`@napi-rs/canvas` 是原生依赖，装不上时「统计图片」按钮不生成、
  回调直接降级为文字统计卡（设计如此，不影响启动与报名）。官方群图片上传没有 multipart 直传接口，
  本地 PNG 走分片上传；若平台调整 `upload_prepare` / `upload_part_finish` 的字段或路径，
  需要按官方文档更新 `QQOfficialEndpoints`（已做成可配置）。
- **CSV 超过单条消息上限时不给文件本体**：只私信提示用 `/export #短码`。当前没有对象存储，
  无法提供下载链接；如需直接发文件，可用 `file_type: 4` 的群文件上传扩展这条路径。

- **卡片标准（`docs/CARD-STANDARD.md`）**：所有 QQ 指令输出统一为菜单式卡片，定为项目标准。

  - 按钮分两类：**导航 / 查看 / 翻页 / 刷新用回调**（`cb:<namespace>:<action>[:args]`，
    点击即回包并重发卡片），**执行动作用指令按钮**（与手输指令同一条权限、审计、二次确认路径）；
  - 列表分页标准：每页固定条数 + 回调翻页，**正文必须给出 `+页码` 指令**（如 `/pending +2`），
    保证按钮不可用时纯文本仍能翻页（`+` 前缀避免与群号参数冲突）；
  - 新增通用回调管道：`callbackData`（编码/解析）+ `CallbackRouter`（回包 → renderer → 主动发送），
    `/testmenu` 也改走同一管道；renderer 内部必须自行做权限校验；
  - 标准含「新增指令检查清单」，后续新指令一律按此实现。
  - **排版约束**：一行按钮文字总长 ≤12 字（模板强制；按钮个数不限，官方上限一行 5 个），
    单个按钮 ≤10 字，整盘 ≤5 行；开关类一行 2 个（描述 2-4 字 + 开/关），枚举一行 2-3 个；
    按钮已经表达的开关/枚举状态不再在正文重复，卡片过挤时拆成子卡（例：`/rules` 概览 + 三个子卡）。
- **班级 / 学院 / 专业别名表（`/alias`，全局超管）**：
  - 新增 `class_aliases` 表（`alias` 主键 + `target` + `kind` + `updated_at`）、
    `SqlClassAliasRepository` 与 `ClassAliasService`（内存 Map + 写穿透队列，启动载入、重启不丢）；
  - 命令：`/alias` 查看（卡片）、`/alias set <别名> <规范名>`、`/alias del <别名>`；
    目标类型（班级 / 学院 / 专业）由规范名在班级库里的身份**自动判定**，不用手填；
    入口：`/menu super` → 「别名表」，详细用法 `/help alias`；
  - 别名**先展开成规范名**再参与匹配，因此同时被 `/profile set` 智能识别与入群审核
    「班级+姓名」匹配复用（回答里写 `环工2214` 也能命中班级 `环境类2214`）；
  - 匹配忽略空白差异（`环工 2214` 也算命中）、**长别名优先**，避免短别名把长别名切碎；
  - 仅全局超级管理员可维护（班级数据本身是全局的，别名也全局）。
- **`/profile set` 智能识别 + `/whois profile`**：
  - `/profile set` 现在支持**一条消息填完**：`/profile set 材化2211 张三 22123456789`；
    顺序随意（班级/姓名/学号任意排列），分隔符随意（空格、`-`、`+`、`/`、`,`、`、`、`|`、`;`、
    中英文括号），甚至**完全不带分隔符**（`材化2211张三22123456789`）也能切分；
    也支持显式 `字段=值`（`班级=材化2211 姓名=张三 学号=22123456789`）消歧；
  - 识别规则：11 位数字 = 学号；能在班级库里匹配到的最长班级名 = 班级；学院可手填；
    剩余 2-4 个连续汉字 = 姓名；`年级=23` 可显式指定。新增 `src/services/profileParser.ts`；
  - **歧义或残留一律不写入**：识别到多个班级 / 多个姓名 / 认不出的内容时返回错误，
    并列出识别结果，提示改用 `字段=值`；写入前先整体校验（学号前缀、班级是否存在、姓名长度），
    避免"写一半失败"；
  - 新增 `/whois profile <QQ号|userId|#用户短码>`（仅全局超级管理员）：输出 userId / QQ号 / 短码
    + 姓名 / 学号 / 班级 / 学院 / 年级，未填写时显示「尚未填写」；
  - 定位：`/profile set <字段> <值>` 与 `/profile clear` 等旧写法完全保留，新写法只是补充。
- **申请队列自动收敛过期/已处理项**：
  - `JoinAuditService` 新增 `expireStalePending()` 与 `expireMissingFromRemote()`：
    待审批申请超过有效期（`JOIN_REQUEST_TTL_DAYS`，默认 7 天，`0` = 不自动过期）即标记为
    `expired`；`/sync` 时与官方列表对账，**官方已不再返回、且已存在超过 1 小时**的本地待审批
    也会被标记过期（避免官方列表分页/滞后误判）；
  - 只改状态不删数据：过期的申请不再出现在 `/pending`、推送与统计里，但 `/audit` 会记一条
    `expire_join_request`（`AuditStatus.Expired`），`/whois` 仍能查到；
  - 清理时机：启动时 + 每 24 小时（复用 `RetentionService`），并在每次查询 `/pending` 时懒清理。
- **`/whois` 查入群申请短码时给出完整申请详情**：类型/短码/真实申请 ID 之外，补上群、申请人、
  理由、状态、申请时间、处理时间与处理人（系统自动过期 / 机器人自动处理 / 具体审核人），
  并标明是否仍在本地队列；不带参数的默认查询（群聊=当前群、私聊=你自己）保持不变。
- **批次 3：活动列表分页 + 菜单树覆盖全部指令**：
  - `/activity` 列表改为分页卡：每页 3 个活动，每个一行「报名 / 详情 / 名单」按钮，
    翻页是回调，正文给出 `/activity list +2` 降级；
  - `/menu` 及其各级子菜单的**导航按钮全部改为回调**（点击即出下一张卡），
    页脚不再罗列手动指令（手动指令统一在 /help 里查）；
  - 新增通用回调 `cb:cmd:run:<指令>`：把任意固定指令包装成一键回调入口
    （权限、审计、二次确认与手输完全一致），菜单里的 `/myperm`、`/profile`、`/audit`、
    `/notify`、`/testmenu`、`/perm list`、`/global rules` 等都由它接入；
  - **`/menu` 现在覆盖全部指令**：系统菜单（帮助/绑定/我的权限/我的资料/活动）、
    管理菜单（待审批/同步/审计/规则/状态/自检/通知订阅）、超管菜单（权限/全局规则/通知订阅/翻页测试）、
    以及活动、审核操作、活动运营子菜单；需要参数的指令在正文给出用法。
- **全量卡片兜底**：新增 `AdminCommandService.ensureCard`，凡是还没做定制卡的指令
  （用法提示、权限提示、错误提示同样算）都会被统一包成卡片 —— "所有指令输出都是卡片"
  从此是代码层不变量，并由测试锁住（`/bind`、`/whois`、`/profile`、`/activity`、`/perm`
  等已自动卡片化，后续再做定制布局与分页）。
- **批次 2（管理类）改为卡片**：
  - `/audit`：分页卡（默认每页 10 条、最多 50；`/audit <n>` 仍可改每页数量），
    翻页/刷新是回调，正文给出 `下一页：/audit +2` 降级；
  - `/test`：自检卡（群 / 用户 / 待审批数 / 全量消息模式）+ 刷新、待审批、群规则入口；
  - `/sync`：**固定动作**，指令或回调（`cb:sync:run:<群>`）都能触发，结果卡标明操作人；
  - `/approve`、`/reject`：审批结果卡（操作人 + 返回待审批 / 查看审计）；
  - `/notify`：订阅开关全回调自动生效（本群 / 全部群），「测试推送」也是回调，
    结果卡在群内会 @ 操作人。
- **首批样板（4 条指令改为卡片）**：
  - `/help`：指令列表卡 + 主题详情卡，菜单与主题入口为回调按钮，正文保留完整指令列表（降级可复制）；
  - `/status`：状态卡 + 刷新/待审批/群规则/帮助（回调）+ 自检（指令按钮）；
  - `/pending`：每页 3 条，每条带「通过 / 拒绝」指令按钮（二次确认），翻页为回调，
    正文给出 `/pending +2`；空列表与无权访问也都是卡片；
  - `/rules`：当前生效值 + 快捷开关（**切换当前值的反向操作**，指令按钮）+ 全局规则/帮助入口。

- **`/testmenu`：官方回调按钮翻页试验**（仅全局超级管理员，正式保留）。
  - 卡片是 3 页简单文案 + 「上一页 / 下一页 / 返回第 1 页」**回调按钮**，
    第二行保留「指令翻页」按钮与正文里的 `/testmenu <页码>`（双通道兜底）；
  - 打通官方互动链路：新增 `INTERACTION (1<<26)` intent、`INTERACTION_CREATE` 事件映射与路由、
    `PUT /interactions/{interaction_id}` 回包（`respondInteraction`，请求体只有 `{ code }`）；
  - 收到点击后先回包（不回包客户端会一直 loading 到超时），再发出新的一页；
    官方既没有「更新原消息」的接口，也不允许把互动事件 id 当 `msg_id` 发被动消息
    （真机实测 400），所以**旧卡片会保留在聊天记录里** —— 这是官方能力限制，不是实现取巧；
  - 发送失败会自动降级（`RichMessageSender` 三级降级），"点了看不到新页"的情况被兜住；
  - 非超管点击（卡片可能被转发）会回包并提示权限不足，不会翻页；
  - 依据官方文档确认：**没有更新原消息的接口**，因此这不是"原地改写卡片"，
    而是"点击即回复下一页"。
- `cardTemplate` 支持回调按钮（`callbackData` → `action.type=1`），与指令按钮二选一，
  混排同一个键盘；`/help testmenu` 帮助主题（当前 18 个主题）。

- **QQ 端系统交互菜单 `/menu`**：三级菜单（系统 / 管理 / 超管），Markdown 卡片 + 内嵌按钮。
  - 入口按权限过滤：成员只看到系统菜单；审核员及以上出现管理菜单；超管菜单仅全局超管可见
    （本群超管会提示改用管理菜单）；
  - 子菜单：`/menu sys`、`/menu admin`、`/menu review`、`/menu ops`、`/menu super`，
    支持中文别名（`/菜单 管理菜单`）；
  - 按钮全部是**指令按钮**（`action.type=2`）：点击等价于发送对应指令，权限校验、审计与手输一致，
    不新增事件类型；需要参数的指令（如 `/approve <申请ID>`）在正文里给用法，不放死按钮；
  - 空 `@机器人`、私信空消息、私信首次交互都会回到主菜单；未知指令在原有报错后附上菜单按钮；
  - `src/dev.ts` 自动设置 `MENU_FIRST_PUSH=memory`：dev 只记内存（重启可再验证），
    正式启动默认 `persistent`，落库新表 `menu_deliveries`（`user_id` 主键），重启不重复推送。
- **统一卡片模板 `cardTemplate`**：菜单、入群申请卡、活动卡共用同一套
  「`## 标题` + 正文 + 按钮行 + 底部提示」布局，并由同一份定义产出 Markdown / 按钮 / 纯文本降级；
  按钮行数（≤5）、每行按钮数（≤5）、按钮文字长度（≤10）等官方限制集中在模板里校验，
  重复按钮 id 直接抛错。
- **富消息被动回复**：`RichMessageSender` 新增 `replyToUser` / `replyToGroup`，
  优先用 `msg_id` 被动回复，全部失败再降级为主动发送（`detail` 记为 `active_fallback`）。
- `/help menu` 帮助主题（当前 17 个主题），`/help` 列表同步展示。

- **指令帮助主题**：`/help <指令>` 展示单个指令的详细用法，例如 `/help rules`、`/help bind`、`/help perm`。
  - 支持中文别名与带前导斜杠（`/help 规则`、`/help /rules`），未知主题会提示用法并回退到指令列表；
  - 主题详情也做权限过滤：无权限时只提示所需权限，不展示执行不了的命令；
  - `/help rules` 在群内会附带该群**当前生效值**（关键词、开关、警告文案、禁言时长）；
  - `/help bind` 会显示你当前的绑定状态；
  - 主题定义抽到 `src/services/helpTopics.ts`（当前 14 个主题），便于扩展与测试。
- **权限模型拆分**：新增「本群超级管理员」（`/perm grant gsuper`，别名 `groupsuper` / `群超管` / `本群超管` / `群超级管理员`）。
  - 只在该群内等价于 `super_admin`（可审批、改规则、查审计、导出），拿不到 `/perm`、`/rules all`、`/bind user|groupid`、`/whois` 等平台级能力；
  - 每个群的角色单独配置，`/perm list` 与 `/myperm` 分别展示全局/本群超管；
  - 复用 `permission_grants` 的 `scope='super_admin'` + 非空 `group_id` 存储，无需改表结构；
  - `ADMIN_USER_IDS` 只在数据库里没有**全局**超管时作为种子（只存在本群超管时仍会种子，避免全局超管被锁死）。
  - 说明：**不实现**按 QQ 群主/管理员自动授权——官方成员接口（返回 `member_role`）目前是内邀白名单能力，普通机器人会返回 11253。
- 全局规则：`/rules all` 查看、`/rules set all <字段> <值>` 修改（`all` 也可写作 `global` / `default` / `全局` / `默认`），仅超级管理员可用。
  - 未单独配置的群继承全局规则；已配置的群按字段覆盖（例如群覆盖了 `keywords`，仍继承全局的 `autoApprove`）。
  - 全局配置持久化在 `group_configs` / `group_keywords` 的 `__default__` 行，重启不丢。
- **关键词处罚动作**：命中关键词不再只是警告。
  - 新增 `/rules set keywordRecall on|off`（撤回）与 `/rules set keywordPunish none|mute|kick|kick_blacklist`；
  - 每个动作**尽力而为**，单个失败只记日志（带 `_failed` 后缀），不阻断其他动作；全部失败时审计状态为 `pending`；
  - 新增官方客户端 `removeGroupMember(..., { addToMemberBlacklist })` 与 `updateMemberBlacklist()`（`POST /v2/groups/{g}/member_blacklist`）。
- **入群审核规则引擎**：由「全部自动通过」升级为可配置决策。
  - `/rules set joinDecision manual|auto_approve|approve_on_match|reject_on_match|reject_on_mismatch`；
  - 规则项：`joinRequireClass`（答案必须包含班级库中的班级）、`joinRequireName`（必须包含姓名）、`joinAnswerPattern`（自定义正则）；
  - `/rules set joinReviewOpinion on|off` 控制 `/pending` 是否展示自动审核意见（识别到的班级/专业/学院/年级、缺失项、建议）；
  - 索引缺失、正则无效或规则无法判定时**一律回退人工审核**；自动决策遵循「先官方、后本地」。
- **班级 / 专业库**：`pnpm class:index` 把教务导出的 `data/class.json` 转成 `data/class-index.json`（默认保留 2022-2026 级，`CLASS_INDEX_YEARS` 可调）。
  - 新增 `MemberRoster`（班级/专业/姓名解析）与 `JoinRuleEvaluator`；
  - 原始数据与生成的索引都在 `.gitignore` 中，不会提交到仓库。
- **群扩展配置持久化**：新增 `group_settings` 键值表（`group_id` + `setting_key` + `setting_value`），承载 `keywordRecall` / `keywordPunish` / `joinDecision` / `joinRequireClass` / `joinRequireName` / `joinAnswerPattern` / `joinReviewOpinion`。
  - 与 `group_configs` 的列式字段分开存：新增扩展字段只需写键值表，**无需 ALTER TABLE**；SQLite 与 PostgreSQL 通用；
  - `GroupConfigStore.persistGroupOverride` 只在该群的 SQL 列字段变化时更新 `group_configs`，扩展字段单独写 `group_settings`。
- **入群申请推送（卡片 + 快捷同意/拒绝）**：`/notify` 让能审批的人在私聊里接收待审批申请。
  - `/notify on|off`（群内=本群、私信=全部群）、`/notify all on|off`、`/notify <group_openid|群号> on|off`、`/notify test`；
  - 推送内容为 **Markdown 消息 + 内嵌指令按钮**（官方结构化卡片只收不发）；「同意 / 拒绝」按钮等于发送 `/approve`、`/reject` 指令并带二次确认，权限校验与手动输入完全一致；
  - 自定义按钮是官方**内邀白名单**能力：首次被拒后自动降级为纯 Markdown，再失败降级为纯文本（仍带完整指令）；
  - 只推送仍需人工处理的申请；同一 (群, 申请, 人) 只推一次；
  - 新增 `notification_subscriptions`（订阅）与 `notification_deliveries`（投递去重）两张表，均随数据保留策略清理；
  - `instrumentQQOfficialAPI` 修复为透传富消息 `options`、`removeGroupMember` 的 `addToMemberBlacklist`，并补上 `updateMemberBlacklist` 的调试包装。
- **推送卡片增加预设拒绝原因**：拒绝按钮统一红色（官方样式 `3` 白底红字），第二行新增两个一键拒因：
  - 「拒绝：回答错误」→ `/reject <group> <id> 请正确回答问题。`
  - 「拒绝：班级姓名」→ `/reject <group> <id> 请回答正确的班级姓名（如：环工2214小明）。`
  - 卡片正文简化为「请审核：点击下方按钮。」并额外展示**申请 ID**（有按钮时不再堆完整指令）；按钮不可用时正文会列出全部指令与预设拒因。

- **`/testat`：@ 渲染真机自检（仅全局超管，群里执行）**：`/testat` 依次发 3 条（纯文本 @、
  Markdown 首行 @、Markdown 正文中间 @），`/testat all` 再多发 5 条 @全体候选写法
  （`@everyone` / `<@!all>` / `<@!everyone>` / 纯文字 / 纯文本，按钮带二次确认）。
  **真机实测结论：Markdown 卡片里的 `<@!openid>` 生效，纯文本 `content` 里的 `<@!openid>`
  与 `@everyone` 都不生效** —— 官方「内嵌格式只在 content 生效」的说法在群聊 Markdown 上不成立，
  项目内所有 @ 反馈因此继续使用卡片内 @；`@everyone` 的可用写法由 `/testat all` 判定。
  为此新增 `RichMessageSender.sendPlainToGroup()/sendPlainToUser()`（纯文本通道，作对照与兜底）。
### 已知限制

- **无法自动修改群成员昵称/群名片**：官方开放平台「群聊管理」接口中没有该能力，已核对接口列表。入群审核识别到的「班级+姓名」会展示在 `/pending` 审核意见与日志中，供人工改名；若官方后续开放该接口，可在 `JoinRuleEvaluator` 输出之上直接接入。

### 变更

- **`/whois` 结果改为只走私信**（隐私优先）：群里发指令时结果私信给操作人，群里只回一张
  「已私信发送」的提示卡；私信发送失败只提示「先私聊机器人再试」，**绝不在群里降级显示结果**；
  权限不足/用法/未找到映射这类不含隐私的提示仍在原处回。群内可用 `@` 指定目标
  （`/whois <@对方>`、`/whois profile <@对方>`，走官方 at 段；`@昵称` 无法反查会给出提示）。
  私聊里发指令仍是直接回复。
- **短码只使用数字 + 大写字母**：字符表从 62 位（含小写）改为 36 位（`0-9A-Z`），
  `short_codes` 与活动短码（`activity_details.code`）同时生效；**启动时把库中所有含小写的旧短码
  重生成**为大写并写回数据库（旧短码随即失效，需重新获取）；手输短码仍大小写不敏感。
- **个人资料年级统一两位**：`/profile set year` 只接受 `22`/`23`/… 四位完整年份（`2022`）直接报错；
  班级库里的四位年份写入时自动转两位；启动时历史 `user_profiles.year` 的四位值会收敛成两位并写回；
  活动 `allowYears` 的输入同样只接受两位（历史四位配置仍能匹配）。
- **文档示例不再使用真实标识**：README 里的真实 QQ号 / 群号 / group_openid / user_openid 一律换成
  明显占位的假值（`10001`、`654321`、`123456789`、`0123456789ABCDEF0123456789ABCDEF`），并新增仓库级守卫测试
  `test/privacyGuard.test.ts` 防止再次写回。**守卫测试自身不保存任何真实值**（连片段都不存）：只按形状规则
  （9-12 位未登记数字、32 位十六进制 / 截断 openid）加占位符白名单判断；需要按精确值兜底时用本地环境变量
  `PRIVACY_GUARD_IDS=<值1>,<值2>`（真实值只放本地，不进仓库）。
- **回调反馈改为 @ 操作人**：不再内联「操作人：<QQ号>」，群内回复在开头**单独一行** @ 点击者
  （`<@!userId>` 提及），私聊不 @（操作人就是接收者本人）；
- **非 help 卡片不再罗列手动指令**：`手动指令 / 手动等价指令` 页脚全部移除，手动指令统一在
  `/help`（及主题）里查；卡片只保留分页用的 `+页码` 提示；
- **`/notify test` 不再要求「可审批的群」**：没有可用群时也能发一张纯通道测试卡
  （全局超管在私聊里即可自检），有群时才附「查看待审批」指令按钮。
- `/whois` 不带参数时直接查当前上下文：**群聊返回当前群的映射，私聊返回你自己的映射**
  （都带绑定的群号/QQ号与短码）；带参数的行为不变，仍然只显示短码/QQ号/群号，真实系统
  id 只有 `/whois` 会展示。帮助主题与 README/CONFIGURATION 已同步。

- **新增个人资料 `/profile`**：班级/学院/姓名/学号，持久化到新表 `user_profiles`。
  - 学号必须 11 位、前两位 22-26（决定年级）；班级必须存在于 `class-index.json`，保存班级自动带出学院；学院/年级可手动覆盖；
  - `/profile`、`/profile set <字段> <值|clear>`、`/profile clear`，需要先 `/bind qq`（不要求群绑定）。
- **完成活动发布/报名/管理模块**：
  - `/activity create|set|open|close|cancel|list|info|signups` 与 `/activity join|quit`，活动短码复用随机短码（6 位，`#A7K2Q9`）；
  - 活动归属一个群（可配置展示群号），发布时在群内发 Markdown 卡片，底部「报名 / 取消报名 / 活动详情 / 报名名单」指令按钮（与入群卡片共用三级降级）；
  - 可配置链接（`link <说明=url>`，卡片渲染为 Markdown 链接）、名额、简介；
  - 报名支持学院/年级**白名单 + 黑名单**（黑名单优先，留空不限）；年级用学号前两位 22-26 判断，学院来自 `/profile`（匹配允许简称，如「环境」→「环境科学与工程学院」）；报名前要求资料完整；
  - 权限：创建/修改/开停/看名单需要群管理员及以上，**发布者本人**可管理自己发布的活动；普通成员只能报名/取消/看详情；
  - 活动扩展字段（短码/链接/限制）存新表 `activity_details`，老库升级无需 ALTER。
- **关键词豁免**：审核员及以上（`canReviewContent`）的消息不再做关键词判断——不警告、不撤回、不处罚，也不写审计，只记 debug 日志；普通成员照常。
- 新增 `/profile`、`/activity` 两个帮助主题，`/help` 列表同步展示。

- **展示标识改为随机短码**：不再暴露内部系统 id。
  - 每个 `join_request_id` / 未绑定 `user_openid` / 未绑定 `group_openid` 都会得到一个 **6 位随机短码**（形如 `#M7K2Q9`），`short_codes` 表以 `code` 为主键、`(kind, target_id)` 唯一，生成时查重、碰撞重生成，**不使用自增 ID**；
  - 大小写不敏感解析、重启复用同一短码；`/pending`、`/sync`、推送卡片、`/audit`、`/status`、`/perm list`、`/rules`、`/notify`、`/test` 全部只显示 QQ号/群号/短码；
  - 所有命令参数（`/approve`、`/reject`、`/rules set`、`/status`、`/audit`、`/perm`、`/notify` 等）都接受短码；完整 `join_request_id` 仍然兼容；
  - `/whois` 新增短码查询，成为**唯一**能看到真实系统 id 的指令（超管限定）。
- 新增群配置 `notifyAutoApproved`（`/rules set notifyAutoApproved on|off`，别名 `通知自动通过`）：机器人自动通过/拒绝的申请是否也推送给审核员。开启后推送只读卡片（显示「已自动通过/拒绝（按入群规则）」，不带审批按钮）；默认关闭，只推需要人工处理的申请。该字段同样走 `group_settings` 键值持久化。

- `GroupConfigStore.setOverride({ groupId: "__default__" })` 从抛错改为更新全局默认配置；新增 `DEFAULT_GROUP_ID` 常量与 `builtinDefault` 访问器。
- 官方调用域名从 `api.sgroup.qq.com` 迁移到 `api.bot.qq.com`（官方 2026-08-10 起统一域名）。
- `/perm list` 第一行改为「全局超级管理员」，并新增「本群超级管理员」；`/myperm` 新增全局/本群超管两行。
- 全局超级管理员在私信里发 `/rules`（不带群号）现在等价于 `/rules all`，直接查看全局默认规则。
- **用户可见输出只显示解析号**：绑定过的 QQ号/群号在 `/pending`、`/sync`、推送卡片、`/audit`、`/status`、`/test`、`/myperm`、`/perm list`、`/notify` 状态、`/rules` 标题与 `/bind` 成功回复里都只显示 QQ号/群号，不再暴露内部 `userId`/`group_openid`；未绑定才回退显示内部 id。`/whois` 保持同时显示两边（它本身就是映射查询），卡片纯文本降级里的指令也改用群号（`/approve 654321 <申请ID>`）。

### 修复

- **回调翻页真机问题（两处）**：
  - 群聊里**不能**把 interaction id 当 `msg_id` 发被动消息，官方返回
    `400 请求参数msg_id无效或越权`（互动事件文档虽写「id 用于被动消息发送」）。
    之前会先试被动再重试，用户要等十几秒；现在回包后直接主动发送新的一页，
    与「回调失败自动发新卡片」的兜底行为一致。
  - `RichMessageSender` 把**被动回复失败**误判成「平台不支持自定义按钮」，
    一旦失败就永久 `keyboardDisabled`，导致第 3 页与后续 `/testmenu` 卡片全部丢按钮。
    现在只有「主动发送也带不上按钮」才判定平台不支持，被动失败不再污染键盘状态。

- **`@机器人` 发指令收不到回复**：`@机器人 /menu` 之前会被当成普通消息送进关键词审核，
  而不是指令分发（`@机器人` 不带内容也识别不出「空内容 → 主菜单」）。
  现在按官方实际字段格式剥离**开头连续**的提及与不可见字符：
  `<@!appid>` / `<@id>` / `<@！id>` / 含非数字 id 的提及、昵称形式 `@机器人`，
  以及客户端插入的零宽与双向控制字符（U+200B–U+200F、U+2060–U+2064、U+2066–U+2069、U+FEFF）；
  正文里的提及与「@张三 你好」这类普通聊天不受影响。
  当出现「@ 了机器人、但剥离后既不是指令也不为空」时，会在 debug 记录提及前缀的形状
  （转义后的前 16 个码点，不写库、不写审计），便于现场定位新格式。

- **全局超管在私信里看群指令帮助被误判为权限不足**：`/help rules`、`/help approve`、`/help reject`、`/help notify` 等主题的权限判断在「私信无群上下文」分支里只查了群级角色，没把全局超管算进去；现在全局超管在私信里可以正常查看全部指令帮助。
- **规则持久化不变量**：导出 `PERSISTED_CONFIG_FIELDS` 并新增双向校验测试（`test/groupConfig.test.ts`），确保 `EffectiveGroupConfig` 的每个字段都落在 `SQL_FIELDS` 或 `SETTING_FIELDS` 中，以后新增规则字段漏加入库清单会直接测试失败。
- 新增 `test/rulesPersistence.test.ts`：逐字段跑 `/rules set`（含全局 `all`），重新装配 `GroupConfigStore` 后校验全部字段从数据库恢复；覆盖「只有扩展字段的群」与「全局规则按字段继承」。
- 修复入群推送卡片正文被截断（「请审核」之后的指令提示丢失）导致纯 Markdown 卡片看不到 `/approve` 指令的问题。
- **修复入群申请的「回答」显示为（未填写）**：官方 `GROUP_JOIN_REQUEST` 的入群验证有两种方式，答案字段不同——`verify_info.method = verify_message` 时在 `verify_message`，`admin_review_qa`（管理员设置问题）时在 `verify_info.review_qa_list[].answer`。事件映射器之前只读 `verify_message`，问答式入群一律拿不到答案，卡片显示「回答：（未填写）」、班级+姓名规则也无法识别。现在两种方式都会提取答案（多个答案用空格拼接），并带上官方 `username`（昵称）、`method`、`apply_source` 与问题文本。
  - 卡片新增「申请人（昵称）」「入群问题」两行；`/pending` 的「理由」就是提取出的答案；
  - 映射器在拿不到答案时 debug 记录字段结构（`method` / `applySource` / `verifyKeys` / `qaCount`，不打印答案原文），便于字段变更时排查。

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
