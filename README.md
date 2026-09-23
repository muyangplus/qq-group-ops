# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Node.js / TypeScript 重写完成，官方 WebSocket 网关已鉴权成功，MVP 核心进行中**
- 已验证：官方 WebSocket 网关已收到 `Hello` 并完成 `READY` 鉴权。
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置、结构化调试日志（控制台 + 文件 + auto 彩色）、领域模型、规则引擎、审计日志、权限模型、权限自助查询、超管权限配置、OpenID ↔ QQ号/群号映射、全状态持久化（SQLite 默认 / PostgreSQL 可选：绑定关系、权限、审计、入群申请、群配置、全量消息模式、活动报名）、动态权限帮助、私信指令、全量消息模式诊断、多群配置、入群审核状态机、入群审批调用官方接口（含自动通过）、官方申请同步（`/sync`）、群配置关键词驱动的消息审核、`/rules set` 群规则配置、`/audit` 审计查询、官方禁言/踢人接口（请求体已按官方文档核对）、事件路由、事件网关抽象、官方 WebSocket 协议网关（自动重连 + Resume 会话恢复 + 心跳 ACK 超时检测 + 指数退避 + 限流冷却）、官方事件映射器、原生 WebSocket 工厂、access token 与网关地址持久化缓存、出站消息节流与 22009 重试、401 自动刷新、`/test` 自检指令、运行时装配、数据库 schema/迁移/方言适配与全部仓储、管理员命令、活动报名、信息导出、官方 API 客户端与测试替身。
- 待实现：真实环境联调、Web 管理后台、内容安全与 AI 辅助。
- 测试：Vitest，共 286 个测试（SQLite 与 PostgreSQL 方言均覆盖）。

## 技术栈

| 组件 | 选型 |
|---|---|
| 运行时 | Node.js 24+（内置 `node:sqlite`） |
| 语言 | TypeScript |
| 包管理器 | pnpm |
| 测试 | Vitest |
| 类型检查 | TypeScript `tsc --noEmit` |
| 构建 | TypeScript `tsc` |
| HTTP 客户端 | 原生 `fetch` + 可替换 transport |
| 数据库 | SQLite（默认，零配置）／ PostgreSQL 16（可选） |
| 部署 | Docker Compose |
| 许可证 | Apache-2.0 |

## 目标功能

### MVP

- 入群申请审核
- 关键词、正则与基础规则消息管理
- 违规消息处理（撤回能力以官方 API 实际权限为准）
- 操作日志与审计记录
- QQ 群/私聊指令审批与查询
- `/myperm` 权限自助查询
- `/perm` 超管权限配置
- `/help` 仅显示当前用户有权限执行的指令
- 私信指令支持（群管理指令需提供 `group_openid` 或已绑定群号）
- `/bind` 绑定 QQ号 / 群号
- 强制绑定 QQ 号和群号后才能使用（`/help`、`/bind` 除外）
- 全部运行状态默认持久化到 SQLite 文件，进程重启后不丢失；可切换 PostgreSQL
- 支持直接用 QQ号 / 群号执行权限和群管理命令
- `/test` 机器人自检指令
- 多群统一默认配置 + 单群覆盖

### 非 @ 指令识别

群管理员需要在机器人资料页开启“接收所有消息”。开启后官方会推送 `GROUP_MESSAGE_CREATE`，机器人可以识别不带 `@` 的 `/` 指令。

机器人会记录 `GROUP_MSG_RECEIVE` / `GROUP_MSG_REJECT`，可以在群里发送 `/status` 查看：

```text
全量消息模式：all | at_only | unknown
```

- `all`：已开启，可识别非 @ 指令
- `at_only`：已关闭，只接收 @ 消息
- `unknown`：尚未收到开启/关闭事件

### 后续阶段

- Web 管理后台
- 图片、文件与链接内容安全
- 加好友 / 群邀请审核
- 举报与申诉流程
- 活动报名：活动发布、报名收集、名单管理、签到/统计
- 信息导出：审核日志、报名名单、活动数据导出
- AI 辅助审核与入群理由判断
- 统计报表与自动化策略

## 非目标

- 不使用个人 QQ 号协议端。
- 不默认长期保存聊天原文。
- 不在官方能力未确认前实现依赖未确认能力的“硬承诺”。

## 快速开始

```bash
corepack enable
pnpm install
cp .env.example .env
# 然后按需填写 .env（默认使用 SQLite，无需配置数据库）
```

默认数据库是 SQLite 文件 `data/qq-group-ops.db`，启动时自动建表，不需要 Docker 或额外的数据库服务。

如果默认 npm 源不可用，可使用镜像：

```bash
pnpm install --registry=https://registry.npmmirror.com
```

`pnpm dev`、`pnpm start` 会自动读取项目根目录的 `.env`。

`pnpm dev` 会默认使用 `debug` 日志级别，控制台按 `LOG_COLOR=auto` 自动判断是否彩色，并把日志写入 `logs/qq-group-ops.log`。

`pnpm dev` 或 `node dist/main.js` 启动后会连接官方 WebSocket 网关。

常用命令：

```bash
pnpm dev         # 本地开发入口
pnpm db:up       # 可选：用 Docker Compose 启动 PostgreSQL
pnpm test        # 运行 Vitest
pnpm typecheck   # TypeScript 类型检查
pnpm build       # 编译到 dist/
pnpm start       # 运行编译后的入口
```

默认使用 SQLite，启动会自动建表并载入全部持久化状态。想切到 PostgreSQL 时，在 `.env` 里设置 `DATABASE_URL=postgres://...` 并执行 `pnpm db:up`；`DATABASE_URL=memory` 则是纯内存模式（重启即丢）。

## 项目结构

```text
.
├── .github/workflows/       # CI
├── docs/                    # 架构、路线图、配置与合规文档
├── src/
│   ├── adapters/            # 官方 API 客户端、fetch transport、测试替身
│   ├── core/                # 领域模型与枚举
│   ├── db/                  # schema、迁移、SQLite/PostgreSQL 适配、写穿透队列与仓储
│   ├── services/            # 规则、审核、权限、活动、导出、命令
│   ├── config.ts            # 环境配置
│   ├── persistence.ts       # 数据库目标解析、连接与仓储装配
│   └── main.ts              # 入口
├── test/                    # Vitest 测试
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
└── docker-compose.yml
```

## 架构概览

```text
QQ 官方开放平台
      │ WebSocket / Webhook
      ▼
官方接入层（Phase 1 实现）
      │
      ▼
QQ Group Ops 核心服务
  ├── 入群审核 / 同步
  ├── 规则引擎 / 消息审核
  ├── 管理员命令
  ├── 活动报名
  ├── 信息导出
  └── 审计日志
      │
      ├── 持久化（默认 SQLite，可选 PostgreSQL）
      └── Web 管理 API（Phase 2）
```

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [配置模板说明](docs/CONFIGURATION.md)
- [路线图](docs/ROADMAP.md)
- [数据合规建议](docs/DATA-COMPLIANCE.md)
- [关键决策](docs/DECISIONS.md)

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

安全问题请参考 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE)
