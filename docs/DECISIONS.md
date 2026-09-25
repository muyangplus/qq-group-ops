# 关键决策（Decisions / ADR）

本文件记录关键技术决策。新增决策请使用 ADR 格式追加。

> 架构总览见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 目录

- ADR-0001：仅使用 QQ 官方开放平台 API
- ADR-0002：Node.js + TypeScript + 自研轻量核心
- ADR-0003：数据库选型
- ADR-0004：事件接入与官方 REST 调用分层
- ADR-0005：默认不保存消息原文
- ADR-0006：项目名使用 `qq-group-ops`
- ADR-0007：活动报名与信息导出作为独立运营能力
- ADR-0008：使用 Apache-2.0 许可证
- ADR-0009：从 Python 重置为 Node.js / TypeScript
- ADR-0010：移除 Phase 0 CLI，改为 `/test` 指令
- ADR-0011：结构化日志与接口调试包装
- ADR-0012：权限自助查询与超管运行时配置
- ADR-0014：权限配置使用官方 userId
- ADR-0015：指令支持私信
- ADR-0016：全量消息模式诊断
- ADR-0017：维护 OpenID ↔ QQ号/群号映射
- ADR-0018：强制绑定 QQ 号和群号后才能使用
- ADR-0019：`/help` 只显示有权限执行的命令
- ADR-0013：支持群聊非 @ 指令识别
- ADR-0020：绑定关系持久化到 PostgreSQL
- ADR-0021：全部状态写穿透持久化
- ADR-0022：默认数据库使用 SQLite
- ADR-0023：限流防护与 access token / 网关地址缓存
- ADR-0024：打通审批闭环与群配置驱动的审核
- ADR-0025：按官方文档核对禁言 / 踢人 / 入群审批请求体
- ADR-0026：数据保留清理真正生效
- ADR-0027：被动回复配额与事件处理容错
- ADR-0028：全局规则使用 `__default__` 行复用群配置存储
- ADR-0029：权限分为全局超管与本群超管，且不做 QQ 角色自动映射
- ADR-0030：官方调用域名迁移到 api.bot.qq.com
- ADR-0031：群扩展配置使用 `group_settings` 键值表，而不是给 `group_configs` 加列
- ADR-0032：入群审核从「自动通过开关」升级为规则 + 决策模式
- ADR-0033：不实现「入群后自动修改群昵称」（官方无该接口）
- ADR-0034：入群申请推送用「Markdown + 指令按钮」，订阅粒度到群，接收人按审批权限过滤
- ADR-0035：规则配置必须全部可持久化，并由测试守住这条不变量
- ADR-0036：用随机 Base62 短码替代系统 id 展示，`/whois` 是唯一还原入口
- ADR-0037：个人资料、活动模块与关键词豁免
- ADR-0038：班级数据一次加工成 JSON + SQLite，别名表全局且仅超管可维护
- ADR-0039：短码去小写、`/whois` 结果只走私信、年级统一两位、仓库不出现真实标识
- ADR-0040：活动卡片改回调驱动 + 按群订阅推送（§B2）
- ADR-0040 补充：统计图片 / 富媒体上传 / CSV 导出（§B3）
- ADR-0040 补充：群内静默 + 多群绑定 + 满员广播（§B4）
- ADR-0041：规则菜单重构 + 字段级继承 / 恢复（§C）

---

## ADR-0001：仅使用 QQ 官方开放平台 API

- 状态：已采纳
- 背景：项目需要群管理、审核和长期维护。
- 决策：只使用 QQ 官方开放平台 API 和官方 SDK/适配器。
- 理由：合规性、稳定性、账号安全、长期可维护性。
- 影响：部分能力受官方接口限制；官方能力必须先验证。
- 备选：个人号协议端（已明确排除）。

## ADR-0002：Node.js + TypeScript + 自研轻量核心

- 状态：已采纳
- 背景：需要事件接入、自定义审核流程和未来 Web 管理后台。
- 决策：使用 Node.js 20.11+、TypeScript、pnpm、Vitest、自研轻量核心。
- 理由：TypeScript 类型安全，Node.js 生态活跃；自研核心便于测试和长期维护。
- 影响：官方 WebSocket/Webhook 网关需要自行实现或后续接入合适的 Node.js 适配器。
- 备选：Koishi、Zhin.js 等 Node.js 机器人框架。

## ADR-0003：数据库选型

- 状态：已采纳（ADR-0022 修订）
- 背景：需要保存多群配置、审核记录、操作日志和统计。
- 决策：默认使用 SQLite（单文件，零配置）；数据量大或多实例部署时切换 PostgreSQL 16。
- 理由：默认零依赖即可跑起来；PostgreSQL 提供事务、JSON、索引和成熟生态。
- 影响：两种数据库共用同一套仓储 SQL（见 ADR-0022）；切换数据库不会自动迁移历史数据。

## ADR-0004：事件接入与官方 REST 调用分层

- 状态：已采纳
- 背景：官方事件接入和群管理 REST 接口需要分开处理。
- 决策：官方 REST 调用放在 `src/adapters/qqOfficial.ts`；事件网关后续单独实现。
- 理由：职责清晰，便于测试替换和错误处理。
- 影响：需要维护鉴权、重试、频率限制和错误码映射。

## ADR-0005：默认不保存消息原文

- 状态：已采纳
- 背景：群聊消息可能包含个人信息甚至敏感个人信息。
- 决策：默认 `RAW_MESSAGE_RETENTION_DAYS=0`；需要时短期保存并自动删除。
- 理由：数据最小化，降低合规和安全风险。
- 影响：原文追溯能力受限；审计日志只保留结构化信息。

## ADR-0006：项目名使用 `qq-group-ops`

- 状态：已采纳
- 背景：需要一个清晰的开源项目名，覆盖群管理、审核、活动报名和信息导出。
- 决策：仓库名使用 `qq-group-ops`，npm 包名使用 `qq-group-ops`。
- 理由：名称直观、简短，适合作为 QQ 群管理与运营平台。
- 影响：对外文档、包名和部署配置均使用该名称。

## ADR-0007：活动报名与信息导出作为独立运营能力

- 状态：已采纳
- 背景：项目最终还要服务于活动报名和信息导出需求。
- 决策：活动报名与导出逻辑独立于群管和审核服务，共享用户/群标识但单独授权。
- 理由：活动数据和导出属于高风险操作，权限、审计和合规要求不同。
- 影响：需要额外权限控制、数据脱敏、导出审计和保留期限管理；官方 API 若不提供群成员列表，活动报名改为“用户主动报名”模式。

## ADR-0008：使用 Apache-2.0 许可证

- 状态：已采纳
- 背景：项目需要明确的开源许可证，允许商业使用、修改和再分发。
- 决策：使用 Apache License 2.0。
- 理由：Apache-2.0 提供明确的专利授权、免责条款和再分发条件，适合开源基础设施项目。
- 影响：贡献者默认同意以 Apache-2.0 发布贡献；第三方使用时需保留许可证和版权声明。

## ADR-0009：从 Python 重置为 Node.js / TypeScript

- 状态：已采纳
- 背景：项目决定统一使用 Node.js 生态。
- 决策：移除 Python 实现，使用 Node.js + TypeScript + pnpm + Vitest 重写核心服务。
- 理由：统一技术栈，便于长期维护和与 Node.js 生态集成。
- 影响：Python 版本的提交仍保留在 Git 历史中；当前 `main` 分支以 Node.js 版本为准。

## ADR-0010：移除 Phase 0 CLI，改为 `/test` 指令

- 状态：已采纳
- 背景：Phase 0 CLI 需要额外的 group_openid 配置，且不能在真实 QQ 会话中直接验证消息链路。
- 决策：删除 Phase 0 CLI、警告和专属文档；在机器人内置 `/test` 自检指令。
- 理由：`/test` 直接在真实 QQ 群中验证机器人响应、权限和消息链路，流程更自然。
- 影响：不再需要 `QQ_BOT_TEST_GROUP_ID` 和 `PHASE0_SEND_TEST_MESSAGE` 环境变量；`docs/PHASE-0-VERIFICATION.md` 已删除。

## ADR-0011：结构化日志与接口调试包装

- 状态：已采纳
- 背景：需要完整 debug 日志，并覆盖所有已实现接口。
- 决策：实现可复用 Logger 组件，支持控制台和文件传输；通过 instrumentation 代理为官方 API、HTTP、数据库、事件网关统一记录调试信息。
- 理由：模块化、低侵入、组件复用，避免在每个方法里重复手写日志。
- 影响：`pnpm dev` 默认使用 `debug` 级别并写入 `logs/qq-group-ops.log`；控制台支持 `LOG_COLOR=auto/always/never` 彩色策略；token、secret、消息原文等敏感信息不写入日志。

## ADR-0012：权限自助查询与超管运行时配置

- 状态：已采纳
- 背景：用户需要查询自己的权限，超级管理员需要动态调整管理员和审核员。
- 决策：`PermissionService` 改为运行时可变；新增 `/myperm` 查询指令和 `/perm` 超管配置指令；`ADMIN_USER_IDS` 作为初始超级管理员种子。
- 理由：不依赖数据库即可完成权限管理和验证；结构清晰，便于后续接入 PostgreSQL 仓储。
- 影响：未配置数据库时权限变更保存在内存中，进程重启后恢复为 `ADMIN_USER_IDS`；配置数据库后由 ADR-0021 持久化。

## ADR-0014：权限配置使用官方 userId

- 状态：已采纳
- 背景：官方事件中的用户标识是 OpenID / member_openid，不是 QQ 号。
- 决策：`ADMIN_USER_IDS` 作为主配置，`ADMIN_QQ_IDS` 作为兼容别名；用户通过 `/bind qq <QQ号>` 建立 QQ 号与 userId 的映射。
- 理由：避免用户误填 QQ 号；绑定后可以直接用 QQ 号配置权限。
- 影响：配置模板和文档改用 `ADMIN_USER_IDS`；旧变量仍可读取。

## ADR-0015：指令支持私信

- 状态：已采纳
- 背景：用户希望能在私聊中使用机器人指令。
- 决策：事件映射支持 `C2C_MESSAGE_CREATE`；`EventRouter` 支持 `private_message`；命令回复通过 `sendPrivateMessage` 发送；群管理指令在私信中需要提供 `group_openid` 或已绑定群号。
- 理由：私信适合自助绑定、权限查询和超管配置；群管理操作仍明确绑定到具体群。
- 影响：新增 `POST /v2/users/{user_openid}/messages` 调用；私信回复使用被动消息 `msg_id`。

## ADR-0016：全量消息模式诊断

- 状态：已采纳
- 背景：用户反馈群内非 @ 消息没有响应，但代码侧无法直接影响官方“接收所有消息”开关。
- 决策：监听 `GROUP_MSG_RECEIVE` / `GROUP_MSG_REJECT`，在 `GroupMessageModeRegistry` 中记录每个群的全量消息模式，并在 `/status` 中显示。
- 理由：帮助用户快速区分“平台未开启”和“代码未处理”两类问题。
- 影响：`/status` 增加 `全量消息模式：all | at_only | unknown`。

## ADR-0017：维护 OpenID ↔ QQ号/群号映射

- 状态：已采纳
- 背景：官方事件只提供加密 OpenID，无法直接从 QQ 号或群号换算。
- 决策：新增 `IdentityMapService`，并提供 `/bind` 系列指令维护映射；权限和群管理命令在接收参数时自动解析 QQ号/群号。
- 理由：管理员可以继续用熟悉的 QQ号/群号操作，同时底层仍使用官方 OpenID 调用 API。
- 影响：映射默认只保存在内存中；配置 `DATABASE_URL` 后由 ADR-0020 提供 PostgreSQL 持久化。

## ADR-0018：强制绑定 QQ 号和群号后才能使用

- 状态：已采纳
- 背景：需要确保命令参数能稳定解析到官方 OpenID，并避免匿名使用管理能力。
- 决策：除 `/help`、`/bind` 外，用户必须绑定 QQ 号，群聊必须绑定群号；私信群管理命令要求目标群已绑定。
- 理由：强制绑定可以保证用户和群身份可追踪，QQ号/群号参数可正确解析。
- 影响：首次使用需要先执行 `/bind qq <QQ号>`；群号需要在群内由群管理员执行 `/bind group <群号>` 绑定。

## ADR-0019：`/help` 只显示有权限执行的命令

- 状态：已采纳
- 背景：静态帮助会暴露用户无法执行的命令，容易造成误用和困惑。
- 决策：根据用户绑定状态、群绑定状态和权限级别动态生成 `/help` 内容。
- 理由：用户只看到自己能用的命令，降低误操作和权限困惑。
- 影响：未绑定用户只看到绑定相关帮助；未绑定群只看到群绑定帮助；不同权限级别看到不同命令集合。

## ADR-0013：支持群聊非 @ 指令识别

- 状态：已采纳
- 背景：用户希望在群内不 @ 机器人也能识别 `/` 指令。
- 决策：复用 `GROUP_AND_C2C_EVENT` intent，同时处理 `GROUP_AT_MESSAGE_CREATE` 和 `GROUP_MESSAGE_CREATE`；由群管理员在机器人资料页开启“接收所有消息”。
- 理由：官方已提供群消息全量模式，代码侧无需额外协议分支。
- 影响：开启前只有 @ 消息会触发；开启后非 @ 的 `/` 指令也会被识别和处理。

## ADR-0020：绑定关系持久化到 PostgreSQL

- 状态：已采纳
- 背景：`/bind` 维护的 OpenID ↔ QQ号/群号映射原本只存在内存中，进程重启后丢失，用户需要反复重新绑定。
- 决策：新增 `identity_bindings` 表与 `PostgresIdentityBindingRepository`；`IdentityMapService` 改为「内存缓存 + 写穿透」，启动时 `reload()` 载入全部绑定，写入失败时回滚内存并返回错误；`DATABASE_URL` 未配置时退化为纯内存模式并输出警告，已配置但连接失败则启动失败（避免静默降级）。
- 理由：读取路径保持同步，不阻塞事件处理；写路径显式 `await`，保证用户看到“已绑定”时数据确已落库；表结构使用 `(kind, official_id)` 主键和 `(kind, external_id)` 唯一索引，保证一一映射。
- 影响：`AdminCommandService.handle` 变为 `async`；`/bind` 会等待写库完成并反馈明确结果；其余状态由 ADR-0021 统一持久化。

## ADR-0021：全部状态写穿透持久化

- 状态：已采纳
- 背景：除绑定关系外，权限配置、审计日志、入群申请、群配置、全量消息模式、活动报名此前都只存在内存中，重启即丢失。
- 决策：新增统一 `WriteQueue`（顺序写穿透队列），所有持久化服务采用「内存为准 + 写穿透」：
  - 启动时 `runtime.load()` 从数据库全量载入到内存缓存；
  - 同步 API 保持不变（读走内存），写操作同步更新内存并进入 `WriteQueue` 串行落库；
  - `gatewayRunner` 在处理完每个事件、回复用户前 `await runtime.flush()`；进程退出（SIGINT/SIGTERM）前同样 flush；
  - 单个写入失败只记录错误日志并计数，不会中断后续写入；
  - `ADMIN_USER_IDS` 只在数据库中不存在任何超级管理员时作为种子写入，之后以数据库为准。
- 理由：不改变各服务已有的同步 API 与测试边界，同时保证「回复用户前已落库」；`WriteQueue` 是单一可复用组件，所有服务共享同一实例。
- 影响：
  - 新增表：`permission_grants`、`group_message_modes`、`activities`、`activity_registrations`；
  - 新增仓储：`PermissionRepository`、`GroupMessageModeRepository`、`ActivityRepository`，并为审计 / 入群申请 / 群配置仓储补充 `findAll()`；
  - 启动时会把审计、入群申请等数据全量载入内存，超大历史数据需要配合保留策略（见 `DATA-COMPLIANCE.md`）；
  - 具体存储后端由 ADR-0022 决定：默认 SQLite，可切换 PostgreSQL 或纯内存模式。

## ADR-0022：默认数据库使用 SQLite

- 状态：已采纳
- 背景：PostgreSQL 需要额外部署，默认配置下 `pnpm dev` 无法直接启动；QQ 群管理机器人的状态量（绑定、权限、配置、审核记录）通常很小，单文件数据库足够。
- 决策：默认使用 Node.js 24 内置的 `node:sqlite`，数据文件默认 `data/qq-group-ops.db`（`SQLITE_PATH` 可覆盖）；`DATABASE_URL` 以 `postgres://` 开头时切换到 PostgreSQL；`DATABASE_URL=memory` 时使用纯内存模式。
- 理由：零额外依赖、零配置即可持久化；SQLite 同步 API 与写穿透队列天然契合；避免为小规模部署维护数据库服务。
- 实现：仓储 SQL 统一使用 PostgreSQL 风格（`$1` 占位符、`ON CONFLICT ... DO UPDATE`），由 `SqliteQueryable` 负责方言转换：
  - `$n` → `?`（支持同一参数重复出现）；
  - `TIMESTAMPTZ` → `TEXT`、`BOOLEAN` → `INTEGER`、`NOW()` → `CURRENT_TIMESTAMP`、去除 `::type` 显式转换；
  - 绑定参数时把 `boolean` / `Date` / `undefined` 归一化为 SQLite 可接受的值；
  - 读取时把 SQLite 的 0/1 还原为 `boolean`。
- 影响：
  - `engines.node` 提升到 `>=24.0.0`（`node:sqlite` 无需实验开关的最低版本）；Docker 基础镜像改为 `node:24-slim`；
  - `node:sqlite` 通过动态导入加载，在更早的 Node.js 上仍可使用 PostgreSQL / 内存模式；
  - `pg` 只在 PostgreSQL 模式下动态导入；
  - SQLite 是单写入者模型，适合单进程部署；多实例或高并发场景请使用 PostgreSQL。

## ADR-0023：限流防护与 access token / 网关地址缓存

- 状态：已采纳
- 背景：实际运行中出现 `400 接口调用超过频率限制`（`err_code` 100017 / 40023001）。日志显示每次进程启动都会重新请求 `/gateway` 和 access token，而 `tsx watch` 重启会在数秒内连续触发，直接打满官方严格限频的 `/gateway`。
- 决策：
  1. **access token 持久化缓存**：`QQOfficialClient` 优先复用内存 token，其次读取磁盘缓存（`QQ_BOT_CACHE_FILE`，默认 `data/qq-bot-cache.json`），仅在缺失或临近过期（默认提前 60 秒）时才重新获取；并发请求用同一个 in-flight Promise 去重。
  2. **网关地址缓存**：`/gateway` 返回的地址同样缓存到内存与磁盘；重连默认完全不请求 `/gateway`。
  3. **限流识别与冷却**：`QQOfficialAPIError` 解析 `err_code` / `code`（含 `data` 嵌套与字符串形式）与 `retry-after`，覆盖 100017 / 40023001 / 22009 和 HTTP 429；`/gateway` 命中限流后进入固定冷却（默认 60 秒），冷却期内直接失败而不发请求。
  4. **重连退避**：`QQOfficialGateway` 支持自动重连，采用指数退避 + 抖动（1s 起，上限 60s），命中限流时改用长冷却（默认 120s）；只有「从未成功 open 过且连续失败达到阈值」才会丢弃缓存的网关地址，避免抖动引发 `/gateway` 风暴。
  5. **出站消息节流**：`SendThrottle` 把所有消息发送串行化并强制最小间隔（默认 400ms），命中 22009 后按固定冷却重试（默认 5 秒，最多 3 次）。
  6. **401 自动刷新**：服务端返回 401 时，若 token 不是由 `QQ_BOT_TOKEN` 显式指定，则作废缓存并刷新后重试一次。
- 理由：官方 `/gateway` 限频极严格（实测约每个窗口 2 次），重连风暴是不可恢复的死循环；缓存 + 退避 + 冷却能从根上避免。token 有效期约 2 小时，持久化后重启不再重复换取。
- 影响：
  - 新增 `src/core/retry.ts`、`src/adapters/botCache.ts`、`src/adapters/sendThrottle.ts`、`src/adapters/qqOfficialError.ts`；
  - 新增环境变量 `QQ_BOT_CACHE_FILE`（留空 = 仅内存缓存）；缓存文件含 access token，属于机密文件，已加入 `.gitignore`；
  - `QQOfficialClientOptions` 新增 `cacheStore` / `clock` / `tokenRefreshMarginMs` / `rateLimitCooldownMs` / `sendThrottle`；
  - `QQOfficialGateway` 新增 `reconnect` / `random` / `onReconnect` 选项；
  - 配置了 `QQ_BOT_TOKEN` 时以人工配置为准，不自动刷新（需运维自行更新）。

## ADR-0024：打通审批闭环与群配置驱动的审核

- 状态：已采纳
- 背景：阶段 A 排查发现四处「代码已实现但没有接线」：`/approve`、`/reject` 只改本地状态不调用官方审批接口；`JoinRequestSyncService` 从未被实例化；`MessageGuardService` 用空规则引擎导致关键词过滤实际是空转；群规则只能读不能写、审计日志无法查询。
- 决策：
  1. **审批先官方后本地**：新增 `JoinApprovalService`，先调用官方 `approval_join_request`，成功后再更新本地状态与审计；官方失败时本地保持 `pending`，避免「机器人说已通过、群里其实没通过」。
  2. **自动通过**：`autoApproveJoin` 生效，入群事件到达时由 `EventRouter` 调用官方接口自动审批，失败只记日志并留在待审批队列。
  3. **群配置关键词驱动审核**：`MessageGuardService` 按群把 `config.keywords` 转成规则（`RuleEngine.fromKeywords`），与静态规则合并后使用；按群缓存引擎，关键词变化时自动失效。关键词命中默认动作为警告，文案取该群 `warningMessage`。
  4. **`/rules set`**：支持 `keywords|warning|muteDuration|wordFilter|joinAudit|autoApprove|export|enabled`；`GroupConfigStore.setOverride` 改为**合并**局部覆盖，避免设置一个字段把其他字段重置。
  5. **`/audit [数量]`**：审核员及以上可按群查看最近审计记录。
  6. **`/sync`**：审核员及以上可从官方接口补齐待审批申请，按群节流（默认 30 秒），并给出冷却提示。
- 理由：审批闭环是 MVP 的退出条件；关键词过滤是内容审核的核心能力，空转等于没有审核；群配置已经持久化，缺少写入口就无法真正使用。
- 影响：
  - `AdminCommandService` 改为接收 options 对象（参数已达 7 个），并新增 `joinSync` 依赖；
  - 新增 `src/services/joinApproval.ts`，`joinAuditSync.ts` 增加节流与统计；
  - `/help` 对群管理员展示 `/rules set`，对审核员展示 `/audit`、`/sync`；
  - 官方 `approval_join_request` 的请求体仍需在真实群验证（见「待验证的架构风险」）。

## ADR-0025：按官方文档核对禁言 / 踢人 / 入群审批请求体

- 状态：已采纳
- 背景：阶段 B 需要启用此前抛错占位的禁言与踢人能力；同时核对发现阶段 A 实现的入群审批请求体与官方文档不一致（原来发送 `{ approve, reason }`）。
- 决策：以官方 API 文档（`bot.q.qq.com/wiki/develop/api-v2`）为准重写三个接口：
  1. **禁言** `POST /v2/groups/{group_openid}/restrict_chat_setting`
     请求体 `{ members: [{ op, member_openid, mute_expire_at }] }`；`op` 取 `add` / `update` / `del`，`mute_expire_at` 为 RFC3339 到期时间。`durationSeconds <= 0` 时使用 `op=del` + 空字符串立即解除禁言；`mute_expire_at` 由 `clock() + duration` 生成，最长 30 天（超出自动截断）。接口限频 60 QPM，单次最多 20 个成员。
  2. **踢人** `POST /v2/groups/{group_openid}/batch_remove_members`
     请求体 `{ member_openids: [...] }`（可选 `add_to_member_blacklist`）。**该接口仅白名单机器人可用**，未开通时返回错误码 11253，需要在文档中明确提示。
  3. **入群审批** `POST /v2/groups/{group_openid}/approval_join_request/{member_openid}`
     请求体 `{ op: "approve" | "decline", join_request_id?, reject_reason?, add_to_member_blacklist? }`；拒绝理由字段是 `reject_reason` 而不是 `reason`，且 `join_request_id` 应携带（本地用事件里的 `join_request_id`）。
  4. **入群申请列表** `GET .../join_request_list` 返回 `{ list, next_cursor }`，客户端改为自动跟随游标翻页（上限 5 页），并兼容 `{ data }` 与裸数组；申请字段为 `join_request_id` / `member_openid` / `verify_info.verify_message`。
- 理由：官方文档是唯一权威来源；参数名不一致会导致 400，且“审批成功但群里没通过”是最危险的静默失败。
- 影响：
  - `QQOfficialAPI.approveJoinRequest` 的第 4 个参数由 `reason?: string` 改为 `options?: ApproveJoinRequestOptions`（`reason` / `joinRequestId` / `addToMemberBlacklist`）；
  - `muteGroupMember` 与 `removeGroupMember` 不再抛错，消息审核的禁言/踢人动作真正可用；
  - `JoinRequestSyncService` 能解析官方字段，`/sync` 才真正可用（此前字段名不匹配会全部跳过）；
  - `docs/ARCHITECTURE.md` 的风险清单移除已核对项，并新增“踢人需要白名单”的说明。

## ADR-0026：数据保留清理真正生效

- 状态：已采纳
- 背景：`AUDIT_LOG_RETENTION_DAYS` / `RAW_MESSAGE_RETENTION_DAYS` 此前只是读取并打印，从未执行清理；而持久化采用「启动全量载入内存」，不清理会导致内存随历史数据无限增长，合规文档里的保留承诺也无法兑现。
- 决策：新增 `RetentionService`：
  - 启动时执行一次，之后每 24 小时执行一次（可在构造参数中调整）；
  - 审计记录早于 `AUDIT_LOG_RETENTION_DAYS` 的会被删除；
  - **已审批**的入群申请同样按该天数清理，**待审批申请永不清理**，避免丢失待处理请求；
  - 清理同时作用于内存缓存与数据库（内存先行，数据库写入进入 `WriteQueue`）；
  - `AUDIT_LOG_RETENTION_DAYS <= 0` 表示不清理；
  - `RAW_MESSAGE_RETENTION_DAYS` 目前没有可清理的数据——项目默认不保存消息原文，日志中会明确说明。
- 理由：保留策略必须由代码强制执行，否则文档承诺与实现不一致；内存缓存 + 全量载入的模式决定了必须有配套清理。
- 影响：
  - 新增 `src/services/retention.ts`、`AuditLogStore.pruneOlderThan`、`JoinAuditService.pruneReviewedOlderThan`；
  - `AuditRepository` 新增 `deleteOlderThan`，`JoinRequestRepository` 新增 `deleteReviewedOlderThan`；
  - `main.ts` 在启动时执行一次清理并在退出时停止定时器。

## ADR-0027：被动回复配额与事件处理容错

- 状态：已采纳
- 背景：官方对被动回复有硬限制——单聊同一 `msg_id` 最多回复 5 次，群聊被动回复 5 分钟有效，超限会失败（22009）；同时发现 `QQOfficialGateway` 的事件处理器如果抛错，`void this.handleMessage(payload)` 会产生未处理拒绝，回复发送失败（限流、网络抖动）就可能拖垮进程。
- 决策：
  1. 新增 `PassiveReplyQuota`：按 `msg_id` 记录回复次数与首次时间；窗口内超过 5 次或窗口已过期时，`sendGroupMessage` / `sendPrivateMessage` **在发请求前**抛出 `err_code=22009` 的错误，并记录 `passive reply quota exhausted` 日志。缓存上限 1000 条，超出淘汰最旧记录。
  2. 事件处理容错：`QQOfficialGateway` 调用事件处理器时 try/catch，失败只记录日志并触发 `onError`，连接与后续事件不受影响。
  3. 回复发送容错：`gatewayRunner` 的发送逻辑 try/catch，失败只记录日志（含 `rateLimited` 标记），不再向事件处理链抛出异常。
- 理由：被动回复配额是平台硬约束，提前拦截可以避免无效请求打满频控；事件处理器是长驻进程里最容易出现「单点异常导致整个连接不可用」的位置，必须隔离。
- 影响：
  - `QQOfficialClientOptions` 新增 `passiveReplyQuota`（传 `null` 可关闭）；
  - `gatewayRunner` 的回复发送从「直接 await」改为「容错发送」；
  - 新增测试覆盖配额计数/过期/淘汰、客户端第 6 次拒绝、事件处理器抛错不影响连接、回复失败不影响事件。

## ADR-0028：全局规则使用 `__default__` 行复用群配置存储

- 状态：已采纳
- 背景：原先 `GroupConfigStore` 的默认配置只来自构造函数（硬编码 `DEFAULT_CONFIG`），`setOverride` 明确拒绝 `__default__`，因此无法配置「所有群共享的默认规则」——多群部署时每加一个群都要重复配置一遍。
- 决策：把 `__default__` 作为合法的全局作用域，复用现有存储与合并逻辑：
  1. `DEFAULT_GROUP_ID = "__default__"` 成为公开常量，`runtime` 也使用它初始化默认配置；
  2. `setOverride({ groupId: "__default__", ... })` 不再抛错，而是把局部字段合并进**当前全局默认**；
  3. 全局修改持久化为**完整快照**（写全 `group_configs` 的所有列），避免多次局部修改在数据库里互相覆盖；
  4. `load()` 把 `__default__` 行合并回全局默认配置，其余行仍是单群覆盖；
  5. 保留 `builtinConfig`（构造函数/内置默认值），`removeOverride("__default__")` 即恢复内置默认；`builtinDefault` 供 `warning clear` 这类「恢复默认」语义使用；
  6. 指令层：`/rules all` 查看、`/rules set all <字段> <值>` 修改，`all` 的别名为 `global` / `default` / `全局` / `默认`；**仅超级管理员可用**（全局配置影响所有群，属于平台级配置）；
  7. 继承按字段进行：群覆盖了 `keywords` 就用自己的关键词，但仍继承全局的 `autoApprove` 等未覆盖字段；`listOverrides()` 不包含全局行。
- 理由：复用 `group_configs` / `group_keywords` 两张表与既有的写穿透、合并、排序逻辑，零 schema 变更即可获得全局能力；把全局配置放在 `__default__` 行也让备份/迁移与单群配置完全一致。
- 影响：
  - `GroupConfigStore` 新增 `DEFAULT_GROUP_ID`、`builtinDefault`，`default` 改为返回当前生效的全局配置；
  - 行为变更：`setOverride("__default__")` 从抛错变为生效（原有测试相应改写）；
  - 单群配置与全局配置的优先级为：群覆盖 > 全局默认 > 内置默认；
  - 全局规则的写穿透使用独立的队列标签（`group-config.default.save` / `group-config.default.keywords`），便于日志排查。

## ADR-0029：权限分为全局超管与本群超管，且不做 QQ 角色自动映射

- 状态：已采纳
- 背景：希望「群主/群管理员天然拥有该群的机器人管理权限」。核实官方文档后确认：`GET /v2/groups/{group_openid}/members`（每页 30 条、60 QPM）与 `GET /v2/groups/{group_openid}/members/{member_openid}`（30 QPM）确实返回 `member_role`（`member` / `owner` / `admin`），但两个接口都标注「该能力正在内邀接入中」，且未开通时返回 11253「应用无接口访问权限」（仅白名单机器人可用）。同时原权限模型只有「全局超级管理员」一个高层级，无法表达「只在这个群里是最高权限」。
- 决策：
  1. **拆分权限层级**：新增 `groupSuperAdminIds`（本群超级管理员）。`levelFor(userId, groupId)` 在该群内返回 `SuperAdmin`；`isSuperAdmin(userId)` 仍然只表示全局超管，平台级能力（`/perm`、`/rules all`、`/bind user|groupid`、`/whois`）继续只认它。
  2. **本群超管只在本群生效**：没有群上下文（私信）或其他群时回落为 `Guest` / `Member`，不存在跨群权限。
  3. **手工配置，不做自动映射**：不实现「按 QQ 群主/管理员自动授权」。等成员接口开放白名单后，可在此模型之上接入 `MemberRoleService` 作为角色来源，而无需改动权限层级。
  4. **复用存储**：本群超管写成 `permission_grants` 的 `scope='super_admin'` + 非空 `group_id`（全局超管为 `group_id=''`），避免修改 CHECK 约束（SQLite 无法直接改列约束，需要重建表）。
  5. **种子判定**：只有「存在 `scope='super_admin'` 且 `group_id=''`」时才算已有全局超管；数据库里只有本群超管时仍会用 `ADMIN_USER_IDS` 种子全局超管，避免把全局超管锁死。
  6. **不豁免绑定**：角色授权不会绕过「除 `/help`、`/bind` 外必须先 `/bind qq`」的强制绑定要求。
  7. 指令：`/perm grant|revoke gsuper`（别名 `groupsuper` / `群超管` / `本群超管` / `群超级管理员`）；`/perm list` 与 `/myperm` 分别展示本群超管与全局超管。
- 理由：把「平台级」与「群级」彻底分开可以避免群级管理员获得跨群能力（越权风险），同时为将来的自动映射留好接口；不依赖白名单能力也能立刻交付可用价值。
- 影响：
  - `PermissionPolicy`/`PermissionService` 新增 `groupSuperAdminIds`、`isGroupSuperAdmin`、`grantGroupSuperAdmin`、`revokeGroupSuperAdmin`、`listGroupSuperAdmins`；
  - `/myperm` 输出新增「全局超级管理员」「本群超级管理员」两行；
  - `/perm list` 第一行由「超级管理员」改为「全局超级管理员」，并新增「本群超级管理员」；
  - 私信中缺少群号时先提示「需要提供 group_openid」而不是直接给用法，减少歧义。

## ADR-0030：官方调用域名迁移到 api.bot.qq.com

- 状态：已采纳
- 背景：官方变更记录（20260810）说明「接口调用域名统一为 `api.bot.qq.com`」；项目此前使用 `https://api.sgroup.qq.com`（旧域名仍可用，日志中可见请求成功）。
- 决策：把 `DEFAULT_ENDPOINTS.baseUrl` 改为 `https://api.bot.qq.com`，同步更新测试断言与文档里的日志排查示例。token 域名 `https://bots.qq.com/app/getAppAccessToken` 不变。
- 影响：`QQOfficialClient` 默认走新域名；如需回退可用 `endpoints` 选项覆盖（测试里已有自定义 endpoints 用例）。

## ADR-0031：群扩展配置使用 `group_settings` 键值表，而不是给 `group_configs` 加列

- 状态：已采纳
- 背景：本阶段要给群规则增加 7 个字段（`keywordRecall`、`keywordPunish`、`joinDecision`、`joinRequireClass`、`joinRequireName`、`joinAnswerPattern`、`joinReviewOpinion`）。直接给 `group_configs` 加列会面临：SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，且 `group_configs` 的建表语句与方言适配层需要同步维护，回归风险高、后续每加一个字段都要改 schema。
- 决策：新增键值表 `group_settings`，`CREATE TABLE IF NOT EXISTS group_settings(group_id, setting_key, setting_value, updated_at, PRIMARY KEY(group_id, setting_key))`，承载这批扩展字段；原 `group_configs` 只保留既有列（`enabled`/`wordFilter` 等），并区分 `SETTING_FIELDS` 与 `SQL_FIELDS`：
  1. `GroupConfigStore.persistGroupOverride` 只在该群的 SQL 列字段变化时重写 `group_configs` 行；
  2. 扩展字段单独 upsert/delete 到 `group_settings`；
  3. `load()` 先读 `group_configs`，再把 `group_settings` 按 `group_id` 合并进来；
  4. 全局默认沿用 `__default__` 作为 `group_id`；
  5. `Persistence` 暴露 `groupSettings` 仓储，`SqlGroupSettingsRepository` 实现 `findAll` / `save` / `remove` / `removeAll`。
- 理由：`CREATE TABLE IF NOT EXISTS` 是幂等的，老库升级只需跑一次迁移即可新增表，**完全不需要 ALTER TABLE 或重建表**；键值表对 SQLite / PostgreSQL 语义一致；未来再加配置项只改 `SETTING_FIELDS` 与解析函数，动不到 schema。
- 影响：
  - 新增字段走 `/rules set <字段>` 与 `/rules set all <字段>` 两条路径（复用同一 key-value 写入）；
  - `/rules`、`/rules all`、`/help rules` 的输出需要同时展示 SQL 列字段与扩展字段；
  - 扩展字段的 `clear` 语义是删除该键（回到继承/默认），而不是写入空值。

## ADR-0032：入群审核从「自动通过开关」升级为规则 + 决策模式

- 状态：已采纳
- 背景：实际场景是「入群问题必须回答 班级+姓名」。原来的 `autoApprove` 只能全自动通过，无法要求答案内容，也无法在答错时拒绝或转人工；同时机器人不能修改群昵称（见 ADR-0033），至少要把识别结果结构化地提供给审核人。
- 决策：
  1. 新增 `JoinRuleEvaluator`，输入是申请回答（`verify_message`）与群配置，输出 `{matched, className, name, major, college, year, missing, configIssue?, action, opinion}`；
  2. 规则项为 `joinRequireClass`（答案必须包含班级库里的班级）、`joinRequireName`（必须包含姓名）、`joinAnswerPattern`（附加正则，保存时校验合法性）；
  3. `joinDecision` 五档：`manual`（默认）、`auto_approve`、`approve_on_match`、`reject_on_match`、`reject_on_mismatch`；旧 `autoApprove on` 保留为 `auto_approve` 的便捷别名；
  4. `JoinApprovalService.applyJoinRules` 取代 `autoApproveIfEnabled`，仍然**先官方、后本地**：官方审批失败时申请保持待审批；
  5. 索引缺失、正则无效、规则无法判定时**一律回退人工**（`configIssue` 记录原因），绝不猜测放行；
  6. `/rules set joinReviewOpinion on` 时 `/pending` 附带审核意见；`bot:auto` 作为自动决策的审核人写审计；
  7. 班级数据来自 `data/class.json` 经 `pnpm class:index` 生成的 `data/class-index.json`（`MemberRoster` 负责加载与解析），原始数据与生成索引都**不提交仓库**。`CLASS_INDEX_YEARS` 控制在读入时就过滤年级（默认 2022-2026），避免无关历史班级进入匹配集合。
- 理由：把「解析」与「决策」分开，解析结果可以同时用于审核意见、审计与未来功能；决策模式用枚举而非布尔组合，语义清晰且可测试；「先官方后本地」与「不确定就转人工」符合审核场景的安全默认。
- 影响：
  - 事件路由的 `join_request` 结果新增 `auto_approved` / `auto_rejected` / `queued`；
  - 事件映射器要同时支持两种入群验证方式：`verify_info.method = verify_message`（答案在 `verify_message`）与 `admin_review_qa`（答案在 `review_qa_list[].answer`），并把 `username` / 问题文本透传到推送卡片；
  - `AdminCommandService` 新增 `joinRules` 依赖与 `/rules` 展示、`/pending` 意见渲染；
  - 拒绝理由统一截断到 120 字符（官方限制）。

## ADR-0033：不实现「入群后自动修改群昵称」（官方无该接口）

- 状态：已采纳（受限于官方能力）
- 背景：需求希望入群审核通过后自动把群昵称改成「班级+姓名」。核对官方开放平台「群聊管理」接口列表与变更记录后确认：**没有修改群成员昵称/群名片的接口**；能改昵称的接口只作用于机器人自身资料，成员相关接口只有查询成员、禁言、移出、黑名单等（成员查询本身还是内邀白名单能力）。
- 决策：
  1. 不实现自动改昵称，也不引入任何非官方（第三方协议 / Hook）方案绕过该限制；
  2. 已识别出的班级/姓名结构化保留在 `JoinRuleEvaluator` 的输出里，通过 `/pending` 审核意见与结构化日志呈现，人工据此改名；
  3. 解析结果可继续用于审计、导出与统计；
  4. 如果官方以后开放昵称接口，只需在解析结果之上加一次 `setMemberNickname` 调用，规则层与配置层无需改动。
- 理由：项目定位是「仅用 QQ 官方 API」，为了一个非核心功能引入非官方实现会破坏可维护性与合规性；人工改名一次的成本远低于维护第三方协议栈。
- 影响：文档（README / CONFIGURATION / CHANGELOG）明确写出该限制与替代做法，避免使用者误以为配置后会自动改名片。

## ADR-0034：入群申请推送用「Markdown + 指令按钮」，订阅粒度到群，接收人按审批权限过滤

- 状态：已采纳
- 背景：需求是「审核员可订阅全部/某群的入群申请推送，有申请就推给所有审核员，推送用卡片并带快捷同意/拒绝按钮」。核实官方文档后确认：
  1. **结构化卡片（Ark）只能收、不能由机器人发送**（消息类型支持表：单聊/群聊「结构化卡片 发 ❌」）；
  2. 机器人能发的富消息是 `msg_type=0` 文本、`2` Markdown、`7` 富媒体；
  3. **自定义 Markdown 已对所有机器人开放**（2026-04-23 起，单聊/群聊无需申请模板）；**自定义按钮 `keyboard.content` 是内邀开通能力**，按钮模板也需要申请；
  4. 单聊主动消息受频控（未认证 5 qps & 30 qpm、单关系 20 qpm、每用户每天 1000 条），且用户可在 QQ 客户端关闭「允许主动发送」，关闭后主动消息必失败。
- 决策：
  1. **卡片实现为 Markdown + 内嵌键盘**：正文用 `markdown.content`，底部 `keyboard.content.rows` 放「同意 / 拒绝」按钮；
  2. 按钮用**指令按钮**（`action.type=2`）：点击即发送 `/approve <group_openid> <申请ID>` / `/reject <group_openid> <申请ID> 审核未通过`，并配 `modal` 二次确认、`permission.type=0 + specify_user_ids` 限定接收人。这样按钮与手动输入走**同一套指令与权限校验**，不新增回调面、也不可能绕过权限；
  3. **三级降级**：Markdown+按钮 → Markdown → 纯文本（都带完整指令）。按钮被平台拒绝后机器人级记住该状态，后续不再重试按钮，避免每条推送白打一次；
  4. **订阅只允许两种粒度**：`__all__`（我担任群管理员的全部群）与单个 `group_openid`，存 `notification_subscriptions`；
  5. **接收人 = 订阅了该群 + 当前群有 `canApproveJoin` 权限**；订阅时校验一次、推送时再校验一次，越权订阅不会泄漏申请内容；按用户既有决策，审核员（moderator）不获得入群审批权限，因此订阅时会提示权限不足；
  6. **只推送转人工的申请**（`applyJoinRules` 返回 `manual`），自动通过/拒绝不打扰；
  7. **投递去重持久化**：新增 `notification_deliveries`，主键 `(group_id, request_id, user_id)`；同一申请对同一人只推一次，事件重投、`/sync` 补齐、进程重启都不会重复推送；投递记录随 `AUDIT_LOG_RETENTION_DAYS` 清理；
  8. 推送失败只记日志与投递状态（`sent` / `failed` + detail），不抛错、不影响申请本身；`/notify test` 提供自检入口。
- 理由：Armor 式「卡片」在官方能力里只有 Markdown+键盘这一条路可走；指令按钮复用既有命令体系，是最小惊讶、最少新代码、最安全的方案；三级降级保证没开通按钮白名单的部署也能用；去重表避免主动消息配额被浪费。
- 影响：
  - 新增 `src/services/notifications.ts`、`src/services/joinRequestCard.ts`、`src/db/notificationRepository.ts` 与两张表；
  - `QQOfficialAPI.sendGroupMessage/sendPrivateMessage` 新增可选 `RichMessageOptions`（Markdown + keyboard），并新增按钮/弹窗类型定义；
  - **修复 `instrumentQQOfficialAPI` 之前丢弃可选参数的缺陷**：`sendGroupMessage` / `sendPrivateMessage` 现在透传富消息 options，`removeGroupMember` 透传 `addToMemberBlacklist`，并补上 `updateMemberBlacklist` 调试包装（此前 `kick_blacklist` 经运行时装配后会退化成普通移出）；
  - `/notify` 加入 `/help` 与 `/help notify` 主题；`RetentionService` 增加推送投递清理；
  - 卡片按钮第一行是「同意 / 拒绝」，第二行是**预设拒因**（红色，官方样式 `3` 白底红字）：`拒绝：回答错误` → `请正确回答问题。`，`拒绝：班级姓名` → `请回答正确的班级姓名（如：环工2214小明）。`；点击后把固定文案作为官方 `reject_reason` 提交，按钮不可用时同样的指令会写进正文。

## ADR-0035：规则配置必须全部可持久化，并由测试守住这条不变量

- 状态：已采纳
- 背景：规则字段是逐批加出来的：先是 `group_configs` 的列式字段，后是 `group_settings` 键值字段。只要有人新增一个字段却忘了加入持久化清单，它就会在内存里生效、重启后静默丢失——这类 bug 不会报错，只会让管理员以为配置没保存，排查成本高。另外还有两处相关缺陷：`main.ts` 曾经漏传 `groupSettings` 仓储，导致扩展字段在真实运行时根本没落库；全局超级管理员在私信里查看 `/help rules` 会被误判为「权限不足」。
- 决策：
  1. **不变量**：`EffectiveGroupConfig` 的每个字段都必须出现在 `SQL_FIELDS`（写 `group_configs` 列）或 `SETTING_FIELDS`（写 `group_settings` 键值）中；
  2. 导出 `PERSISTED_CONFIG_FIELDS = [...SQL_FIELDS, ...SETTING_FIELDS]`，并在 `test/groupConfig.test.ts` 做**双向**校验：生效字段 ⊆ 可持久化字段，且可持久化字段 ⊆ 生效字段（去掉遗留字段名）；
  3. 新增 `test/rulesPersistence.test.ts`：用真实命令层逐字段执行 `/rules set <字段>`（含全局 `all`），`flush()` 后**重新装配 `GroupConfigStore`** 从仓储恢复并断言每个字段；同时覆盖「只有扩展字段的群」和 `removeOverride` 清空两张表；
  4. 生产装配路径（`main.ts` / `test/helpers/persistenceRuntime.ts`）必须把 `groupSettings` 传给 runtime，保证扩展字段真的写库；
  5. 全局超管在私信里查看群指令帮助（`/help rules` 等）直接放行；私信不带群号的 `/rules` 对超管等价于 `/rules all`。
- 理由：把「配置字段 = 可持久化字段」变成一条会被 CI 守住的不变量，比写文档提醒更可靠；端到端重装 store 的测试能同时抓住「漏加入库清单」「仓储没接线」「load 没合并」三类问题。
- 影响：
  - `groupConfig.ts` 新增导出 `PERSISTED_CONFIG_FIELDS` / `PersistedConfigField`；
  - `helpTopics.ts` 的 `isModerator` / `isGroupAdmin` 在私信分支先判 `isSuperAdmin`；
  - `adminCommands.handleRules` 在私信无群参数且调用者是全局超管时返回全局规则视图；
  - 以后新增规则字段的 checklist：加进 `GroupConfig`/`EffectiveGroupConfig`/`DEFAULT_CONFIG` → 加入 `SETTING_FIELDS`（首选）或 `SQL_FIELDS` → 加 `parseSettingValue`/`applySettingField`（键值字段）与 `/rules set` 解析 → 跑 `pnpm test`。

## ADR-0036：用随机 Base62 短码替代系统 id 展示，`/whois` 是唯一还原入口

- 状态：已采纳
- 背景：官方 `join_request_id` 长达 100+ 字符，直接贴进卡片/`/pending` 既难看又难复制；同时 `user_openid` / `group_openid` 属于内部标识，展示出去存在被枚举、被误用（例如拿别人的申请 id 尝试审批）的风险。之前「未绑定就回退显示 openid」的做法仍然暴露了系统 id。
- 决策：
  1. 新增 `short_codes` 表：`code` 为主键、`(kind, target_id)` 唯一，`kind ∈ {user, group, join_request}`；
  2. 短码为 **6 位随机 Base62**（`crypto.randomInt` 逐位生成，**不用自增 ID**），展示时加 `#` 前缀（`#M7K2Q9`）；内存与数据库双重查重，碰撞就重新生成；
  3. 新增 `ShortCodeService`（生成/解析/持久化）与 `DisplayNameService`（统一展示与参数解析）：已绑定 QQ号/群号仍显示解析号，未绑定显示短码，申请单一律显示短码；
  4. 所有命令参数同时接受短码与原有的 QQ号/群号/完整 id（`resolveRequest` 对非短码输入原样返回），保证旧消息与手工粘贴仍可用；
  5. `/whois` 扩展为支持 `#短码`，是**唯一**会输出真实系统 id 的指令（超管限定）；其它用户可见输出只出现 QQ号/群号/短码；
  6. 短码懒生成：第一次需要展示时创建并写穿透到数据库，重启由 `load()` 恢复。
- 理由：随机短码不可枚举、可读、可复制，既解决「太长」，又把系统 id 从所有普通输出里彻底移除；`/whois` 作为受控出口保留排障能力；懒生成避免为从不展示的 id 浪费空间。
- 影响：
  - 新增 `short_codes` 表、`SqlShortCodeRepository`、`ShortCodeService`、`DisplayNameService`，并接入 `runtime` / `main` / 持久化装配；
  - `AdminCommandService` / `NotificationService` / `JoinRequestCard` 全部改用展示名，`/pending`、`/sync`、卡片、`/audit`、`/status`、`/perm list`、`/rules`、`/notify`、`/test` 不再出现系统 id；
  - `JoinApprovalService.applyJoinRules` 增加 `notify` 返回值，配合新群配置 `notifyAutoApproved`（`group_settings` 持久化）决定自动处理是否通知；
  - 短码映射属于伪匿名数据，随数据库一起备份；不参与保留清理（体量很小，且删除后会导致旧消息里的短码失效）。

## ADR-0037：个人资料、活动模块与关键词豁免

- 状态：已采纳
- 背景：需求分三块：① 管理员（审核员及以上）应豁免关键词判断；② 用户可维护个人资料（班级/学院/姓名/学号，学号 11 位、前两位 22-26 决定年级）；③ 完成活动发布/报名/管理，活动可配群号与链接（卡片呈现），报名按学院/年级限制。
- 决策：
  1. **关键词豁免**：`MessageGuardService` 注入 `PermissionService`，`canReviewContent`（审核员及以上）直接返回 Allow，不警告/不撤回/不处罚、不写审计，只记 `moderation exempt` debug 日志；普通成员照常；
  2. **`/profile`**：新增 `user_profiles` 表与 `UserProfileService`。学号必须 11 位且前两位 ∈ {22..26}（年级 = `20` + 前两位）；班级必须存在于 `MemberRoster`（班级库），保存班级自动带出学院；学院/年级可手动覆盖；`/profile clear` 可删除；报名前要求「姓名+学号+班级」齐全；
  3. **活动模块**：`ActivityService` 增加活动短码（6 位随机 Base62，`activity_details.code` 唯一索引）、链接、学院/年级白黑名单、`findByCode/updateActivity/checkEligibility/findRegistration`；扩展字段放独立的 `activity_details` 表，沿用「新表幂等升级、不改老表」的经验；
  4. **报名规则**：黑名单优先，白名单为空表示不限；年级取学号前两位；学院匹配允许简称（`环境` 命中 `环境科学与工程学院`）；
  5. **权限**：活动发布/修改/开停/看名单 = `canApproveJoin`（群管理员+）或活动发布者本人或全局超管；报名/取消/详情对所有已绑定用户开放；
  6. **卡片**：抽出 `RichMessageSender`（Markdown+按钮 → Markdown → 纯文本三级降级，按钮白名单被拒后机器人级记住），入群申请卡片与活动卡片共用，避免两份降级逻辑；
  7. **展示**：活动一律用短码 `#A7K2Q9`，与 ADR-0036 的系统 id 策略一致。
- 理由：资料是活动限制的前提，先落库再报名才能保证规则可执行；活动扩展字段独立成表避免 ALTER 迁移；三级降级与短码复用既有基础设施，代码量与风险最小。
- 影响：
  - 新表 `user_profiles` / `activity_details`，新服务 `UserProfileService` / `ActivityCardService` / `RichMessageSender`；
  - `AdminCommandService` 新增 `/profile`、`/activity`（含 `/help profile`、`/help activity` 主题），`MessageGuardService` 新增可选 `permissions` 参数；
  - `NotificationService` 的三级降级逻辑迁移到 `RichMessageSender`（行为与 detail 命名保持不变，测试同步）；
  - 学号样例统一为 `22123456789` 这种「22 + 9 位」格式（不是 `2022…`）。

## ADR-0038：班级数据一次加工成 JSON + SQLite，别名表全局且仅超管可维护

- 状态：已采纳
- 背景：需求三块：① `/profile set` 要能一条消息填完（顺序/分隔符随意、甚至无分隔符）；② `data/class.json` 要一次加工成"格式化数据"供 profile 模块与入群审批复用，并建立学院/班级对照；③ 需要一张"允许管理员维护的自定义别名表"，把习惯写法映射到班级库规范名；另需 `/whois` 支持查"QQ ↔ 个人资料"。
- 决策：
  1. **智能解析**：班级固定由"班级库最长命中"切分（`findClassIn` 忽略空白、长名优先），11 位数字=学号，剩余 2-4 连续汉字=姓名，学院可在文本里命中；**歧义或残留一律整体不写入**并列出识别结果（不猜），写入前先整体校验（学号前缀/班级存在/姓名长度）再落库；`字段=值` 作为消歧后门；
  2. **class.json 产物**：`pnpm class:index` 同时出 JSON（运行时加载，新增 `colleges`/`collegeMajors`/`majorColleges` 对照）与 SQLite（`meta`/`colleges`/`majors`/`classes`，供离线分析与别名联查）；产物仍在 gitignored 的 `data/`，**两份都不提交**；核心逻辑抽到 `scripts/classIndex.mjs` 以便在进程内测试（避免 spawn）；
  3. **别名表**：新表 `class_aliases(alias PK, target, kind, updated_at)`，`ClassAliasService` 内存 Map + 写穿透队列；**目标类型由规范名在班级库里的身份自动判定**，不让用户填 `kind`；别名**先展开成规范名**再交给现有匹配逻辑，因此 profile 识别与入群审核共用一套代码；
  4. **别名范围**：**全局一份**，仅全局超级管理员可维护（用户确认）。理由：班级库本身就是全局数据，别名是它的修正视图；若做群级会在同一班级上产生互相冲突的叫法，收益低、复杂度高（需 `group_id` + 群优先覆盖语义）；
  5. **`/whois profile`**：用**子命令**而不是改默认输出，权限收紧到全局超管（个人资料属个人信息，不开放给群管理员），支持 `QQ号 / userId / #用户短码`。
- 理由：把"规范名"集中在班级库、"习惯写法"集中在别名表，两者都先归一化再匹配，避免在 profile 和入群审核里各写一套模糊匹配；SQLite 副本让后续离线核对与联查不必再解析 2.9 MB JSON。
- 影响：
  - 新表 `class_aliases`，新服务 `ClassAliasService`，新仓储 `SqlClassAliasRepository`（SQLite/PostgreSQL 同一实现）；
  - `AdminCommandService` 新增 `/alias`（`list|set|del`），`/menu super` 与 `/help alias` 同步；`ProfileParser` 与 `JoinRuleEvaluator` 新增可选别名注入点（未注入时行为不变）；
  - `scripts/build-class-index.mjs` 变薄，逻辑移到 `scripts/classIndex.mjs`；新增 `CLASS_INDEX_SQLITE_FILE`（`-` 跳过）；
  - 真机功能：`/profile set` 智能识别、`/whois profile`、`/alias` 各有验收行（J21-J26）。

## ADR-0039：短码去小写、`/whois` 结果只走私信、年级统一两位、仓库不出现真实标识

- 状态：已采纳
- 背景：真机试用后用户提出四条要求：① 文档里不要出现真实 QQ号；② 短码不要出现小写字母；③ `/whois` 结果可能涉及隐私，只在私信里给，群里可用 @ 指定查谁；④ 个人资料年级只允许两位，不接受四位完整年份。
- 决策：
  1. **短码字符表去掉小写**：`ALPHABET_62` → `ALPHABET_36`（`0-9A-Z`），`randomBase62` → `randomCode`；`short_codes` 与活动短码（`activity_details.code`）共用同一生成器；
     **启动时重生成历史遗留的含小写短码**（`ShortCodeRepository.replaceCode` / `ActivityService.load` 内的迁移），旧短码随之失效；解析仍大小写不敏感，方便手输；
  2. **`/whois` 只走私信**：新增 `NotificationService.sendPrivateCard`（包装 `RichMessageSender.sendToUser`）复用 `/notify` 的私信通道；群内发指令时结果私信给操作人，群里只回一张不含内容的提示卡；私信失败只提示「先私聊机器人再试」，**禁止降级到群里**；权限不足/用法/未找到映射等不含隐私的提示仍在原处回；目标解析新增官方 at 段（`<@!openid>`），`@昵称` 反查不了时明确提示替代写法；
  3. **年级统一两位**：`yearFromStudentId` / `normalizeYear` 都返回两位，四位输入直接报错；班级库里的四位年份写入 profile 时用 `toShortYear` 转换；`UserProfileService.load()` 把历史四位值收敛成两位并写回；活动 `allowYears` 输入只接受两位，历史四位配置在 `checkEligibility` 里仍然匹配；
  4. **仓库隐私守卫**：README/文档示例里的真实 QQ号、群号、openid 全部替换为明显占位的假值（`10001` / `654321` / `123456789` / `0123456789ABCDEF0123456789ABCDEF`），并新增 `test/privacyGuard.test.ts` 扫描 `src`/`test`/`scripts`/`docs`/README/CHANGELOG：
     形状规则是「9-12 位未登记数字」「32 位十六进制串」「6-8 位十六进制 + `...`」，命中不在占位符白名单就失败。
     **守卫测试自身绝不保存真实值（连片段都不保存）**——把真实值写进守卫等于换个地方泄露；需要按精确值兜底时用本地环境变量 `PRIVACY_GUARD_IDS`（逗号分隔），真实值只留在本地环境。
- 理由：小写字母在口语与手抄场景容易与数字混淆（`l/1`、`o/0`），去掉小写后短码更可靠；`/whois` 是唯一会暴露真实系统 id 的入口，把它限制在私信里，等于把"越权/围观"风险降到最低；年级两种写法（`22` / `2022`）长期看必然产生对账与判断 bug，趁数据量小统一成两位。
- 影响：
  - 新方法 `NotificationService.sendPrivateCard`；`ShortCodeRepository` 新增 `replaceCode`；
  - `/whois` 的群内输出语义改变（提示卡），私聊输出不变；相关测试改为断言私信内容；
  - `user_profiles.year` 历史数据自动收敛（启动时写回），活动 `allowYears` 输入格式收紧；
  - 新增守卫测试 `test/privacyGuard.test.ts`，示例值统一为 `10001` / `654321` / `0123456789ABCDEF0123456789ABCDEF`。

## ADR-0040：活动卡片改回调驱动 + 按群订阅推送（§B2）

- 状态：已采纳
- 背景：B1 已经把活动逻辑（候补、冻结名额、递补方式、截止时间）做进 `ActivityService`，
  但交互仍是「Markdown + 指令按钮」：用户点「报名」只是把 `/activity join #码` 填进输入框，
  要再发一次消息；活动配置只能手输 `/activity set`；「发布新活动」没有任何触达手段，
  群里也没有可靠的 @全体（真机已确认做不到）。
- 决策：
  1. **成员卡 / 配置卡 / 管理卡 / 名单卡四张子卡**，全部 `renderCard()`（Markdown + 内嵌按钮 + 纯文本降级）。
     按钮按 `docs/CARD-STANDARD.md` 分类：导航 / 查看 / 翻页 / 开关 / 枚举 / **固定动作**都用**回调**，
     需要自由文本或不可逆的用**指令按钮**；回调按钮也支持官方 `modal` 二次确认
     （报名 / 取消报名 / 取消活动）。
  2. **回调命名空间 `activity`**（`cb:activity:<action>[:args]`），在 `runtime.ts` 的
     `callbackRenderers` 注册；**renderer 内部必须重新做权限校验**（不能信按钮）：
     报名 / 取消报名 / 订阅 = 任意成员；配置 / 发布 / 关停 / 释放 / 名单 / 导出 / 统计 =
     `canManageActivity(userId, activity)`（超管 / 活动发布者 / 群管理员）或超管；
     回调参数用**活动短码**（用户可见标识），解析失败回一张「活动不存在」卡。
  3. **消息落点（隐私优先，用户确认）**：群里报名 / 候补只回 `<@!申请人>` + 非隐私文案
     （`报名成功 · 当前 X/Y` / `已进入候补 · 第 N 位`），**不出现**姓名/学号/班级/学院；
     报名失败的**具体原因只走私信**，群里只说「原因已私信」（私信失败时提示「先私聊机器人再试」，
     **绝不**降级到群里）；私聊操作时回执可以包含姓名/学号/序号/人数；
     `manual` 模式取消报名不在群里公开说明谁退出，只在管理卡体现「待释放名额 +1」。
  4. **递补只私信**：`auto` 模式取消即递补、管理卡「释放名额」递补候补第一位，
     被递补者私信收到「你已递补成功（当前 Y/Z）」，**不往群里发**。
  5. **发布 / 变更 / 取消的通知**：发布 = 群里发成员卡 + 操作者私信回执 + **给该群订阅者私信活动卡**；
     变更 = 私信已报名 + 候补（`kind: "changed"`）；取消 = 私信全部当事人。
     因为真机确认**无法 @全体成员**，`mentionAll=true` 时只给操作者一条
     「机器人无法 @全体成员，如需通知全群请手动 @ 一条」的提示，**不假装能 @**。
  6. **新表 `activity_subscriptions`（按群订阅）与 `activity_notifications`（去重 + 每日计数）**：
     主动私信有官方额度（单用户每天 1000 条、单关系 20 qpm、未认证 5 qps & 30 qpm），
     用户还能关闭「允许主动发送」。因此通知**只发给订阅者 / 当事人**，
     按 `(activity_id, user_id, kind)` **去重**（主键，重启后不重复），
     并按 `ACTIVITY_NOTIFY_DAILY_LIMIT`（默认 3，`0` = 不限制）**每人每天封顶**；
     发送失败只记 warn，不影响活动本身。
  7. **§B3 是可选依赖**：统计图片与 CSV 导出通过 `ActivityCardService` 的
     `stats` / `exportService` 注入项**条件生成按钮**；未装配时按钮不出现，
     回调被直接调用也只会得到「文字统计卡」/「导出服务未装配」提示，不会抛错。
- 理由：回调按钮把「查看 / 开关 / 枚举 / 固定动作」压缩成一次点击，是用户确认的交互方向；
  活动配置项多（名额 / 限制 / 截止 / 递补 / 开关 / 起停），拆成子卡比在一张卡上硬塞更符合
  官方 5 行 × 12 字约束；把「隐私字段只走私信」当成硬规则，避免群里刷屏与信息泄露；
  去重 + 封顶是对官方主动消息额度的必要尊重，否则一次集中变更就会让后续通知全部失败。
- 影响：
  - 新增 `src/services/activityNotifications.ts`、`src/db/activitySubscriptionRepository.ts`、
    `src/db/activityNotificationRepository.ts` 与两张新表（`CREATE TABLE IF NOT EXISTS`，老库无需 ALTER）；
  - `src/services/activityCards.ts` 重写为 `ActivityCardService`（四类卡 + 学院/年级子卡 + 订阅按钮），
    `ActivityCardInput` 改为「活动 + 报名 + 候补 + 查看者权限」；
  - `AdminCommandService` 新增 `activityCallbackCard()`（回调总入口）、活动指令改为返回 `CardResult`、
    私信回执统一走 `cardSender()`（优先 `richMessages`，其次通知服务的发送器）；
  - `NotificationService` 新增 `richMessageSender` getter，让活动卡片与入群推送共用同一条通道
    （同一个键盘降级状态）；
  - 新增 env `ACTIVITY_NOTIFY_DAILY_LIMIT`；`/activity` 帮助主题、README、CONFIGURATION、
    ACCEPTANCE（J32–J40）与 CHANGELOG 同步更新；
  - `/activity` 列表卡改为按「报名中 / 草稿 / 已结束」分组，行按钮改为回调；
    原有 `/activity` 全部子命令保留为降级路径。

## ADR-0040 补充：统计图片 / 富媒体上传 / CSV 导出（§B3）

- 状态：已采纳
- 背景：ADR-0040 把「统计图片 / 导出 CSV」两个按钮留成了可选接线点（未装配就不生成）。
  B3 把实现补上时必须回答三个真机问题：官方**没有**「multipart 直传文件字节」的接口，
  统计图的**中文字体**从哪来，以及名单里的学号 / 班级 / 学院怎么送出去才不泄露。
- 决策：
  1. **群图片上传走官方的两条官方路径，不做私造**：官方「群聊富媒体上传」
     （`POST /v2/groups/{group_openid}/files`）只接受 `url` 直传或分片上传合并，请求体
     `{ file_type, url?, srv_send_msg, file_name?, upload_id? }`，响应
     `{ file_uuid, file_info, ttl }`；`file_info` 是序列化二进制，官方要求**原样透传**到
     发消息接口的 `media.file_info`。本地渲染出来的 PNG 没有公网 URL，因此 `uploadGroupImage`
     走**分片**：`upload_prepare` → 逐片 `PUT` 预签名 URL → `upload_part_finish` →
     带 `upload_id` 调 `files` 合并。三条路径全部可在 `QQOfficialEndpoints` 覆盖
     （`groupFileUpload` / `groupFileUploadPrepare` / `groupFileUploadPartFinish`）。
     `AsyncTransport` 增加**可选**的 `requestRaw`（分片 `PUT` 既不是 JSON 也不带机器人鉴权头），
     `FetchTransport` 实现它；没实现时直接抛错并降级，不伪造成功。
  2. **发送图片 = `msg_type: 7`**：`{ msg_type: 7, media: { file_info }, msg_id? }`；
     `QQOfficialAPI` 新增 `uploadGroupImage` / `sendGroupImage`，`FakeQQOfficialAPI`
     记录 `uploadedGroupImages` / `sentGroupImages` 并提供 `failGroupImages` 失败开关。
  3. **字体系统优先，下载兜底，缓存不随包提交**：先探测
     `SYSTEM_FONT_PATHS`（Windows 雅黑 / Linux Noto CJK / 文泉驿 / macOS 苹方），
     找不到才从 `ACTIVITY_STATS_FONT_URL`（默认 Noto Sans SC 官方发布地址）下载并缓存到
     `data/fonts/`。`data/` 整目录已被 `.gitignore` 忽略，因此**缓存字体不随包提交**；
     缓存文件名不带版本号（避免隐私守卫把长数字当成可疑标识）。
  4. **`@napi-rs/canvas` 是可选依赖，缺失必须优雅降级**：用**变量拼包名**动态 `import()`
     （静态可解析的 `import(...)` 会让 `tsc` 在依赖缺失时直接报「找不到模块」，把可选依赖
     变成编译期硬依赖）。`ActivityStatsService.render()` 把「拿不到依赖 / 拿不到字体」统一
     转成 `undefined`，由调用方降级为**文字统计卡**；**绝不让启动或活动回调失败**。
     沙箱里装不上原生包时，这条降级路径正是被测对象（`test/activityStats.test.ts`）。
  5. **发送能力单独判断**：`ActivityStatsLike` 增加 `canSend`，卡片服务只在**既能渲染又能发送**
     时生成「统计图片」按钮——否则会出现「点了却没反应」的入口。渲染成功但上传/发送失败
     时同样降级为文字统计卡（用户拿到数据比拿到半张图重要）。
  6. **CSV 只私信给操作者**：`ActivityExportService` 生成
     `序号,姓名,学号,班级,学院,备注,候补`（候补行最后一列 `候补`），用
     `RichMessageSender.sendPlainToUser` 以代码块私信给操作者本人；学号 / 班级 / 学院
     都是隐私字段，**群里不回执内容**。超过单条消息长度上限（默认 1800 字符）时不硬塞，
     改成私信提示用 `/export #短码` —— 被平台截断的半份名单比没有名单更危险。
- 理由：官方接口只有 URL 直传与分片两条上传路径，硬造 multipart 只会在真机上 400；
  字体「系统优先」避免每次部署都下载几十 MB，而「下载兜底 + gitignored 缓存」又保证了
  容器/服务器环境（往往没有中文字体）仍然能出图；把可选依赖做成**运行时动态加载**，
  才能真正做到「装不上也不影响启动」——这是 B3 唯一的硬性可用性要求。
- 影响：
  - 新增 `src/services/activityStats.ts`（渲染 + 排版 + 字体解析 + 发送）、
    `src/services/activityExport.ts`（CSV 生成 + 私信）；
  - `src/adapters/qqOfficial.ts` 新增两个 API 方法、三个可配置 endpoint、
    `requestRaw` 可选能力与 `buildGroupImagePayload` / `parsePreparedUpload` / `extractFileInfo`；
    `src/adapters/fetchTransport.ts` 实现 `requestRaw`；`src/core/instrumentation.ts` 补齐两条日志；
  - `ActivityCardService` / `AdminCommandService` 新增 `setActivityExtras()`（两处必须同步，
    否则会出现「有实现没入口」）；`activity:stats` 成功回「已发送统计图」卡、失败或降级回文字统计卡；
  - 新增 env `ACTIVITY_STATS_FONT_URL`；README / CONFIGURATION / ACCEPTANCE（J41–J44）/
    CHANGELOG 同步更新。

## ADR-0040 补充：群内静默 + 多群绑定 + 满员广播（§B4）

- 状态：已采纳（**优先于 ADR-0040 第 3 条的群内回执**）
- 背景：ADR-0040 的群内报名回执虽然不含隐私字段，但在几十人的群里仍然会刷屏
  （每人报名一条「@本人 + 报名成功」），而报名结果本身对其他人没有价值；
  同时一个活动常常要在多个群同时推广（主群 + 年级群 / 学院群），
  原来「活动只归属一个群」的表达力不够；名额刚满时也需要一个自然的「已满」公告，
  但机器人**无法 @全体成员**，只能靠卡片本身传递信息。
- 决策：
  1. **群内报名 / 取消报名一律静默**：群里点回调或手输 `/activity join|quit`
     都**不发任何群消息**（连「原因已私信」都不发），成功 / 候补 / 失败原因一律私信本人。
     实现对 `CommandResult` 增加 `silent?: boolean`，`ensureCard` **原样保留**该字段，
     `eventRouter` 透传到 `kind:"command"` 的结果，`gatewayRunner` 在
     `result.silent === true` 时**跳过一次 `sendReply`**；
     `cb:activity:join|quit` 的 renderer 在私信成功后**返回 `undefined`**（只回包，不发言）。
  2. **唯一例外**：私信发送失败（没私聊过机器人 / 关闭主动消息 / 被限流）时，
     群里允许回一条**不含任何结果**的提示「`<@!申请人>` 私信发送失败，请先私聊机器人再试」，
     否则用户会以为点了没反应。**绝不**把结果或原因降级到群里。
     私聊里用同样的指令仍然原地回复（可含姓名 / 学号 / 班级 / 人数）。
  3. **活动可绑定多个群**：新增 `activity_groups (activity_id, group_id, created_at)`
     与 `ActivityGroupRepository`；`ActivityService` 增加
     `bindGroup` / `unbindGroup` / `listBoundGroups`（幂等；`createActivity` **自动绑定创建群**；
     `load()` 读回绑定关系）。`activities.group_id` 仍然是**归属群**（创建地与权限依据），
     绑定关系是**发布与广播的目标群集合**；没有任何绑定行时回落到归属群
     （老活动与极简单测不需要显式绑定）。
     `/activity bind|unbind <#短码> <群号|#群短码>` 与配置卡上的「绑定群」子卡（每页 5 个 + 解绑回调）。
  4. **发布与重发打到所有绑定群**：`open` / `重发卡片` 逐个群发送并**记录每个群的成功 / 失败**，
     操作者的私信回执列出「成功 N 个 / 失败 N 个」与失败群号（展示用群号，不暴露 openid）。
  5. **满员广播**：`joinActivity` 的 registered 分支返回 `becameFull`（本次报名后恰好满员）；
     调用方随后在**所有绑定群**发一张「活动已满 X/X」卡（含「后续报名将自动进入候补队列
     （当前候补 N 人）」与截止时间）。**每个群只发一次**：复用 `activity_notifications`
     去重表，键为 `(activity_id, "group:<群ID>", "full")`——群消息不占用户的每日私信额度。
  6. **群消息通道**：`ActivityNotificationService` 的构造选项增加可选 `groupSender`
     （runtime 注入 `RichMessageSender`），`notifyGroupsCard()` 只在**发送成功**的群写去重行，
     失败不写（下次重试仍会尝试）；未装配通道时返回 `available: false`，静默跳过。
- 理由：报名结果是「私事」，群消息应当只承载对所有人都有价值的信息（卡片 / 已满 / 发布回执）；
  把「群内静默」做成 `CommandResult.silent` → `EventRouter` → `gatewayRunner` 的**透传链路**，
  而不是在 handler 里特判「这是群消息还是命令」，是为了让后续任何「结果只能私信」的指令
  复用同一条路径（`/whois` 已经在用同款思路）。绑定多个群比「复制多个活动」更贴近真实运营：
  名额、候补、名单只有一份，公告可以多处。
- 影响：
  - 新增 `src/db/activityGroupRepository.ts` + `activity_groups` 表（`CREATE TABLE IF NOT EXISTS`），
    接入 `persistence.ts` / `runtime.ts` / `main.ts` / `test/helpers/persistenceRuntime.ts`
    与 `test/migrate.test.ts` 的建表断言；
  - `ActivityService` 的 `joinActivity` 返回值新增 `becameFull` / `registered`；
    新增 `bindGroup` / `unbindGroup` / `listBoundGroups` / `isGroupBound`；
  - `ActivityCardService` 新增 `fullCard()`（满员广播卡）与 `bindGroupsCard()`（绑定群子卡）、
    `groupLabel` 选项；配置卡正文增加「绑定群」行与「绑定群」入口；
  - `AdminCommandService`：`CommandResult` / `CardResult` 新增 `silent`；
    `cb:activity:join|quit` 命中静默时返回 `undefined`；
    新增回调 action `bindings` / `bind` / `unbind` 与命令 `/activity bind|unbind`；
    `publishActivity` / `handleActivityResend` 改为多群；
    新增 `announceActivityFull()`（满员广播）；
  - `ActivityNotificationKind` 增加 `full`；`notifyGroupsCard()` / `isGroupCardSent()`；
  - 帮助主题（activity）、README、CONFIGURATION、ACCEPTANCE（J45–J48）、CHANGELOG 同步更新。

## ADR-0041：规则菜单重构 + 字段级继承 / 恢复（§C）

- 状态：已采纳
- 背景：旧 `/rules` 只有「概览 + 开关 / 入群决策 / 命中处罚」三张子卡，
  开关标签显示的是「点一下会变成的结果」（`过滤 关` = 点击后变关），与卡片标准
  「按钮显示当前状态」相反；关键词只能整表用 `/rules set keywords a,b,c` 覆盖（不能在卡片上逐条增删）；
  学院 / 年级白黑名单只能手输；全局规则卡是纯文本，看不到「哪些群覆盖了哪些字段」；
  而且**覆盖与继承在展示上区分不出来**——用户无法判断某个值是本群设置的还是继承来的。
- 决策：
  1. **字段级覆盖查询与清除**（`src/services/groupConfig.ts`）：
     `overriddenFields(groupId): Set<keyof GroupConfigOverride>` 返回显式覆盖过的字段
     （内存 override 行 + `group_settings` KV；`__default__` 是全局）；
     `clearFields(groupId, fields)` 只清这些字段的覆盖：`group_configs` 对应列置 `NULL`
     （**只清列，不动其它列**，避免整行快照把别的列清空）、`group_settings` 对应 KV 行删除；
     全局清字段回落到 `builtinDefault`（种子默认），其它全局覆盖保留。
     `listOverrideSummaries()` 给全局卡「覆盖率总览」用。
  2. **「显式设置」与「继承」分开记录**：新增 `overridden` / `overriddenDefault` 集合，
     值等于默认值的显式设置**也算覆盖**（否则「恢复本页继承」会无法区分
     「明明设置过、只是恰好等于默认」与「从未设置」）。构造函数传入的默认值等价于
     「显式配置的种子默认」，清掉持久化覆盖后仍算显式（回落目标是种子而不是内置空值）。
  3. **仓储层配合**：`GroupConfigRepository` 增加 `clearColumns(groupId, fields)`
     （`GROUP_CONFIG_COLUMNS` 白名单拼 `UPDATE ... SET col = NULL`，关键词不在列里、
     仍由 `replaceKeywords` 负责）；`GroupSettingsRepository.remove` 已存在，直接复用。
  4. **按钮语义统一为「显示当前状态」**：开关标签 `关键词过滤 开`（当前=开），
     点击后切换并回到同一张子卡；枚举当前值用 `● ` + 高亮。每张子卡正文逐条列
     `字段：当前值（继承全局 / 本群覆盖）`，底部是「恢复本页继承」（二次确认，
     调 `clearFields`，只清本页字段白名单）+「返回规则」；概览卡是
     「本群覆盖：…（其余继承全局）」+ 5 个子卡 + 「恢复全部继承」（二次确认，等价旧 `removeOverride`）。
  5. **关键词逐条增删**：新增 `/rules add keyword <词>`、`/rules del keyword <词>`
     （权限同 `canManageRules`；trim、去重、单条 ≤50 字；不存在会明确报错）。
     关键词子卡每页 3 条、每条一个「删」回调，另有「加词」（指令按钮预填）与「清空」（二次确认）。
     回调 `cb:rules:delKeyword:<群>:<序号>:<页码>` / `cb:rules:clearKeyword:<群>`。
  6. **学院 / 年级点选子卡**：学院来自 `MemberRoster.listColleges()`（每页 4 个、一行一个，
     `●` 标记已选、点一下切换、翻页回调、白/黑名单切换）；年级用 `PROFILE_ENTRY_YEARS`（22–26）。
     落地为 `allowColleges/denyColleges/allowYears/denyYears` **字段级覆盖**
     （为此给 `GroupConfig` 增加这四个列表字段，加入 `SETTING_FIELDS` 走 KV，不需要迁移）。
  7. **全局规则卡同构 + 覆盖率总览**：`/rules all` 改成与群规则**同一套子卡结构**
     （目标 `DEFAULT_GROUP_ID`），正文标明「只影响未覆盖的群」；
     底部「覆盖率总览」用 `listOverrideSummaries()` 分页列出「群 + 覆盖字段数 / 字段名」。
  8. **保留降级路径与权限**：`/rules set <字段> <值>`（含 `all`）、`/rules all`、`/rules` 行为兼容；
     新增回调 action `resetPage` / `resetAll` / `delKeyword` / `clearKeyword` / `panelPage` /
     `rosterToggle` / `overrides`，全部在 `runtime.ts` 的 rules renderer 里**重新做权限校验**
     （查看 = `canReviewContent`，修改 = `canManageRules` 或超管；全局 = `isSuperAdmin`）。
- 理由：卡片标准要求「按钮显示当前状态 + 列表分页 + 越权不静默」，
  而字段级继承是「多群配置」能力的关键——看不到继承关系就没人敢改规则。
  把「清除」做在**字段**粒度（而不是整群 `removeOverride`）是必要的：
  大多数场景只想恢复某一项（比如把关键词恢复成全局默认），而不是丢掉本群全部定制。
- 影响：
  - `src/services/groupConfig.ts`：新增 `overriddenFields` / `clearFields` / `listOverrideSummaries`
    与 `overridden` / `overriddenDefault` / `seedDefault` 状态；`GroupConfig` 新增
    `allowColleges/denyColleges/allowYears/denyYears`；`SETTING_FIELDS` 同步扩展
    （`PERSISTED_CONFIG_FIELDS` 仍等于全部生效字段，`test/groupConfig.test.ts` 的清单断言继续成立）；
  - `src/db/groupConfigRepository.ts`：新增导出 `GROUP_CONFIG_COLUMNS` 与 `clearColumns`；
    `test/helpers/fakeGroupConfigRepositories.ts` 的 `saveOverride` 改为**只落列字段**
    （之前整份快照会把 KV 字段也塞进 `group_configs` 行，导致 `clearFields` 后重载又「复活」）；
  - `src/services/adminCommands.ts`：重写 `rulesCard` / `rulesPanelCard` / `toggleRulesCard` /
    `globalRulesCard`，新增 `delKeywordCard` / `clearKeywordsCard` / `resetRulePageCard` /
    `resetAllRulesCard` / `rosterToggleCard` / `ruleOverridesCard` 与关键词增删命令；
    `parseRuleSetting` 增加 `allowColleges/denyColleges/allowYears/denyYears` 与
    `wordFilterEnabled` 等字段别名；
  - `src/runtime.ts`：rules renderer 覆盖新 action 并透传分页 / 模式参数；
  - `src/services/menu.ts` / `helpTopics.ts`、README、CONFIGURATION、ACCEPTANCE（J49–J56）、
    CHANGELOG 同步更新。
