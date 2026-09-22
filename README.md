# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Phase 0 待实测 / Phase 1 服务层骨架已完成**
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置加载、领域模型、规则引擎、审计日志抽象、权限模型、多群配置、入群审核状态机。
- 待实现：官方 REST 客户端、NoneBot2 插件、PostgreSQL 持久化、Web 后台。
- 生产可用性：尚未达到；Phase 0 能力验证完成前，不承诺全部功能可用。

## 目标功能

### MVP

- 入群申请审核
- 关键词、正则与基础规则消息管理
- 违规消息处理（撤回能力以官方 API 实际权限为准）
- 操作日志与审计记录
- QQ 群/私聊指令审批与查询
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
- 不在 Phase 0 验证前实现依赖未确认官方能力的“硬承诺”。

## 技术栈

| 组件 | 选型 |
|---|---|
| 语言 | Python 3.11+ |
| 事件与消息框架 | NoneBot2 + nonebot-adapter-qq |
| 官方 REST 调用 | 自研 `QQOfficialClient` 适配层 |
| Web 管理后台 | FastAPI + Vue 3 + TypeScript（Phase 2） |
| 数据库 | PostgreSQL 16（开发可用 SQLite） |
| 定时任务 | APScheduler |
| 部署 | Docker Compose + Caddy/Nginx |
| 测试 | 标准库 `unittest`（后续可迁移 pytest） |

## 架构概览

```text
QQ 官方开放平台
      │ WebSocket / Webhook
      ▼
nonebot-adapter-qq
      │
      ▼
QQ Group Ops 业务层
  ├── 入群审核
  ├── 消息规则引擎
  ├── 群管动作
  └── 审计日志
      │
      ├── PostgreSQL
      └── FastAPI 管理 API（Phase 2）
```

## Phase 0：必须先验证的官方能力

完整清单见 [docs/PHASE-0-VERIFICATION.md](docs/PHASE-0-VERIFICATION.md)。

1. 官方 bot 能否接收未 @ 的全量群消息。
2. 官方 bot 能否撤回其他成员的消息。
3. 官方 bot 能否审批好友申请 / 群邀请。
4. 官方 API 的频率限制、配额与可管理群数量。
5. 当前开发者账号与 AppID 是否已开通群聊能力。
6. 内容安全 API 的价格、数据使用与跨境合规。
7. 部署环境的架构、端口、证书与备份条件。

## 快速开始

> Phase 0 完成前，以下步骤只用于本地开发和结构验证。

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux / macOS
source .venv/bin/activate

pip install -e ".[dev]"
cp .env.example .env
```

运行纯标准库测试：

```bash
# Windows PowerShell
$env:PYTHONPATH="src"; python -m unittest discover -s tests -v

# Linux / macOS
PYTHONPATH=src python -m unittest discover -s tests -v
```

运行本地骨架入口：

```bash
# Windows PowerShell
$env:PYTHONPATH="src"; python -m qq_group_ops

# Linux / macOS
PYTHONPATH=src python -m qq_group_ops
```

## 项目结构

```text
.
├── .github/workflows/          # CI
├── docs/
│   ├── ARCHITECTURE.md         # 架构设计
│   ├── DATA-COMPLIANCE.md      # 数据合规建议
│   ├── DECISIONS.md            # 关键决策记录
│   ├── PHASE-0-VERIFICATION.md # Phase 0 验证清单
│   └── ROADMAP.md              # 分阶段路线图
├── scripts/                    # 开发脚本
├── src/qq_group_ops/
│   ├── adapters/               # 官方 API 适配层
│   ├── core/                   # 领域模型
│   ├── plugins/                # NoneBot2 插件入口
│   ├── services/               # 规则、审核、审计服务
│   └── web/                    # FastAPI 管理后台
└── tests/                      # 单元测试
```

## 路线图

详见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

如果发现安全问题，请不要公开创建 Issue，先参考 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
