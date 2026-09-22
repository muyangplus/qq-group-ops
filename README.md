# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Node.js / TypeScript 重写完成，MVP 核心进行中**
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置、领域模型、规则引擎、审计日志、权限模型、多群配置、入群审核状态机、入群申请同步、消息审核执行、事件路由、事件网关抽象、WebSocket 网关骨架、自动重连网关、原生 WebSocket 工厂、事件映射器、`/test` 自检指令、运行时装配、PostgreSQL schema/迁移/连接池适配与审计/入群申请/群配置仓储、管理员命令、活动报名、信息导出、官方 API 客户端与测试替身。
- 待实现：真实官方事件格式映射、真实 WebSocket 连接验证、PostgreSQL 生产连接与迁移命令、Web 管理后台、内容安全与 AI 辅助。
- 测试：Vitest，共 106 个测试。

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
- `/test` 机器人自检指令
- 多群统一默认配置 + 单群覆盖

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
