# QQ Group Ops

> 基于 QQ 官方开放平台 API 的开源 QQ 群管理与运营平台：群管理、审核、活动报名、信息导出。

## 项目状态

- 当前阶段：**Node.js / TypeScript 重写完成，官方 WebSocket 网关已鉴权成功，MVP 核心进行中**
- 已验证：官方 WebSocket 网关已收到 `Hello` 并完成 `READY` 鉴权。
- 技术路线：**仅使用 QQ 官方开放平台 API**，不使用 OneBot、NapCat、Lagrange 等个人号协议端。
- 已实现：配置、结构化调试日志（控制台 + 文件 + auto 彩色）、领域模型、规则引擎、审计日志、权限模型、权限自助查询、超管权限配置、OpenID ↔ QQ号/群号映射、全状态持久化（SQLite 默认 / PostgreSQL 可选：绑定关系、权限、审计、入群申请、群配置、全量消息模式、活动报名、推送订阅与投递记录）、数据保留清理（审计、已审批申请与推送投递，启动 + 每 24 小时）、动态权限帮助、私信指令、全量消息模式诊断、多群配置、入群审核状态机、入群审批调用官方接口（含自动通过）、官方申请同步（`/sync`）、关键词命中动作（撤回 / 禁言 / 移出 / 拉黑）、班级库驱动的入群审核规则（班级+姓名+正则、5 档决策模式、审核意见）、入群申请推送（`/notify` 订阅 + Markdown 卡片 + 快捷同意/拒绝按钮）、群配置关键词驱动的消息审核、`/rules set` 群规则配置、`/audit` 审计查询、官方禁言/踢人/黑名单接口（请求体已按官方文档核对）、事件路由、事件网关抽象、官方 WebSocket 协议网关（自动重连 + Resume 会话恢复 + 心跳 ACK 超时检测 + 指数退避 + 限流冷却）、官方事件映射器、原生 WebSocket 工厂、access token 与网关地址持久化缓存、出站消息节流与 22009 重试、被动回复配额拦截、401 自动刷新、事件与回复失败容错、`/test` 自检指令、运行时装配、数据库 schema/迁移/方言适配与全部仓储、管理员命令、活动报名、信息导出、官方 API 客户端与测试替身、个人资料（`/profile`：班级/学院/姓名/学号）、活动模块（发布/报名/管理 + 卡片一键报名 + 学院/年级白黑名单）、关键词豁免（审核员及以上）。
- 待实现：真实环境联调、Web 管理后台、内容安全与 AI 辅助。
- 交互菜单：QQ 端 `/menu` 三级菜单（系统 / 管理 / 超管），按权限过滤入口，按钮即指令、自动三级降级；空 `@机器人`、未知指令、私信首次交互都会回到菜单主入口。
- 回调链路：新增 `INTERACTION (1<<26)` intent 与 `INTERACTION_CREATE` 事件处理，`/testmenu` 用回调按钮翻页（回包 `PUT /interactions/{id}` + 主动发送新一页；官方没有更新原卡片的能力，旧卡片会保留）。
- 卡片标准：**所有指令输出统一为菜单式卡片**（导航/查看/开关/枚举用回调自动完成、需要参数或不可逆的动作用指令按钮、列表用回调翻页 + `+页码` 降级），规范见 [docs/CARD-STANDARD.md](docs/CARD-STANDARD.md)；已迁移 `/help`、`/status`、`/pending`、`/rules`、`/audit`、`/test`、`/sync`、`/approve`、`/reject`、`/notify`，其余指令按批次迁移。
- 测试：Vitest，共 507 个测试（含端到端验收干跑；SQLite 与 PostgreSQL 方言均覆盖）。

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
pnpm class:index # 可选：把 data/class.json 转成班级索引（入群审核规则用）
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
| `/profile`、`/activity join\|quit\|info`（个人能力） | ✅ | ✅ | ✅ | ✅ |
| `/activity create\|set\|open\|close\|cancel\|signups`（发布与管理活动） | ✅ | ✅（仅本群） | ✅（仅本群） | ❌ |

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
| `/help notify` | 入群申请推送：订阅范围、卡片与快捷按钮、官方限制 | 群管理员+ |

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
  命中动作：仅警告
  入群决策：manual · 要求班级 false · 要求姓名 false · 审核意见 true
```

说明：

- 主题详情同样做权限过滤：没有权限时只告诉你需要什么权限，不会展示你执行不了的命令（与 `/help` 只列有权限指令保持一致）；
- `/help` 与 `/help <主题>` 都**不要求绑定**，未绑定用户可以先看帮助；
- 输入未知主题时会提示用法并回退到指令列表。

## 系统交互菜单（`/menu`）

QQ 端的图形化入口：**Markdown 卡片 + 按钮**，三级结构（主菜单 → 系统 / 管理 / 超管菜单 → 功能子菜单）。

```text
/menu           主菜单：按权限显示「系统菜单 / 管理菜单 / 超管菜单」入口
/menu sys       系统菜单：帮助 / 绑定 / 我的权限 / 个人资料 / 活动          （所有人）
/menu admin     管理菜单：待审批 / 同步 / 规则 / 审计 / 状态 / 自检        （审核员及以上）
/menu review    审核操作：/approve、/reject 的用法                        （群管理员及以上）
/menu ops       活动运营：活动创建/开停/名单、/export                      （群管理员及以上）
/menu super     超管菜单：/perm、/rules all、/whois、/bind user|groupid    （仅全局超管）
```

```text
## 系统菜单
**用户**：10001
**权限**：群管理员
**当前群**：654321

请选择入口：
[ 系统菜单 ] [ 管理菜单 ]
[ 帮助 ] [ 我的权限 ] [ 我的资料 ]
```

要点：

- 菜单按钮是**指令按钮**：点击等价于发送对应指令（如「待审批列表」= 发送 `/pending`），
  因此权限校验、审计、限流与手输指令完全一致，不存在绕过
  （群里点击是先把指令填进输入框、部分客户端需再按发送；单聊会直接发送，需客户端 8983+）；
- **按权限过滤**：没有权限的入口不会显示；直接发 `/menu admin`、`/menu super` 这类越权指令会被拒绝
  （本群超管请用管理菜单，超管菜单是平台级能力）；
- **自动降级**：自定义按钮是官方内邀白名单能力，未开通时降级为纯 Markdown，再失败降级为纯文本，
  正文里列出同样的指令，功能不丢；
- **私信首次推送**：第一次和机器人私信时会主动推一次主菜单；
  `pnpm dev` 只记内存（重启可再看到一次），正式启动入库持久化（`menu_deliveries`，重启不重复），
  可用 `MENU_FIRST_PUSH=memory|persistent` 显式覆盖；
- **群里 @机器人 不带内容**会直接返回主菜单；未知指令在报错的同时附上菜单按钮；
- 需要参数的指令（如 `/approve <申请ID>`）在菜单正文里给出用法，不提供点不动的死按钮。

## 回调按钮翻页试验（`/testmenu`）

用于验证官方**回调按钮**（`action.type=1`）与互动事件链路的试验指令，**仅全局超管**可用（正式保留）：

```text
/testmenu           从第 1 页开始
/testmenu 2         直接跳到第 2 页（1-3）
```

```text
## 测试菜单（第 1 / 3 页）
用于验证官方回调按钮（INTERACTION_CREATE）翻页。
**当前页**：第 1 / 3 页

点击翻页：
[ 下一页 ] [ 返回第 1 页 ]
[ 指令翻页 2 ]
手动翻页：/testmenu <页码>（1-3）
```

官方能力边界（已按文档核对，务必了解）：

| 项 | 官方现状 | 本项目的处理 |
|---|---|---|
| 回调按钮 | `action.type=1`，点击后推 `INTERACTION_CREATE`（`type=11`），`data.resolved.button_data` 带回按钮的 `data` | 新增 `INTERACTION (1<<26)` intent 与互动事件映射、路由 |
| 必须回包 | 收到后要调 `PUT /interactions/{id}` 回 `{"code":0}`，否则客户端一直 loading 到超时；同一 id 只能回一次 | 收到立即回包（实测 200 成功） |
| **更新原消息** | ❌ **没有该接口**（消息类只有发送与撤回） | 翻页 = 回包后**主动发送**新的一页，不是改写原卡片 |
| **interaction id 当 `msg_id`** | ❌ 实测群聊返回 `400 请求参数msg_id无效或越权`（互动事件文档虽写「id 用于被动消息发送」） | 不再尝试被动回复：少一次注定失败的重试，新页面 ~1 秒内到达 |
| 发送失败 | —— | 自动降级为主动发送（`RichMessageSender` 三级降级），用户仍能看到新的一页 |
| 双通道兜底 | —— | 正文与第二行按钮保留 `/testmenu <页码>`，互动事件没开通也能手动翻页 |

> 结论：QQ 官方**做不出**"原地改写同一张卡"的翻页，也**不能**拿互动事件 id 当被动回复的
> `msg_id`；能做出的是"点一下就（主动）发来下一页"。别把这里的实现描述成原地更新或被动回复。
>
> 当前行为（已确认保留）：**每次翻页发一条新卡片**，旧卡片留在聊天记录里。
> 若以后想要"看起来像原地翻页"，可以用撤回来近似实现（`recallGroupMessage` 已具备，
> 需要能拿到被点击卡片的 `message_id`，群聊互动事件里不保证带）。

## 卡片标准（所有指令统一卡片化）

**所有 QQ 指令的输出都是菜单式卡片**：Markdown 正文 + 按钮 + 纯文本降级。完整规范见
[docs/CARD-STANDARD.md](docs/CARD-STANDARD.md)，要点：

| 用途 | 按钮类型 | 行为 |
|---|---|---|
| 导航 / 查看 / 翻页 / 刷新 | **回调按钮**（`cb:<namespace>:<action>`） | 点击即回包并发出新卡片，不用再发消息 |
| 执行动作（审批、改规则、绑定、危险操作） | **指令按钮** | 点击=发送该指令，与手输同一条权限 / 审计 / 二次确认路径 |

- **降级**：按钮未开通时自动降级为纯文本，正文里的指令可直接复制执行，功能不丢；
- **分页**：列表类每页固定条数，翻页按钮是回调，正文同时给出 `+页码` 指令（如 `/pending +2`）；
- **权限**：看不到的入口不生成按钮；越权调用（指令或回调）都会给出明确原因。

已迁移的样板：

```text
/help            指令列表卡（伞形；/help all 为完整列表）；/help rules 为主题详情卡
/status          运行状态卡 + 刷新/待审批/群规则/帮助 + 自检
/pending         待审批卡：每页 3 条，每条「通过」回调自动完成、「拒绝」指令可补原因
/rules           群规则概览 + 开关设置 / 入群决策 / 命中处罚 三个子卡（全回调自动生效）
/audit           审计分页卡（默认每页 10 条）+ 翻页/刷新回调
/activity        活动列表卡：每页 3 个，每个一行「报名 / 详情 / 名单」，翻页回调
/test            自检卡 + 刷新/待审批/群规则
/sync            同步官方申请（固定动作：指令或回调都能触发，结果带操作人）
/approve /reject 审批结果卡（操作人 + 返回待审批 / 查看审计）
/notify          推送订阅卡（本群/全部群开关与测试推送都是回调，结果带操作人）
```

`/menu` 的每一级都只是**导航**：按钮是回调，点一下就出下一张卡；`/menu` 现在覆盖全部指令
（成员 / 管理 / 超管 + 活动 / 审核操作 / 活动运营），需要参数的指令在正文给出用法，
每张卡底部都列出手动指令，按钮不可用时照样能操作。

> 其余指令（`/audit`、`/notify`、`/myperm`、`/profile`、`/activity`、`/perm`、`/bind` 等）
> 按批次迁移；新增指令必须直接遵循该标准。

## 关键词处罚与入群审核规则

### 关键词命中后做什么（撤回 / 禁言 / 移出 / 拉黑）

命中关键词默认只发警告，可以叠加撤回与处罚：

```text
/rules set keywordRecall on              # 命中后撤回消息
/rules set keywordPunish mute            # 禁言，时长取 muteDuration
/rules set keywordPunish kick            # 移出群
/rules set keywordPunish kick_blacklist  # 移出并加入黑名单（一次调用）
/rules set keywordPunish none            # 只警告（默认）
/rules set muteDuration 600              # 禁言时长（秒）
```

| 动作 | 官方接口 | 限制 |
|---|---|---|
| 撤回 | `DELETE /v2/groups/{g}/messages/{id}` | 机器人需在群内；过旧的消息可能撤回失败 |
| 禁言 | `POST .../restrict_chat_setting` | 机器人需为群管理员，最长 30 天 |
| 移出 | `POST .../batch_remove_members` | **仅白名单机器人可用**（错误码 11253） |
| 移出并拉黑 | 同上 + `add_to_member_blacklist: true` | 同上；纯拉黑用 `POST .../member_blacklist`，要求目标当前不在群中 |

每个动作都是**尽力而为**：单个动作失败（撤回超时、未开通白名单等）只会在日志里体现，不会阻断其他动作；全部失败时 `/audit` 记录的审计状态为 `pending`。

### 班级 / 专业库（`data/class.json` → 索引）

把教务导出的原始 JSON 转成机器人可用的索引：

```bash
pnpm class:index     # 读取 data/class.json，输出 data/class-index.json
```

- 默认只保留**年级 2022-2026**（可用 `CLASS_INDEX_YEARS=22-26` 调整，支持两位数年份）；
- 输出 `classes`（班级名）、`majors`（专业）、`classInfo`（班级 → 专业/学院/年级）；
- `data/` 已在 `.gitignore` 中，**真实班级数据不会提交到 Git**；
- 索引文件路径可用 `CLASS_INDEX_FILE` 覆盖；索引缺失时班级类规则会**自动退化为人工审核**，不会误放行。

`joinRequireClass` 匹配的是索引里的 **`classes` 班级名**：

- 忽略空白、按**子串包含**判断、长班级名优先（`材化2211 张三`、`我是材化2211的小明` 都能命中）；
- 所以答案里的班级名必须**真的存在于索引**中。例如索引里 22 级环工只有 `环工2211/2212/2213`，大类是 `环境类2214`；申请人写 `环工2214` 不会命中，写 `环境类2214` 才会；
- `majors` / `college`（专业、学院）只用于审核意见展示，以及姓名提取时排除误判，**不参与「必须匹配」判断**；
- 索引只在**启动时加载一次**：重新运行 `pnpm class:index` 之后必须**重启机器人**；改规则本身立即生效、不用重启。

排查「明明写了班级却不匹配」：打开 `data/class-index.json` 搜一下 `classes` 里有没有那个名字（注意大类/专业命名差异），也可以用 `node -e "..."` 或编辑器搜索；`/pending` 的审核意见会显示 `缺少：班级`。

### 入群审核规则（`班级+姓名` 示例）

以「入群问题必须回答 班级+姓名，答对自动通过」为例：

```text
/rules set joinRequireClass on        # 答案必须包含班级库里的班级
/rules set joinRequireName on         # 答案必须包含姓名
/rules set joinDecision approve_on_match
/rules set joinReviewOpinion on       # 未命中时在 /pending 给出审核意见
```

`joinDecision` 五个取值：

| 取值 | 行为 |
|---|---|
| `manual` | 全部人工审核（默认） |
| `auto_approve` | 全部自动通过（忽略规则） |
| `approve_on_match` | 命中规则 → 通过；未命中 → 人工 |
| `reject_on_match` | 命中规则 → 拒绝；未命中 → 人工 |
| `reject_on_mismatch` | 未命中规则 → 拒绝；命中 → 人工（“必须回答正确”） |

自动处理是否通知审核员由 `notifyAutoApproved` 控制：

```text
/rules set notifyAutoApproved on     # 机器人自动通过/拒绝也推送通知（只是告知结果，无审批按钮）
/rules set notifyAutoApproved off    # 默认：只推需要人工处理的申请
```

还可以追加自定义正则：

```text
/rules set joinAnswerPattern ^材化\d{4}\s+\S{2,4}$
/rules set joinAnswerPattern clear
```

`/pending` 会给出审核意见（可用 `joinReviewOpinion off` 关闭）：

```text
1. r1 用户：XXXX 理由：材化2211 张三
   审核意见（按当前入群规则自动生成）：
     识别到：班级 材化2211（材料化学 / 化学与生命科学学院 / 2022 级）、姓名 张三
     规则要求已全部满足
     建议：通过
     原始回答：材化2211 张三
```

自动决策同样遵循「先官方、后本地」：官方接口失败时申请保持待审批。规则缺失或正则写错时**一律转人工**，不会猜。

### 入群后自动改群昵称：官方不支持

官方开放平台「群聊管理」接口里**没有修改群成员昵称/群名片的接口**（已核对接口列表与变更记录），因此机器人无法自动把群昵称改成「班级+姓名」。

可替代的做法：

- 用上面的规则把 **班级 + 姓名** 解析出来，展示在 `/pending` 审核意见与日志里，人工照抄改名；
- 解析结果也可用于审计与统计（`JoinRuleEvaluator` 已把班级/专业/学院/年级结构化）；
- 若以后官方开放昵称接口，只需在 `JoinRuleEvaluator` 的输出之上接一个调用，规则层不用改。

## 短码与系统 id 暴露策略

官方内部 id（`join_request_id`、`user_openid`、`group_openid`）又长又难读，也怕被枚举后越权审核。机器人给每个内部 id 生成一个**随机 6 位 Base62 短码**（形如 `#M7K2Q9`），用它替代所有展示场景：

- 生成方式：`crypto.randomInt` 逐位随机，**不用自增 ID**，猜不到下一个；
- 唯一性：`short_codes` 表以 `code` 为主键、`(kind, target_id)` 唯一；生成时先查重，碰撞就重新生成；
- 大小写不敏感：`#m7k2q9` 也能解析，展示时保留原始大小写；
- 持久化：重启后同一个内部 id 复用同一短码；
- 三种用途：`join_request`（申请短码）、`user`（未绑定用户）、`group`（未绑定群）。

| 场景 | 展示 | 命令参数 |
|---|---|---|
| 已绑定 QQ号 | QQ号 | QQ号 或 `#用户短码` |
| 未绑定用户 | `#用户短码` | `#用户短码` |
| 已绑定群号 | 群号 | 群号 或 `#群短码` |
| 未绑定群 | `#群短码` | `#群短码` |
| 入群申请 | `#申请短码` | `#申请短码`（兼容完整 `join_request_id`） |

**永远不暴露内部系统 id**，唯一例外是 `/whois`（超管）：

```text
/pending
1. #M7K2Q9 用户：#U3F7K2 理由：材化2211 张三

/approve #M7K2Q9
已通过入群申请 #M7K2Q9。

/whois #M7K2Q9
类型：入群申请
短码：#M7K2Q9
真实申请 ID：ARvtM_tE85a2U1EG8z_B3YPEx6EcEIIJ...
```

`/pending`、`/sync`、推送卡片、`/audit`、`/status`、`/perm list`、`/rules`、`/notify`、`/test` 都只出现 QQ号 / 群号 / 短码；只有 `/whois` 会显示真实系统 id。

`/whois` 不带参数时直接查当前上下文：**群聊查当前群、私聊查你自己**（同样显示绑定的群号/QQ号与短码）：

```text
/whois
类型：群（当前群）
群 ID：0123456789ABCDEF0123456789ABCDEF
群号：654321
短码：#A7K2Q9
```

## 个人资料（`/profile`）

活动报名、身份核对都基于个人资料。用户自己填写、随时查看：

```text
/profile                             # 查看资料
/profile set name 张三                # 姓名
/profile set id 22123456789           # 学号（11 位，前两位 22-26 决定年级）
/profile set class 材化2211            # 班级（必须在 class-index.json 里）
/profile set college 材料科学与工程学院  # 学院（可手动覆盖）
/profile set year 22                  # 年级（可手动覆盖，2022 或 22 都行）
/profile set name clear               # 清除单个字段
/profile clear                        # 清空整份资料
```

规则：

- **学号必须 11 位**，前两位是 `22/23/24/25/26`（对应 2022-2026 级），否则拒绝保存；
- **班级必须存在于 `data/class-index.json`**，保存班级时**自动带出学院**（之后可手动覆盖）；
- 报名活动前要求「姓名 + 学号 + 班级」齐全，缺哪项会提示补哪项；
- 资料持久化在 `user_profiles` 表，重启不丢；
- `/profile` 需要先 `/bind qq`，但不要求当前群已绑定群号。

## 活动发布 / 报名 / 管理

群管理员及以上可以发布活动；**报名自助**，卡片一键操作。

```text
/activity                                   # 本群活动列表
/activity list 654321                        # 指定群活动（私信也可用 #群短码）
/activity create 迎新晚会                     # 创建（草稿），得到活动短码 #A7K2Q9
/activity set #A7K2Q9 capacity 50            # 名额
/activity set #A7K2Q9 link 报名入口=https://example.com/signup
/activity set #A7K2Q9 allowYears 22,23       # 年级白名单（学号前两位）
/activity set #A7K2Q9 allowColleges 环境      # 学院白名单
/activity set #A7K2Q9 denyColleges 化学       # 学院黑名单
/activity open #A7K2Q9                       # 开放报名并把卡片发到群里
/activity close #A7K2Q9                      # 关闭报名
/activity cancel #A7K2Q9                     # 取消活动

/activity join #A7K2Q9 [备注]                 # 报名（需要 /profile 完整）
/activity quit #A7K2Q9                       # 取消报名
/activity info #A7K2Q9                       # 详情
/activity signups #A7K2Q9                    # 报名名单（群管理员/发布者）
```

活动卡片（Markdown + 指令按钮，与入群申请共用三级降级）：

```text
## 迎新晚会
材料学院迎新联欢，欢迎参加。

- 活动群：654321
- 报名人数：12 / 50
- 报名限制：学院 环境 · 年级 22、23
- 不接受：学院 化学与生命科学学院
- 相关链接：[报名入口](https://example.com/signup)

[ 报名 ] [ 取消报名 ]
[ 活动详情 ] [ 报名名单 ]
```

要点：

- 活动归属**一个群**（默认当前群，私信里要写群号）；卡片发到该群，按钮点击即执行对应指令；
- 报名限制同时支持**白名单**（`allowColleges` / `allowYears`）与**黑名单**（`denyColleges` / `denyYears`），**黑名单优先**，留空表示不限；
- 年级用**学号前两位**判断（`22`-`26`），学院用 `/profile` 的学院（可由班级库自动带出，匹配时允许「环境」匹配「环境科学与工程学院」）；
- 报名要求 `/profile` 完整；名额满、重复报名、不符合限制都会给出明确原因；
- 活动（含短码/链接/限制）与报名记录都持久化，重启不丢；
- 权限：创建/修改/开停/看名单需要**群管理员及以上**，活动**发布者本人**也能管理自己发布的活动；普通成员只能报名/取消/看详情。

## 入群申请推送（卡片 + 快捷同意/拒绝）

审核员可以订阅推送：有新的**待人工处理**的入群申请时，机器人会用主动私聊把申请推送给所有订阅了该群的人，卡片底部带「同意 / 拒绝」快捷按钮。

```text
/notify                               # 查看当前订阅
/notify on                            # 群内=本群；私信=你担任群管理员的全部群
/notify off                           # 关闭对应范围
/notify all on                        # 全部群（群内/私信均可）
/notify all off
/notify <group_openid|群号> on|off     # 指定群（私信）
/notify test                          # 给自己发一张推送测试卡片
```

订阅规则：

- **只有能审批该群入群申请的人**（群管理员 / 本群超管 / 全局超管）可以订阅与接收；审核员（moderator）目前没有入群审批权限，订阅时会提示权限不足（如需放开，见「权限模型」一节的说明）；
- 推送时会再按「当前群是否有审批权限」过滤一次，越权订阅不会泄漏申请内容；
- 订阅持久化在 `notification_subscriptions` 表，重启不丢；
- 自动通过 / 自动拒绝的申请**不推送**，只有转人工的才找人；
- 同一 (群, 申请, 人) 只推一次，重启后也不会重复（投递记录写在 `notification_deliveries`）；
- 接收者需要先 `/bind qq <QQ号>` 绑定自己，否则按钮点下去会先提示绑定（订阅本身已经要求绑定）。

卡片内容（Markdown + 底部按钮）：

```text
## 新的入群申请
**群**：654321（0123456789ABCDEF0123456789ABCDEF）
**申请人**：A1B2C3D4...（小明）
**入群问题**：请回答班级+姓名
**回答**：材化2211 张三
**申请ID**：#M7K2Q9

> 审核意见（按当前入群规则自动生成）：
>   识别到：班级 材化2211（材料化学 / 化学与生命科学学院 / 2022 级）、姓名 张三
>   规则要求已全部满足
>   建议：通过

请审核：点击下方按钮。
[ 同意 ] [ 拒绝 ]
[ 拒绝：回答错误 ] [ 拒绝：班级姓名 ]
```

> 「回答」来自官方的入群验证信息：`verify_info.method = verify_message` 时取 `verify_message`；`admin_review_qa`（管理员设置问题）时取 `review_qa_list[].answer`（多个答案用空格拼接），同时展示问题文本与申请人昵称。被邀请入群（`apply_source = invited`）没有验证信息，此时「回答」为空，班级类规则会自动转人工。

「同意 / 拒绝」是**指令按钮**：点击后自动发送 `/approve <#申请短码>` / `/reject <#申请短码> <原因>`，并带二次确认弹窗。短码唯一，处理时会自动定位申请所属群（也可以显式写群号：`/approve 654321 #M7K2Q9`）。按钮走的是与手动输入**完全相同**的指令与权限校验，不存在绕过。

第二行是**预设拒绝原因**，拒绝按钮统一用红色（官方样式 `3`＝白底红字，是官方唯一提供的红色按钮样式），一键把回复作为官方 `reject_reason` 提交给申请人：

| 按钮 | 发起的指令 |
|---|---|
| 拒绝 | `/reject <#申请短码> 审核未通过` |
| 拒绝：回答错误 | `/reject <#申请短码> 请正确回答问题。` |
| 拒绝：班级姓名 | `/reject <#申请短码> 请回答正确的班级姓名（如：环工2214小明）。` |

按钮不可用（未开通白名单）时，卡片正文会列出这些指令，纯文本也能一键复制审批；正常情况下正文只展示申请信息与 `申请ID`，不再堆完整指令。

### 机器人自动处理的通知（`notifyAutoApproved`）

默认只推送**需要人工处理**的申请。开启后，机器人自动通过/拒绝的申请也会推一张**只读卡片**（显示「已自动通过（按入群规则）」/「已自动拒绝（按入群规则）」，没有按钮），让审核员知晓结果：

```text
/rules set notifyAutoApproved on      # 自动处理也通知
/rules set 通知自动通过 off            # 关闭（默认）
/rules set all notifyAutoApproved on  # 全局默认（超管）
```

### 官方能力与限制（先看这里）

| 项 | 官方现状 | 本项目的处理 |
|---|---|---|
| 结构化卡片（Ark） | 机器人只能**收**，不能发 | 改用 **Markdown 消息 + 内嵌按钮** 当「卡片」 |
| 自定义 Markdown | 单聊/群聊**已对所有机器人开放**，无需申请 | 卡片正文使用 `markdown.content` |
| 自定义按钮 | **内邀开通（白名单）** | 首次被拒后自动降级为纯 Markdown；Markdown 也失败则降级为纯文本（仍带完整指令） |
| 主动消息 | 用户可在 QQ 客户端关闭「允许主动发送」，关闭后主动消息一律失败 | 失败只记日志与投递状态，申请仍在 `/pending`；可用 `/notify test` 自检 |
| 主动消息频控 | 未认证 5 qps 且 30 qpm；单关系维度 20 qpm；每个用户每天最多 1000 条 | 出站消息统一节流；同一申请只推一次 |

> 结论：**推送通道一定能用**（Markdown 无需申请）；**快捷按钮取决于白名单**，没开通也能用降级卡片 + 手输指令完成审批。

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
- 命中任一关键词即触发一次审核动作：默认发送下面的「警告文案」，若配置了 `keywordRecall` / `keywordPunish` 还会撤回、禁言、移出或拉黑（见「关键词处罚与入群审核规则」），并写一条审计记录（`/audit` 可查）；
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
| `wordFilter` | 关键词过滤总开关；关闭后命中也不再警告/撤回/处罚，但关键词配置保留 |
| `enabled` | 本群总开关；关闭后停止关键词审核与入群自动决策（管理指令仍可用） |
| `joinAudit` | 入群审核总开关；关闭后不做自动决策，但不会禁用 `/pending`、`/sync`、`/approve` |
| `autoApprove` | 便捷开关：开启后等价 `joinDecision auto_approve`（需要 `enabled` 与 `joinAudit` 同时开启） |
| `joinDecision` | 更细的入群决策模式，见「关键词处罚与入群审核规则」 |
| `export` | 目前仅存储与展示，导出能力的鉴权以权限模型为准 |

### 5. 禁言时长

```text
/rules set muteDuration 600
```

单位是秒，取值必须是非负整数，上限 30 天（`2592000` 秒，超出会被截断）。

> 这个时长只在 `keywordPunish` 为 `mute`（或 `kick` 失败后需要改判禁言）时使用；默认动作是「只警告」，不会用到时长。

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
/rules set all keywordRecall on          # 全局：命中后撤回
/rules set all keywordPunish mute        # 全局：命中后禁言
/rules set all joinDecision approve_on_match
/rules set all joinRequireClass on
/rules set all joinRequireName on
/rules set all keywords clear           # 清空全局关键词
```

说明：

- `all` 也可以写成 `global` / `default` / `全局` / `默认`，例如 `/rules 全局`、`/rules set 全局 keywords 广告`；
- **全局规则仅超级管理员可以查看与修改**（群管理员只能改自己群的规则）；
- 全局规则持久化在数据库里（`group_configs` 中 `group_id = __default__` 的那一行 + `group_keywords`，扩展字段在 `group_settings` 里同用 `__default__`），重启不丢；
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

1. 在群里发一条包含关键词的消息，机器人应回复你配置的警告文案（若开了 `keywordRecall`，消息应先被撤回）；
2. `/audit` 查看最近记录，应出现 `moderation:warn`（或 `moderation:recall` / `moderation:mute` / `moderation:kick`），reason 为 `命中关键词：<关键词>`；具体每个动作成功与否看日志（带 `_failed` 后缀），全部失败时审计状态为 `pending`；
3. `/status` 查看该群运行状态（启用、过滤、全量消息模式等）。

### 9. 字段速查表

| 字段 | 别名 | 取值 | 说明 |
|---|---|---|---|
| `keywords` | `keyword`、`关键词` | 关键词列表；`clear` 清空 | 命中即触发下方的动作 |
| `warning` | `warningMessage`、`警告` | 任意文案；`clear` 恢复默认 | 命中后发送的文案 |
| `keywordRecall` | `recall`、`撤回` | on / off | 命中后是否撤回消息 |
| `keywordPunish` | `punish`、`处罚` | `none` / `mute` / `kick` / `kick_blacklist` | 命中后的处罚动作 |
| `muteDuration` | `mute`、`禁言时长` | 非负整数秒，≤ `2592000` | 禁言动作使用的时长 |
| `wordFilter` | `关键词过滤` | on / off | 关键词过滤总开关 |
| `joinAudit` | `入群审核` | on / off | 入群审核总开关 |
| `autoApprove` | `自动通过` | on / off | 新入群申请全部自动通过（旧开关，等价 `joinDecision auto_approve`） |
| `joinDecision` | `入群决策`、`审核决策` | `manual` / `auto_approve` / `approve_on_match` / `reject_on_match` / `reject_on_mismatch` | 入群自动决策模式 |
| `joinRequireClass` | `要求班级` | on / off | 答案必须包含班级库里的班级 |
| `joinRequireName` | `要求姓名` | on / off | 答案必须包含姓名 |
| `joinAnswerPattern` | `答案正则` | 正则；`clear` 清空 | 答案必须匹配的额外正则 |
| `joinReviewOpinion` | `审核意见` | on / off | `/pending` 是否展示自动审核意见 |
| `notifyAutoApproved` | `通知自动通过`、`autoNotify` | on / off | 机器人自动通过/拒绝的申请是否也推送给审核员（默认 off，只推需要人工处理的） |
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
| `设置失败：keywordPunish 只能是 none/mute/kick/kick_blacklist` | 处罚动作取值写错 |
| `设置失败：joinDecision 只能是 manual/auto_approve/approve_on_match/reject_on_match/reject_on_mismatch` | 入群决策取值写错 |
| `设置失败：joinAnswerPattern 不是合法的正则（…）` | 正则写错了，会拒绝保存（写错的正则不会生效） |
| 配了关键词但没反应 | 检查 `/rules`（或 `/rules all`）里 `启用` 与 `关键词过滤` 是否为 `true`；非 @ 的普通消息还需要群管理员在机器人资料页开启「接收所有消息」 |
| 关键词命中了但没被移出/拉黑 | `batch_remove_members` 与黑名单接口仅白名单机器人可用（11253）；机器人需为群管理员。看日志里的 `_failed` 详情，`/audit` 里全部失败会显示 `pending` |
| 入群申请没有自动通过/拒绝 | 检查 `joinDecision`、`joinRequireClass`/`joinRequireName`/`joinAnswerPattern`，以及 `data/class-index.json` 是否存在；索引缺失或正则无效会强制转人工 |
| 卡片「回答」显示（未填写） | 该群没有设置入群验证问题，或被邀请入群（`apply_source=invited`）。看日志 `join request has no answer` 里的 `verifyKeys` / `method` / `applySource` 确认官方字段 |
| 审核意见说「缺少：班级」但答案明明写了班级 | 班级名必须与 `data/class-index.json` 的 `classes` 完全一致（如索引里是「环境类2214」而不是「环工2214」）。核对后让申请人按索引里的班级名回答，或用 `CLASS_INDEX_YEARS` 重新生成索引并重启 |

### 11. 规则持久化（强制不变量）

**规则配置一律入库，不存在只留内存的字段。**

- 旧字段（关键词、警告文案、开关、禁言时长）写 `group_configs` + `group_keywords`；
- 扩展字段（命中动作、入群审核规则等）写 `group_settings` 键值表，因此新增字段**不需要改表结构**；
- 全局默认用 `group_id = __default__`，与单群覆盖走同一套读写路径；
- `GroupConfigStore.load()` 会同时读两张表并合并（按字段继承：群覆盖 > 全局默认 > 内置默认）；
- **新增字段的硬约束**：`EffectiveGroupConfig` 的每个字段都必须出现在 `SQL_FIELDS` 或 `SETTING_FIELDS` 中。`src/services/groupConfig.ts` 导出的 `PERSISTED_CONFIG_FIELDS` 与 `test/groupConfig.test.ts` 会双向校验「生效字段 = 可持久化字段」，漏加字段会直接测试失败；
- 每条 `/rules set <字段>` 的端到端持久化（写入 → 重新装配 store → 恢复）由 `test/rulesPersistence.test.ts` 覆盖，包括「只有扩展字段的群」和「全局规则继承」。

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
├── scripts/
│   └── build-class-index.mjs # pnpm class:index：data/class.json → data/class-index.json
├── data/                    # 本地数据（gitignored）：class.json、class-index.json、SQLite 文件
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
  ├── 入群审核 / 同步 / 规则引擎（班级库）
  ├── 入群申请推送（Markdown 卡片 + 快捷按钮）
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
- [**卡片标准**（所有指令输出规范）](docs/CARD-STANDARD.md)
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
