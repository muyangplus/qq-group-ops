# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 全局规则：`/rules all` 查看、`/rules set all <字段> <值>` 修改（`all` 也可写作 `global` / `default` / `全局` / `默认`），仅超级管理员可用。
  - 未单独配置的群继承全局规则；已配置的群按字段覆盖（例如群覆盖了 `keywords`，仍继承全局的 `autoApprove`）。
  - 全局配置持久化在 `group_configs` / `group_keywords` 的 `__default__` 行，重启不丢。

### 变更

- `GroupConfigStore.setOverride({ groupId: "__default__" })` 从抛错改为更新全局默认配置；新增 `DEFAULT_GROUP_ID` 常量与 `builtinDefault` 访问器。

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
