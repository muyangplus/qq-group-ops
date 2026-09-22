# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Node.js / TypeScript 重写完成，官方 WebSocket 网关已鉴权成功，MVP 核心进行中**
- 已验证：官方 WebSocket 网关已收到 `Hello` 并完成 `READY` 鉴权。
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置、结构化调试日志（控制台 + 文件 + auto 彩色）、领域模型、规则引擎、审计日志、权限模型、权限自助查询、超管权限配置、OpenID ↔ QQ号/群号映射、私信指令、全量消息模式诊断、多群配置、入群审核状态机、入群申请同步、消息审核执行、事件路由、事件网关抽象、官方 WebSocket 协议网关、官方事件映射器、自动重连网关、原生 WebSocket 工厂、`/test` 自检指令、运行时装配、PostgreSQL schema/迁移/连接池适配与审计/入群申请/群配置仓储、管理员命令、活动报名、信息导出、官方 API 客户端与测试替身。
- 待实现：映射与权限持久化、真实环境联调、自动重连与 Resume 恢复、PostgreSQL 生产连接与迁移命令、Web 管理后台、内容安全与 AI 辅助。
- 测试：Vitest，共 147 个测试。

## 技术栈

| 组件 | 选型 |
|---|---|
| 运行时 | Node.js 20.11+ |
| 语言 | TypeScript |
| 包管理器 | pnpm |
| 测试 | Vitest |
| 类型检查 | TypeScript `tsc --noEmit` |
| 构建 | TypeScript `tsc` |
| HTTP 客户端 | 原生 `fetch` + 可替换 transport |
| 数据库 | PostgreSQL（schema 与审计仓储已定义，生产接入待完成） |
| 部署 | Docker Compose |
| 许可证 | Apache-2.0 |

## 目标功能

### MVP

- 入群申请审核
- 关键词、正则与基础规则消息管理
- 违规消息处理（撤回能力以官方 API 实际权限为准）
- 操作日志与审计记录
- QQ 群/私聊指令审批与查询
- `/myid` 查询自己的官方 userId
- `/myperm` 权限自助查询
- `/perm` 超管权限配置
- 私信指令支持（群管理指令需提供 `group_openid` 或已绑定群号）
- `/bind` 绑定 QQ号 / 群号
- 强制绑定 QQ 号后才能使用（`/help`、`/bind`、`/myid` 除外）
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
# 然后按需填写 .env
```

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
pnpm test        # 运行 Vitest
pnpm typecheck   # TypeScript 类型检查
pnpm build       # 编译到 dist/
pnpm start       # 运行编译后的入口
```

## 项目结构

```text
.
├── .github/workflows/       # CI
├── docs/                    # 架构、路线图、配置与合规文档
├── src/
│   ├── adapters/            # 官方 API 客户端、fetch transport、测试替身
│   ├── core/                # 领域模型与枚举
│   ├── services/            # 规则、审核、权限、活动、导出、命令
│   ├── config.ts            # 环境配置
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
      ├── PostgreSQL
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
