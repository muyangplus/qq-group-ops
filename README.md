# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Node.js / TypeScript 重写完成，官方 WebSocket 网关已鉴权成功，MVP 核心进行中**
- 已验证：官方 WebSocket 网关已收到 `Hello` 并完成 `READY` 鉴权。
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置、结构化调试日志（控制台 + 文件 + auto 彩色）、领域模型、规则引擎、审计日志、权限模型、权限自助查询、超管权限配置、OpenID ↔ QQ号/群号映射、全状态持久化（SQLite 默认 / PostgreSQL 可选：绑定关系、权限、审计、入群申请、群配置、全量消息模式、活动报名）、数据保留清理（审计与已审批申请，启动 + 每 24 小时）、动态权限帮助、私信指令、全量消息模式诊断、多群配置、入群审核状态机、入群审批调用官方接口（含自动通过）、官方申请同步（`/sync`）、群配置关键词驱动的消息审核、`/rules set` 群规则配置、`/audit` 审计查询、官方禁言/踢人接口（请求体已按官方文档核对）、事件路由、事件网关抽象、官方 WebSocket 协议网关（自动重连 + Resume 会话恢复 + 心跳 ACK 超时检测 + 指数退避 + 限流冷却）、官方事件映射器、原生 WebSocket 工厂、access token 与网关地址持久化缓存、出站消息节流与 22009 重试、被动回复配额拦截、401 自动刷新、事件与回复失败容错、`/test` 自检指令、运行时装配、数据库 schema/迁移/方言适配与全部仓储、管理员命令、活动报名、信息导出、官方 API 客户端与测试替身。
- 待实现：真实环境联调、Web 管理后台、内容安全与 AI 辅助。
- 测试：Vitest，共 333 个测试（含端到端验收干跑；SQLite 与 PostgreSQL 方言均覆盖）。

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

## 权限模型（全局超管 / 本群超管）

权限分为两层，且都是**手工配置**的——不会根据 QQ 群主/管理员身份自动授予（官方成员接口目前是内邀白名单能力，普通机器人拿不到角色数据）。

| 角色 | 作用域 | 授予方式 |
|---|---|---|
| 全局超级管理员 | 全平台 | `ADMIN_USER_IDS` 种子，或 `/perm grant super <userId\|QQ号>` |
| 本群超级管理员 | 单个群 | `/perm grant gsuper [group_openid\|群号] <userId\|QQ号>` |
| 群管理员 | 单个群 | `/perm grant admin [group_openid\|群号] <userId\|QQ号>` |
| 审核员 | 单个群 | `/perm grant mod [group_openid\|群号] <userId\|QQ号>` |

能力对照：

| 能力 | 全局超管 | 本群超管 | 群管理员 | 审核员 |
|---|---|---|---|---|
| `/perm`、`/rules all`、`/bind user\|groupid`、`/whois`（平台级） | ✅ | ❌ | ❌ | ❌ |
| `/approve`、`/reject`、`/rules set`、`/bind group` | ✅ | ✅（仅本群） | ✅（仅本群） | ❌ |
| `/pending`、`/sync`、`/audit`、`/test`、`/rules`、`/status` | ✅ | ✅（仅本群） | ✅（仅本群） | ✅（仅本群） |

```text
/myperm                                  # 查看自己的权限（含全局/本群超管标记）
/perm list                               # 查看全局超管 + 本群角色（需给群号或群内执行）
/perm grant gsuper 654321 123456789      # 私信：把 QQ 123456789 设为本群超管（654321 群）
/perm revoke gsuper 654321 123456789
/perm grant gsuper u4                    # 群内：把 u4 设为本群超管
```

要点：

- **本群超管只在自己群里是最高权限**：换个群就是普通成员，私信里也没有平台级能力；
- 每个群的角色单独配置、互不影响；
- 存储上本群超管复用 `permission_grants` 的 `scope='super_admin'` + 非空 `group_id`，**无需改表结构**；
- `ADMIN_USER_IDS` 只在数据库里没有任何**全局**超管时作为种子写入（只存在本群超管时仍会种子，避免全局超管被锁死）；
- 角色授权**不豁免**「先 `/bind qq`」的要求，被授权用户仍需先绑定自己的 QQ 号。

## 指令帮助（`/help`）

```text
/help                # 列出你有权限执行的指令（未绑定用户只看到 /help、/bind）
/help <指令>          # 查看某个指令的详细用法
/help 规则            # 中文别名同样可用
/help /rules         # 带前导斜杠也可以
```

可用主题：

| 主题 | 内容 | 需要权限 |
|---|---|---|
| `/help`、`/help help` | 指令列表与用法 | 无 |
| `/help bind` | 绑定 QQ号/群号，含你当前的绑定状态 | 无 |
| `/help myperm` | 权限等级说明与你的当前等级 | 无 |
| `/help rules` | 群规则/全局规则的完整字段说明 + 该群当前生效值 | 查看需审核员+，修改需群管理员+ |
| `/help perm` | 角色模型与 `/perm grant\|revoke` 全部写法 | 全局超管 |
| `/help whois` | 查询 OpenID ↔ QQ号/群号 映射 | 全局超管 |
| `/help pending`、`/help sync` | 待审批队列与官方同步 | 审核员+ |
| `/help audit` | 审计记录查询 | 审核员+ |
| `/help status` | 群运行状态（含全量消息模式） | 审核员+ |
| `/help test` | 机器人自检 | 审核员+ |
| `/help approve`、`/help reject` | 入群审批用法与「先官方后本地」说明 | 群管理员+ |

示例：`/help rules` 在群内执行时会附带当前生效值，便于确认配置是否真的生效：

```text
/rules — 群规则配置
所需权限：审核员或以上（查看）／群管理员或以上（修改）

修改本群规则（群管理员或以上）
  /rules set keywords 广告,刷屏,加群     设置关键词（逗号/顿号/空格分隔）
  /rules set autoApprove on|off       新入群申请自动通过
  ...

当前生效值：
  启用 true · 关键词过滤 true · 入群审核 true · 自动通过 false · 导出 false
  关键词：刷屏、广告
  警告文案：请遵守群规，不要发送违规内容。
  禁言时长：600 秒
```

说明：

- 主题详情同样做权限过滤：没有权限时只告诉你需要什么权限，不会展示你执行不了的命令（与 `/help` 只列有权限指令保持一致）；
- `/help` 与 `/help <主题>` 都**不要求绑定**，未绑定用户可以先看帮助；
- 输入未知主题时会提示用法并回退到指令列表。

## 配置群规则（完整示例）

群规则决定机器人在这个群里做什么：关键词过滤、命中后的警告文案、是否审核入群、是否自动通过。规则保存在数据库里（SQLite / PostgreSQL），重启不丢；修改后立即生效，不需要重启机器人。

### 权限与前置条件

| 操作 | 指令 | 需要权限 |
|---|---|---|
| 查看本群规则 | `/rules` | 审核员（moderator，`/perm grant mod`）及以上 |
| 修改本群规则 | `/rules set ...` | 群管理员（admin，`/perm grant admin`）及以上 |
| 查看全局规则 | `/rules all` | 超级管理员 |
| 修改全局规则 | `/rules set all ...` | 超级管理员 |

前置条件（强制绑定，见 [配置说明](docs/CONFIGURATION.md)）：

- 使用者先绑定自己的 QQ 号：`/bind qq <QQ号>`
- 在群内执行群指令前，本群要先绑定群号（由群管理员执行）：`/bind group <群号>`
- 私信中操作某个群时，需要把该群已绑定的**群号**或 `group_openid` 写在指令里

### 1. 查看当前规则

群内：

```text
/rules
```

私信（指定群）：

```text
/rules 654321
/rules 0123456789ABCDEF0123456789ABCDEF
```

返回示例：

```text
群 0123456789ABCDEF0123456789ABCDEF 规则配置：
启用：true
关键词过滤：true
关键词：（未配置）
入群审核：true
自动通过：false
导出功能：false
警告文案：请遵守群规，不要发送违规内容。
禁言时长：600 秒
```

### 2. 配置关键词（最常用）

群内：

```text
/rules set keywords 广告,刷屏,加群
/rules set keywords 广告 刷屏 加群
/rules set keywords 广告、刷屏、加群
/rules set keywords clear
```

私信（带群号，`<group_openid|群号>` 二者皆可）：

```text
/rules set 654321 keywords 广告,刷屏
/rules set 0123456789ABCDEF0123456789ABCDEF keywords 广告,刷屏
```

说明：

- 分隔符支持英文逗号 `,`、中文逗号 `，`、顿号 `、` 和空格，可混用；
- 关键词会**去重、去空白并按字典序保存**，所以 `/rules` 里显示的顺序可能和输入顺序不同；
- 命中任一关键词即触发**警告**：发送下面的「警告文案」，并写一条审计记录（`/audit` 可查）；
- `clear`（也接受 `清空`、`默认`、`reset`）表示清空关键词；
- 修改立即生效。

### 3. 自定义警告文案

```text
/rules set warning 本群禁止广告，请撤回并阅读群规。
/rules set warning clear
```

`clear` 会把文案恢复为默认值 `请遵守群规，不要发送违规内容。`

### 4. 开关类配置

```text
/rules set wordFilter off       # 关闭关键词过滤（关键词会保留，方便随时开回）
/rules set joinAudit off        # 关闭入群审核开关（见下方说明）
/rules set autoApprove on       # 新入群申请自动通过
/rules set export on            # 导出功能开关
/rules set enabled off          # 关闭本群机器人
```

开关取值：`on` / `off`，同时接受 `true`/`false`、`1`/`0`、`yes`/`no`、`开`/`关`、`启用`/`关闭`、`是`/`否`。

各开关的实际作用：

| 开关 | 作用 |
|---|---|
| `wordFilter` | 关键词过滤总开关；关闭后命中也不再警告，但关键词配置保留 |
| `enabled` | 本群总开关；关闭后停止关键词审核与自动通过（管理指令仍可用） |
| `joinAudit` | 目前只作为「自动通过」的前置条件；不会禁用 `/pending`、`/sync`、`/approve` |
| `autoApprove` | 需要 `enabled` 与 `joinAudit` 同时开启才会自动通过新申请 |
| `export` | 目前仅存储与展示，导出能力的鉴权以权限模型为准 |

### 5. 禁言时长

```text
/rules set muteDuration 600
```

单位是秒，取值必须是非负整数，上限 30 天（`2592000` 秒，超出会被截断）。

> 当前版本关键词命中的动作固定为「警告」，禁言/踢人动作需要在 `src/services/moderation.ts` 的规则引擎中配置动作后才会用到这个时长，因此 `muteDuration` 属于预留配置。

### 6. 全局规则（`all`）

上面所有字段都可以配置成**全局默认规则**，语法是在字段前加 `all`。未单独配置过的群会继承全局规则；只要某个群设置过该字段，就以该群自己的配置为准。

```text
/rules all                              # 查看全局默认规则
/rules set all keywords 广告,刷屏        # 全局关键词
/rules set all warning 本群禁止广告。    # 全局警告文案
/rules set all wordFilter on
/rules set all joinAudit on
/rules set all autoApprove off
/rules set all muteDuration 600
/rules set all enabled on
/rules set all keywords clear           # 清空全局关键词
```

说明：

- `all` 也可以写成 `global` / `default` / `全局` / `默认`，例如 `/rules 全局`、`/rules set 全局 keywords 广告`；
- **全局规则仅超级管理员可以查看与修改**（群管理员只能改自己群的规则）；
- 全局规则持久化在数据库里（`group_configs` 中 `group_id = __default__` 的那一行 + `group_keywords`），重启不丢；
- 群内执行时会照常要求「本群已绑定」；私信中直接执行即可（需要超级管理员且已绑定 QQ 号）；
- 继承是**按字段**生效的：例如全局设了 `keywords 广告`，某群只设了 `autoApprove on`，那么该群仍然是「全局关键词 + 自己的 autoApprove」。

继承与覆盖示例：

```text
# 1. 超管设置全局关键词
/rules set all keywords 广告

# 2. 未配置过的群：命中「广告」会被警告
# 3. 群 A 单独配置了自己的关键词
/rules set keywords 本群违禁词
#    → 群 A 只认「本群违禁词」，不再继承全局的「广告」

# 4. 查看全局与单群
/rules all
/rules
```

### 7. 一次性配好（推荐流程）

群内依次执行：

```text
/bind qq 123456789
/rules set keywords 广告,刷屏,加群,代刷
/rules set warning 本群禁止广告与刷屏，请撤回并阅读群规。
/rules set wordFilter on
/rules set joinAudit on
/rules set autoApprove off
/rules set muteDuration 600
/rules
```

私信等价写法（群管理指令需要带群号）：

```text
/bind qq 123456789
/rules set 654321 keywords 广告,刷屏,加群,代刷
/rules set 654321 warning 本群禁止广告与刷屏，请撤回并阅读群规。
/rules set 654321 wordFilter on
/rules set 654321 joinAudit on
/rules set 654321 autoApprove off
/rules set 654321 muteDuration 600
/rules 654321
```

后续调整只发需要改的那一条即可（每次 `set` 只更新指定字段，不会重置其他字段）：

```text
/rules set keywords 广告,刷屏,加群,代刷,外挂
/rules set autoApprove on
```

### 8. 验证是否生效

1. 在群里发一条包含关键词的消息，机器人应回复你配置的警告文案；
2. `/audit` 查看最近记录，应出现 `moderation:warn`，reason 为 `命中关键词：<关键词>`；
3. `/status` 查看该群运行状态（启用、过滤、全量消息模式等）。

### 9. 字段速查表

| 字段 | 别名 | 取值 | 说明 |
|---|---|---|---|
| `keywords` | `keyword`、`关键词` | 关键词列表；`clear` 清空 | 命中即警告 |
| `warning` | `warningMessage`、`警告` | 任意文案；`clear` 恢复默认 | 命中后发送的文案 |
| `muteDuration` | `mute`、`禁言时长` | 非负整数秒，≤ `2592000` | 预留：禁言动作使用的时长 |
| `wordFilter` | `关键词过滤` | on / off | 关键词过滤总开关 |
| `joinAudit` | `入群审核` | on / off | 自动通过的前置开关 |
| `autoApprove` | `自动通过` | on / off | 新入群申请自动通过 |
| `export` | `导出` | on / off | 导出开关（当前仅存储展示） |
| `enabled` | `启用` | on / off | 本群机器人总开关 |

作用域写法：

| 写法 | 作用 | 需要权限 |
|---|---|---|
| `/rules set <字段> <值>` | 当前群 | 群管理员 |
| `/rules set <group_openid\|群号> <字段> <值>` | 指定群（私信） | 群管理员 |
| `/rules set all <字段> <值>`（或 `global`/`default`/`全局`/`默认`） | 全局默认，所有未单独覆盖的群继承 | 超级管理员 |

### 10. 常见报错

| 提示 | 原因与处理 |
|---|---|
| `权限不足：需要群管理员或以上权限。` | `/rules set` 需要群管理员或超管；`/rules` 只需审核员及以上 |
| `权限不足：全局规则仅超级管理员可以查看与修改。` | `/rules all`、`/rules set all ...` 仅超管可用 |
| `请先绑定 QQ 号：/bind qq <QQ号>` | 先绑定自己的 QQ 号 |
| `请先绑定本群：/bind group <群号>` | 群管理员先在群里绑定群号 |
| `设置失败：未知字段：xxx` | 字段名写错，对照上面的速查表 |
| `设置失败：xxx 需要 on 或 off` | 开关只能填 on/off 及其同义写法 |
| `设置失败：禁言时长需要非负整数（秒）` | `muteDuration` 只能填数字 |
| `私信中设置规则需要提供已绑定的 group_openid 或群号。` | 私信里必须写群号或 `group_openid`（全局规则写 `all`） |
| 配了关键词但没反应 | 检查 `/rules`（或 `/rules all`）里 `启用` 与 `关键词过滤` 是否为 `true`；非 @ 的普通消息还需要群管理员在机器人资料页开启「接收所有消息」 |

更多细节见 [配置说明](docs/CONFIGURATION.md) 与 [真实环境验收清单](docs/ACCEPTANCE.md)。

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
- [真实环境验收清单](docs/ACCEPTANCE.md)
- [数据合规建议](docs/DATA-COMPLIANCE.md)
- [关键决策（ADR）](docs/DECISIONS.md)
- [变更日志](CHANGELOG.md)

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

安全问题请参考 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE)
