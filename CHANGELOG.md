# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

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

### 已知限制

- **无法自动修改群成员昵称/群名片**：官方开放平台「群聊管理」接口中没有该能力，已核对接口列表。入群审核识别到的「班级+姓名」会展示在 `/pending` 审核意见与日志中，供人工改名；若官方后续开放该接口，可在 `JoinRuleEvaluator` 输出之上直接接入。

### 变更

- `GroupConfigStore.setOverride({ groupId: "__default__" })` 从抛错改为更新全局默认配置；新增 `DEFAULT_GROUP_ID` 常量与 `builtinDefault` 访问器。
- 官方调用域名从 `api.sgroup.qq.com` 迁移到 `api.bot.qq.com`（官方 2026-08-10 起统一域名）。
- `/perm list` 第一行改为「全局超级管理员」，并新增「本群超级管理员」；`/myperm` 新增全局/本群超管两行。
- 全局超级管理员在私信里发 `/rules`（不带群号）现在等价于 `/rules all`，直接查看全局默认规则。
- **用户可见输出只显示解析号**：绑定过的 QQ号/群号在 `/pending`、`/sync`、推送卡片、`/audit`、`/status`、`/test`、`/myperm`、`/perm list`、`/notify` 状态、`/rules` 标题与 `/bind` 成功回复里都只显示 QQ号/群号，不再暴露内部 `userId`/`group_openid`；未绑定才回退显示内部 id。`/whois` 保持同时显示两边（它本身就是映射查询），卡片纯文本降级里的指令也改用群号（`/approve 654321 <申请ID>`）。

### 修复

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
