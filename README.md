# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Node.js / TypeScript 重写完成，官方 WebSocket 网关已鉴权成功，MVP 核心进行中**
- 已验证：官方 WebSocket 网关已收到 `Hello` 并完成 `READY` 鉴权。
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置、结构化调试日志（控制台 + 文件 + auto 彩色）、领域模型、规则引擎、审计日志、权限模型、权限自助查询、超管权限配置、OpenID ↔ QQ号/群号映射、全状态持久化（SQLite 默认 / PostgreSQL 可选：绑定关系、权限、审计、入群申请、群配置、全量消息模式、活动报名、推送订阅与投递记录）、数据保留清理（审计、已审批申请与推送投递，启动 + 每 24 小时）、动态权限帮助、私信指令、全量消息模式诊断、多群配置、入群审核状态机、入群审批调用官方接口（含自动通过）、官方申请同步（`/sync`）、关键词命中动作（撤回 / 禁言 / 移出 / 拉黑）、班级库驱动的入群审核规则（班级+姓名+正则、5 档决策模式、审核意见）、入群申请推送（`/notify` 订阅 + Markdown 卡片 + 快捷同意/拒绝按钮）、群配置关键词驱动的消息审核、`/rules set` 群规则配置、`/audit` 审计查询、官方禁言/踢人/黑名单接口（请求体已按官方文档核对）、事件路由、事件网关抽象、官方 WebSocket 协议网关（自动重连 + Resume 会话恢复 + 心跳 ACK 超时检测 + 指数退避 + 限流冷却）、官方事件映射器、原生 WebSocket 工厂、access token 与网关地址持久化缓存、出站消息节流与 22009 重试、被动回复配额拦截、401 自动刷新、事件与回复失败容错、`/test` 自检指令、运行时装配、数据库 schema/迁移/方言适配与全部仓储、管理员命令、活动报名、信息导出、官方 API 客户端与测试替身、个人资料（`/profile`：班级/学院/姓名/学号，支持智能识别）、班级别名表（`/alias`：习惯写法 → 规范名，profile 与入群审核共用）、活动模块（发布/报名/管理 + 卡片一键报名 + 学院/年级白黑名单）、关键词豁免（审核员及以上）。
- 待实现：真实环境联调、Web 管理后台、内容安全与 AI 辅助。
- 交互菜单：QQ 端 `/menu` 三级菜单（系统 / 管理 / 超管），按权限过滤入口，按钮即指令、自动三级降级；空 `@机器人`、未知指令、私信首次交互都会回到菜单主入口。
- 回调链路：新增 `INTERACTION (1<<26)` intent 与 `INTERACTION_CREATE` 事件处理，`/testmenu` 用回调按钮翻页（回包 `PUT /interactions/{id}` + 主动发送新一页；官方没有更新原卡片的能力，旧卡片会保留）。
- 卡片标准：**所有指令输出统一为菜单式卡片**（导航/查看/开关/枚举用回调自动完成、需要参数或不可逆的动作用指令按钮、列表用回调翻页 + `+页码` 降级），规范见 [docs/CARD-STANDARD.md](docs/CARD-STANDARD.md)；已迁移 `/help`、`/status`、`/pending`、`/rules`、`/audit`、`/test`、`/sync`、`/approve`、`/reject`、`/notify`，其余指令按批次迁移。
- 规则菜单（§C）：`/rules` 为**概览卡 + 5 个子卡**（开关设置 / 入群审核 / 违规处理 / 关键词 / 名单筛选 / 更多设置），开关标签显示**当前状态**，每张子卡可「恢复本页继承」、概览可「恢复全部继承」；新增 `/rules add|del keyword` 逐条增删与 `/rules overrides` 覆盖率总览；全局规则卡与群规则同构（只影响未覆盖的群）。
- 待办与已知限制：[TODO.md](./TODO.md)（待澄清 / 已知限制 / 待真机验收 / 新功能待办的唯一入口）。
- 测试：Vitest，共 686 个测试（含端到端验收干跑；SQLite 与 PostgreSQL 方言均覆盖）。

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
| `/perm`、`/rules all`、`/bind user\|groupid`、`/whois`、`/alias`（平台级） | ✅ | ❌ | ❌ | ❌ |
| `/approve`、`/reject`、`/rules set`、`/bind group` | ✅ | ✅（仅本群） | ✅（仅本群） | ❌ |
| `/pending`、`/sync`、`/audit`、`/test`、`/rules`、`/status` | ✅ | ✅（仅本群） | ✅（仅本群） | ✅（仅本群） |
| `/profile`、`/activity join\|quit\|info\|subscribe`（个人能力） | ✅ | ✅ | ✅ | ✅ |
| `/activity create\|set\|open\|close\|cancel\|signups`（发布与管理活动） | ✅ | ✅（仅本群） | ✅（仅本群） | ❌ |
| `cb:activity:*`（活动回调，renderer 内重新校验） | ✅ | ✅（仅本群） | ✅（仅本群） | ❌ |

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
- 角色授权**不豁免**「先 `/bind qq`」的要求，被授权用户仍需先绑定自己的 QQ 号；
- **用户可见输出只显示解析号**：只要 QQ号/群号已绑定，`/pending`、`/sync`、推送卡片、`/audit`、`/status`、`/test`、`/perm list`、`/rules`、`/notify` 等输出都只显示 QQ号/群号，不再显示内部 `userId`/`group_openid`；未绑定时才回退显示内部 id（`/whois` 例外，它本身就是映射查询）。
- **关键词豁免**：**审核员及以上**（moderator / 群管理员 / 本群超管 / 全局超管）的消息不做关键词判断——不警告、不撤回、不处罚，也不写审计，只记 debug 日志；普通成员照常处理。
- **全局超管的私信体验**：私信里查看群指令帮助（`/help rules`、`/help approve`、`/help notify` 等）不受群上下文限制；私信直接发 `/rules` 等价于 `/rules all`（查看全局默认规则）。

## 文档

- [**快速开始 / 部署 / 排障**（含迎新晚会完整示例）](docs/OPERATIONS.md)
- [**指令参考**（`/help`、`/menu` 与全部指令用法）](docs/COMMANDS.md)
- [配置模板说明（环境变量逐项）](docs/CONFIGURATION.md)
- [卡片标准（所有指令输出规范）](docs/CARD-STANDARD.md)
- [架构设计](docs/ARCHITECTURE.md)
- [关键决策（ADR）](docs/DECISIONS.md)
- [开发指南](docs/DEVELOPMENT.md)
- [路线图](docs/ROADMAP.md)
- [真实环境验收清单](docs/ACCEPTANCE.md)
- [数据合规建议](docs/DATA-COMPLIANCE.md)
- [待办与已知限制](TODO.md)（待澄清 / 已知限制 / 待真机验收 / 新功能待办的唯一入口）
- [变更日志](CHANGELOG.md)

## 贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

安全问题请参考 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE)
