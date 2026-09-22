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
      │ WebSocket / Webhook
      ▼
nonebot-adapter-qq
      │
      ▼
NoneBot2 运行时
  ├── plugins/join_audit.py      入群申请审批
  ├── plugins/message_guard.py   消息规则与处理
  ├── plugins/activity.py        活动报名
  └── plugins/admin.py           管理指令
      │
      ├── services/moderation.py     规则引擎
      ├── services/message_guard.py  消息审核执行
      ├── services/join_audit.py     入群审核状态机
      ├── services/admin_commands.py 管理员命令
      ├── services/group_config.py   多群配置
      ├── services/activity.py       活动报名
      ├── services/export.py         信息导出
      ├── services/audit.py          审计日志
      ├── services/permissions.py    权限模型
      ├── adapters/qq_official.py    官方 REST 客户端与传输抽象
      ├── adapters/httpx_transport.py httpx 生产传输
      ├── adapters/fake_qq_official.py 官方 API 测试替身
      └── db/                        PostgreSQL 持久化
      │
      ▼
FastAPI 管理 API（Phase 2）
      │
      ▼
Vue 3 管理后台（Phase 2）
```

## 目录说明

| 目录 | 职责 |
|---|---|
| `src/qq_group_ops/adapters/` | 官方 API 鉴权、HTTP 调用、错误映射 |
| `src/qq_group_ops/core/` | 领域模型、枚举、通用类型 |
| `src/qq_group_ops/services/` | 规则引擎、审核流程、审计、权限、活动报名、信息导出 |
| `src/qq_group_ops/plugins/` | NoneBot2 插件入口，包括群管、审核和活动指令 |
| `src/qq_group_ops/db/` | 数据库模型与会话 |
| `src/qq_group_ops/web/` | FastAPI 管理后台 |
| `tests/` | 单元测试与集成测试 |
| `docs/` | 架构、路线图、验证和合规文档 |

## 关键决策

### 1. 为什么使用 NoneBot2 + nonebot-adapter-qq？

- 官方 API 事件接入复杂，NoneBot2 提供经过验证的事件循环和适配器。
- NoneBot2 生态成熟，便于后续扩展插件。
- 相比 AstrBot，NoneBot2 更偏底层，适合实现自定义审核工作流和管理 API。
- AstrBot 仍可作为快速原型备选，但不是本仓库的主路线。

### 2. 为什么还需要自研 `QQOfficialClient`？

- `nonebot-adapter-qq` 主要负责事件接入；群管理 REST 接口不一定全部暴露。
- 自研 client 可以统一处理鉴权、重试、频率限制、错误码和测试替身。
- 未来官方 API 版本变化时，只需修改 client。

### 3. 为什么使用 PostgreSQL？

- 需要保存多群配置、审核记录、操作日志和统计结果。
- PostgreSQL 支持 JSONB、索引和事务，适合审计场景。
- 开发环境可先用 SQLite，生产使用 PostgreSQL。

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

这些风险在 `docs/PHASE-0-VERIFICATION.md` 中跟踪，未确认前不写入“必然支持”的实现承诺。
