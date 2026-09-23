# Decisions

本文件记录关键技术决策。新增决策请使用 ADR 格式追加。

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





