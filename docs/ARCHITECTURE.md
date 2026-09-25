# Architecture

## 设计原则

1. **仅使用官方 API**：不引入任何个人号协议端。
2. **适配层隔离**：事件接入与官方 REST 调用分开，便于替换和测试。
3. **业务逻辑可测试**：规则引擎、审核状态机、权限模型不依赖 QQ 平台即可单元测试。
4. **数据最小化**：默认不保存消息原文；审计日志使用内部 ID，不默认保存敏感内容。
5. **渐进式实现**：先在测试群验证官方能力，再实现依赖这些能力的功能。

## 组件

```text
QQ 官方开放平台
      │
      │ WebSocket 已实现 / Webhook 预留
      ▼
QQ Group Ops 官方接入层
  ├── adapters/eventGateway.ts     事件网关接口
  ├── adapters/fakeEventGateway.ts 测试网关
  ├── adapters/webSocketGateway.ts WebSocket 网关骨架
  ├── adapters/reconnectingWebSocketGateway.ts 自动重连网关
  ├── adapters/eventMapper.ts      通用事件映射器
  ├── adapters/qqOfficialEventMapper.ts 官方事件映射器
  ├── adapters/standardWebSocketFactory.ts 标准 WebSocket 工厂
  ├── adapters/nativeWebSocketFactory.ts   原生 WebSocket 工厂
  ├── adapters/qqOfficialGateway.ts 官方 WebSocket 协议网关（intent 含 INTERACTION 互动事件）
  └── gatewayRunner.ts             网关到事件路由的绑定
      │
      ▼
TypeScript 核心服务
  ├── services/moderation.ts     规则引擎
  ├── services/messageGuard.ts   消息审核执行
  ├── services/eventRouter.ts    事件路由
  ├── services/joinAudit.ts      入群审核状态机
  ├── services/joinAuditSync.ts  官方申请同步（按群节流）
  ├── services/joinApproval.ts   入群审批（先官方接口后本地状态）
  ├── services/joinRules.ts      入群规则引擎（班级+姓名解析、决策模式、审核意见）
  ├── services/memberRoster.ts   班级/专业索引加载与姓名抽取
  ├── services/joinRequestCard.ts 入群申请推送卡片（Markdown + 指令按钮）
  ├── services/notifications.ts  入群申请推送（订阅、权限过滤、三级降级、投递去重）
  ├── services/shortCodes.ts     随机短码（数字+大写字母，生成/解析/持久化，替代系统 id 展示）
  ├── services/displayNames.ts   统一展示与命令参数解析（QQ号/群号/短码）
  ├── services/userProfiles.ts   个人资料（班级/学院/姓名/学号，学号 11 位 + 年级推导）
  ├── services/activity.ts       活动发布/报名/管理（短码、链接、学院年级白黑名单）
  ├── services/activityCards.ts  活动卡片（Markdown + 报名/取消/详情/名单按钮）
  ├── services/richMessages.ts   富消息发送与三级降级（Markdown+按钮 → Markdown → 文本）
  ├── services/cardTemplate.ts   统一卡片模板（标题+正文+按钮行，集中校验官方限制）
  ├── services/menu.ts           QQ 端三级交互菜单（系统/管理/超管，按权限过滤）
  ├── services/firstMenuPush.ts  私信首次主菜单去重（dev 内存 / 正式入库）
  ├── services/testMenu.ts       回调按钮翻页试验（互动事件回包 + 被动回复下一页）
  ├── services/callbackData.ts   回调 data 编码/解析（cb:<namespace>:<action>[:args]）
  ├── services/callbackRouter.ts 互动事件总入口：回包 → renderer 渲染 → 主动发送
  ├── services/adminCommands.ts  管理员命令（含 /rules set、/audit、/sync、/menu）
  ├── services/groupConfig.ts    多群配置
  ├── services/activity.ts       活动报名
  ├── services/export.ts         信息导出
  ├── services/audit.ts          审计日志
  ├── services/permissions.ts    权限模型（全局超管 / 本群超管 / 群管理员 / 审核员）
  ├── services/identityMap.ts    OpenID ↔ QQ号/群号 映射（内存缓存 + 写穿透）
  ├── adapters/qqOfficial.ts     官方 REST 客户端与传输抽象
  ├── adapters/fetchTransport.ts 原生 fetch 传输
  ├── adapters/fakeQqOfficial.ts 官方 API 测试替身
  ├── db/queryable.ts            数据库查询抽象
  ├── db/sqliteQueryable.ts      SQLite 适配（占位符与方言转换）
  ├── db/sqliteDatabase.ts       SQLite 连接与 PRAGMA
  ├── db/pgQueryable.ts          PostgreSQL 连接池适配
  ├── db/migrate.ts              数据库迁移入口
  ├── db/schema.ts               数据库 schema
  ├── db/writeQueue.ts           顺序写穿透队列
  ├── db/auditRepository.ts      审计仓储
  ├── db/joinRequestRepository.ts 入群申请仓储
  ├── db/groupConfigRepository.ts 群配置仓储
  ├── db/identityBindingRepository.ts 绑定关系仓储
  ├── db/permissionRepository.ts 权限仓储
  ├── db/groupMessageModeRepository.ts 全量消息模式仓储
  ├── db/activityRepository.ts   活动与报名仓储
  ├── db/menuDeliveryRepository.ts 主菜单首次推送去重仓储
  └── persistence.ts             数据库连接、迁移与仓储装配
      │
      ▼
Web 管理 API + 管理后台（Phase 2）
```

## 目录说明

| 目录 | 职责 |
|---|---|
| `src/adapters/` | 官方 API 鉴权、HTTP 调用、错误映射、事件网关、测试替身 |
| `src/core/` | 领域模型、枚举、通用类型、日志与接口调试包装 |
| `src/services/` | 规则引擎、审核流程、审计、权限、活动报名、信息导出、命令 |
| `src/db/` | 数据库 schema、查询抽象、方言适配、写穿透队列与仓储 |
| `src/persistence.ts` | 数据库目标解析、连接、迁移与仓储装配 |
| `src/config.ts` | 环境变量加载与校验 |
| `src/core/logger.ts` | 结构化日志：控制台 + 文件 |
| `src/core/instrumentation.ts` | 官方 API、HTTP、数据库、事件网关的调试包装 |
| `src/runtime.ts` | 运行时装配：按配置选择真实/测试 API、注入仓储、提供 `load()` / `flush()` |
| `src/dev.ts` | 开发入口，默认启用 debug 日志 |
| `src/main.ts` | 生产入口 |
| `test/` | Vitest 单元测试与集成测试 |
| `docs/` | 架构、路线图、验证和合规文档 |

## 关键决策

### 1. 为什么使用 TypeScript + 自研轻量核心？

- TypeScript 提供类型安全，适合长期维护和多人协作。
- 自研轻量核心不绑定具体机器人框架，业务服务可以脱离 QQ 平台测试。
- 官方 API 接入层通过 `AsyncTransport` 抽象，生产使用 `fetch`，测试使用 fake transport。
- 后续如果接入 WebSocket 网关，只需新增 gateway 适配器，不修改业务服务。

### 2. 为什么还需要自研 `QQOfficialClient`？

- 需要统一处理鉴权、重试、频率限制、错误码和测试替身。
- 官方 API 版本变化时，只需修改 client 和 endpoint 配置。
- 真实请求体必须在官方文档核实和真实环境测试后确认，未确认的部分明确抛出错误。

### 3. 为什么默认 SQLite、同时支持 PostgreSQL？

- 默认 SQLite（Node.js 24 内置 `node:sqlite`）：零配置、单文件，`pnpm dev` 开箱即用，适合单进程机器人。
- 可选 PostgreSQL 16：多实例、高并发、大数据量场景使用。
- 两种数据库共用同一套仓储 SQL：仓储按 PostgreSQL 风格书写（`$1` 占位符、`ON CONFLICT ... DO UPDATE`），由 `SqliteQueryable` 做方言转换，避免维护两套代码。
- 持久化采用「内存缓存 + 写穿透」：读路径同步走内存，写路径进入 `WriteQueue` 顺序落库，启动时全量载入。

### 4. 为什么默认不保存消息原文？

- 群聊消息可能包含个人信息甚至敏感个人信息。
- 长期保存原文会显著增加合规和安全风险。
- 默认只保存审核结果、规则命中、操作人和时间；需要原文追溯时短期保留并自动删除。

### 5. 为什么权限分成「全局超管」和「本群超管」？

- 全局超级管理员拥有平台级能力（`/perm`、`/rules all`、`/bind user|groupid`、`/whois`），对应 `ADMIN_USER_IDS` 与 `/perm grant super`。
- 本群超级管理员（`/perm grant gsuper`）只在被授权的群内等价于 `super_admin`，用来把「这个群的负责人」和「平台运维」分开，避免群级管理员获得跨群能力。
- 角色全部手工配置：官方成员接口虽然返回 `member_role`（`owner`/`admin`/`member`），但属于内邀白名单能力（未开通返回 11253），因此不做自动映射（见 DECISIONS.md 的 ADR-0029）。

## 待验证的架构风险

- 官方 bot 全量消息是否需要申请或群主开启。
- 官方 bot 撤回他人消息的权限边界。
- 好友申请 / 群邀请是否有可调用的审批接口。
- 官方 API 的频率、配额和可管理群数量。
- 个人开发者账号的群聊权限范围。

已按官方文档核对（见 ADR-0025）：

- `restrict_chat_setting`：请求体为 `{ members: [{ op, member_openid, mute_expire_at }] }`，限频 60 QPM，最长 30 天。
- `batch_remove_members`：请求体为 `{ member_openids }`，**仅白名单机器人可用**（错误码 11253）。
- `approval_join_request`：请求体为 `{ op, join_request_id, reject_reason }`。
- `join_request_list`：返回 `{ list, next_cursor }`。

这些能力仍需在真实群验证一次端到端行为（权限、配额与实际生效范围）。
