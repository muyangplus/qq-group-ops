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
      │ WebSocket / Webhook（Phase 1 实现）
      ▼
QQ Group Ops 官方接入层
  ├── adapters/eventGateway.ts     事件网关接口
  ├── adapters/fakeEventGateway.ts 测试网关
  ├── adapters/webSocketGateway.ts WebSocket 网关骨架
  ├── adapters/eventMapper.ts      事件映射器
  └── gatewayRunner.ts             网关到事件路由的绑定
      │
      ▼
TypeScript 核心服务
  ├── services/moderation.ts     规则引擎
  ├── services/messageGuard.ts   消息审核执行
  ├── services/eventRouter.ts    事件路由
  ├── services/joinAudit.ts      入群审核状态机
  ├── services/joinAuditSync.ts  官方申请同步
  ├── services/adminCommands.ts  管理员命令
  ├── services/groupConfig.ts    多群配置
  ├── services/activity.ts       活动报名
  ├── services/export.ts         信息导出
  ├── services/audit.ts          审计日志
  ├── services/permissions.ts    权限模型
  ├── adapters/qqOfficial.ts     官方 REST 客户端与传输抽象
  ├── adapters/fetchTransport.ts 原生 fetch 传输
  ├── adapters/fakeQqOfficial.ts 官方 API 测试替身
  ├── db/queryable.ts            数据库查询抽象
  ├── db/schema.ts               PostgreSQL schema
  ├── db/auditRepository.ts      审计仓储
  ├── db/joinRequestRepository.ts 入群申请仓储
  ├── db/groupConfigRepository.ts 群配置仓储
  └── phase0.ts                  Phase 0 检查核心
      │
      ▼
Web 管理 API + 管理后台（Phase 2）
```

## 目录说明

| 目录 | 职责 |
|---|---|
| `src/adapters/` | 官方 API 鉴权、HTTP 调用、错误映射、事件网关、测试替身 |
| `src/core/` | 领域模型、枚举、通用类型 |
| `src/services/` | 规则引擎、审核流程、审计、权限、活动报名、信息导出、命令 |
| `src/db/` | PostgreSQL schema、查询抽象与仓储 |
| `src/config.ts` | 环境变量加载与校验 |
| `src/runtime.ts` | 运行时装配：按配置选择真实/测试 API 并连接服务 |
| `src/phase0.ts` | Phase 0 检查核心 |
| `src/main.ts` | 本地开发入口 |
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
- 真实请求体必须在 Phase 0 实测后确认，未确认的部分明确抛出错误。

### 3. 为什么使用 PostgreSQL？

- 需要保存多群配置、审核记录、操作日志和统计结果。
- PostgreSQL 支持 JSON、索引和事务，适合审计场景。
- 开发环境可先用内存实现，生产使用 PostgreSQL。

### 4. 为什么默认不保存消息原文？

- 群聊消息可能包含个人信息甚至敏感个人信息。
- 长期保存原文会显著增加合规和安全风险。
- 默认只保存审核结果、规则命中、操作人和时间；需要原文追溯时短期保留并自动删除。

## 待验证的架构风险

- 官方 bot 全量消息是否需要申请或群主开启。
- 官方 bot 撤回他人消息的权限边界。
- 好友申请 / 群邀请是否有可调用的审批接口。
- 官方 API 的频率、配额和可管理群数量。
- 个人开发者账号的群聊权限范围。
- `restrict_chat_setting` 和 `batch_remove_members` 的请求体结构。

这些风险在 `docs/PHASE-0-VERIFICATION.md` 中跟踪，未确认前不写入“必然支持”的实现承诺。
