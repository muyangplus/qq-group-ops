# Configuration

本文说明 QQ Group Ops 当前支持的环境变量。项目使用 `.env` 加载配置；仓库只提交 `.env.example`。

## 快速开始

```bash
cp .env.example .env
# 然后编辑 .env
```

`pnpm dev`、`pnpm start` 会自动读取项目根目录的 `.env`。如果系统环境变量已经存在，则优先使用系统环境变量。

## 官方机器人

| 变量 | 必填 | 说明 |
|---|---|---|
| `QQ_BOT_APP_ID` | 是 | QQ 开放平台机器人 AppID |
| `QQ_BOT_CLIENT_SECRET` | 是 | 机器人 Client Secret |
| `QQ_BOT_TOKEN` | 否 | 已有人工 token；填写后不再自动获取与刷新 |
| `QQ_BOT_SANDBOX` | 否 | 是否使用沙箱环境，默认 `false` |
| `QQ_BOT_CACHE_FILE` | 否 | access token 与网关地址缓存文件，默认 `data/qq-bot-cache.json`；留空则只用内存缓存 |

## 限流与重连

官方 `/gateway` 接口限频非常严格（实测约每个时间窗口 2 次），access token 与消息发送也有频控。项目内置以下保护：

**access token**
- 内存缓存 → 磁盘缓存（`QQ_BOT_CACHE_FILE`）→ 真正请求，默认提前 60 秒视为过期才刷新；
- 并发获取会复用同一个请求；
- 服务端返回 401 时自动作废缓存并刷新重试一次（`QQ_BOT_TOKEN` 显式指定时不自动刷新）。

**网关地址**
- `/gateway` 返回的地址会缓存到内存与磁盘，重连时直接复用，不再请求接口；
- 只有在「从未成功连接且连续失败达到阈值」时才会丢弃缓存重新获取；
- 命中限流后进入 60 秒冷却，冷却期内不再发请求。

**重连**
- 自动重连采用指数退避 + 抖动：1s 起，1.8 倍增长，上限 60s；
- 命中限流时改用 120s 长冷却；
- `onReconnect` 会写日志：`gateway reconnect scheduled { attempt, delayMs, reason, rateLimited }`。

**出站消息**
- 所有出站消息串行发送并强制最小间隔 400ms；
- 命中 22009（消息频率限制）后按 5 秒冷却重试，最多 3 次；
- 被动回复配额在发送前拦截：单聊同一 `msg_id` 最多 5 次，群聊被动回复有效期 5 分钟；
  超限时抛出 `err_code=22009` 的错误并记录 `passive reply quota exhausted` 日志，不会发出无效请求；
- 回复发送失败（限流、配额耗尽、网络错误）只写日志，不会让事件处理链异常，也不影响后续事件；
- 单个事件处理抛错只记录日志并触发 `onError`，WebSocket 连接保持。

排查命令：

```bash
# 看是否在反复请求 /gateway（正常情况下只有首次启动出现）
rg '"url":"https://api.bot.qq.com/gateway"' logs/qq-group-ops.log

# 看限流冷却与重连调度
rg 'cooling down|scheduling reconnect|rate limited' logs/qq-group-ops.log
```

如果确实被限流，先停止进程等待 1-2 分钟；缓存生效后下次启动不会再请求 `/gateway`。

## 机器人自检

配置完成后，在群内发送：

```text
/test
```

机器人会返回测试响应。该指令需要审核员或以上权限。

### 非 @ 指令识别

要让机器人识别群里不带 `@` 的 `/` 指令：

1. 群管理员在机器人资料页开启“接收所有消息”。
2. 官方会推送 `GROUP_MESSAGE_CREATE` 事件。
3. 机器人会像 `GROUP_AT_MESSAGE_CREATE` 一样处理 `/` 开头的指令。

当前 gateway 已订阅 `GROUP_AND_C2C_EVENT`，代码无需额外改动。

排查：

- 运行 `pnpm dev`，查看是否出现 `dispatch {"eventType":"GROUP_MESSAGE_CREATE",...}`。
- 如果没有出现，说明群管理员还没有开启“接收所有消息”。
- 群内发送 `/status`，查看 `全量消息模式`：
  - `all`：已开启
  - `at_only`：已关闭
  - `unknown`：还未收到开启/关闭事件

## 权限

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_USER_IDS` | 否 | 初始超级管理员 userId（官方 OpenID / member_openid），逗号分隔，不是 QQ 号 |
| `ADMIN_QQ_IDS` | 否 | 兼容旧名称，等价于 `ADMIN_USER_IDS`，不推荐新项目使用 |

示例：

```env
ADMIN_USER_IDS=A1B2C3D4E5F6...,F6E5D4C3B2A1...
```

权限相关指令：

```text
/myperm
/perm list [group_openid|群号]
/perm grant super <userId|QQ号>                          # 全局超级管理员
/perm revoke super <userId|QQ号>
/perm grant gsuper [group_openid|群号] <userId|QQ号>      # 本群超级管理员
/perm revoke gsuper [group_openid|群号] <userId|QQ号>
/perm grant admin [group_openid|群号] <userId|QQ号>
/perm revoke admin [group_openid|群号] <userId|QQ号>
/perm grant mod [group_openid|群号] <userId|QQ号>
/perm revoke mod [group_openid|群号] <userId|QQ号>
```

说明：

- `/myperm`：所有用户可查询自己的权限（会分别显示全局/本群超级管理员）。
- `/help`：只显示当前用户有权限执行的指令；`/help <指令>` 查看某个指令的详细用法（如 `/help rules`、`/help bind`、`/help perm`），主题详情同样做权限过滤。
- `/perm`：仅**全局**超级管理员可用。
- `super`：全局超级管理员，拥有平台级能力（`/perm`、`/rules all`、`/bind user`、`/bind groupid`、`/whois`）。
- `gsuper`（别名 `groupsuper` / `群超管` / `本群超管` / `群超级管理员`）：**本群超级管理员**，只在该群内等价于 `super_admin`，可以审批、改规则、查审计、导出；**拿不到任何跨群或平台级能力**。
- `admin`：当前群的群管理员。
- `mod`：当前群的审核员。
- 所有角色都是**手工配置**的：不依赖 QQ 群主/管理员身份自动授予（官方成员接口目前是内邀白名单能力）。
- 权限配置会持久化到数据库（SQLite / PostgreSQL）。
- `ADMIN_USER_IDS` 只在数据库里不存在任何**全局**超级管理员时作为初始种子写入；之后以数据库为准。
  这意味着把某人从 `ADMIN_USER_IDS` 删除并不会撤销其权限，需要用 `/perm revoke super` 显式撤销。
  注意：数据库里只有「本群超级管理员」时**仍会**重新种子 `ADMIN_USER_IDS`，避免全局超管被锁死。

角色能力对照：

| 能力 | 全局超管 | 本群超管 | 群管理员 | 审核员 | 成员 |
|---|---|---|---|---|---|
| `/perm`、`/rules all`、`/bind user\|groupid`、`/whois` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/approve`、`/reject`、`/rules set`、`/bind group`、`/notify` | ✅ | ✅（本群） | ✅（本群） | ❌ | ❌ |
| `/pending`、`/sync`、`/audit`、`/test`、`/rules`、`/status` | ✅ | ✅（本群） | ✅（本群） | ✅（本群） | ❌ |
| `/myperm`、`/help` | ✅ | ✅ | ✅ | ✅ | ✅ |

存储方式：本群超级管理员复用 `permission_grants` 的 `scope = 'super_admin'` + 非空 `group_id`（全局超管为 `group_id = ''`），因此**不需要改表结构**。

## 群规则与内容审核

> 逐步示例、私信写法、字段速查与常见报错见 README 的 [「配置群规则（完整示例）」](../README.md#配置群规则完整示例)。

群管理员在群内（或私信中带群号）配置规则：

```text
/rules                                             # 查看当前群规则
/rules set keywords 广告,刷屏,加群                  # 设置关键词（逗号、顿号或空格分隔）
/rules set keywords clear                          # 清空关键词
/rules set warning 本群禁止广告，请撤回。           # 自定义警告文案
/rules set warning clear                           # 恢复默认警告文案
/rules set keywordRecall on|off                    # 命中后是否撤回消息
/rules set keywordPunish none|mute|kick|kick_blacklist  # 命中后的处罚动作
/rules set muteDuration 600                        # 禁言时长（秒），供 mute 动作使用
/rules set wordFilter on|off                       # 关键词过滤总开关
/rules set joinAudit on|off                        # 入群审核开关
/rules set autoApprove on|off                      # 全部自动通过（等价 joinDecision auto_approve）
/rules set joinDecision manual|auto_approve|approve_on_match|reject_on_match|reject_on_mismatch
/rules set joinRequireClass on|off                 # 答案必须包含班级库中的班级
/rules set joinRequireName on|off                  # 答案必须包含姓名
/rules set joinAnswerPattern <正则>|clear          # 追加自定义正则
/rules set joinReviewOpinion on|off                # /pending 是否展示审核意见
/rules set notifyAutoApproved on|off               # 机器人自动通过/拒绝的申请是否也推送通知
/rules set export on|off                           # 导出功能开关
/rules set enabled on|off                          # 机器人本群总开关
```

私信中使用时需要在 `set` 后加群号：

```text
/rules set <group_openid|群号> keywords 广告,刷屏
```

审核行为：

- 群配置里的关键词会真正参与消息审核；命中后默认动作是**警告**（发送该群的警告文案并写入审计）。
- `keywordRecall on` 会追加撤回；`keywordPunish` 可设为 `mute` / `kick` / `kick_blacklist`；动作**尽力而为**，单个失败不影响其他动作，失败会记在日志中（带 `_failed` 后缀）；全部失败时 `/audit` 里的审计状态为 `pending`。
- 关键词按群隔离，修改后立即生效（规则引擎按群缓存，关键词变化时自动失效）。
- 关键词会去重、去空白并按字典序保存，保证重启前后顺序一致。
- 禁言动作使用官方 `restrict_chat_setting`（最长 30 天，机器人需为群管理员）。
- 踢人动作使用官方 `batch_remove_members`，`kick_blacklist` 会在同一次调用里带 `add_to_member_blacklist: true`；**该接口仅白名单机器人可用**，未开通时会返回错误码 11253。
- 单独拉黑（目标当前不在群中）使用 `POST /v2/groups/{g}/member_blacklist`。

### 规则持久化（强制不变量）

规则配置**全部入库**，不存在只留内存的字段：

| 字段类别 | 存储位置 | 说明 |
|---|---|---|
| 旧字段（关键词、警告文案、开关、禁言时长） | `group_configs` + `group_keywords` | 每群一行快照 + 关键词行 |
| 扩展字段（命中动作、入群审核规则等） | `group_settings`（键值表） | 新增字段无需 ALTER TABLE |
| 全局默认 | 上述两张表的 `group_id = __default__` | 与单群覆盖同一套路径 |

- `GroupConfigStore.load()` 启动时读两张表并按字段合并：群覆盖 > 全局默认 > 内置默认；
- 单群「只有扩展字段」时不会写 `group_configs` 行，但重启后依然能从 `group_settings` 恢复出该群覆盖；
- `removeOverride` 会同时清理两张表；
- **新增规则字段的硬约束**：`EffectiveGroupConfig` 的每个字段都必须在 `SQL_FIELDS` 或 `SETTING_FIELDS` 中（`PERSISTED_CONFIG_FIELDS` 导出供测试双向校验），遗漏会导致 `pnpm test` 失败；
- `/rules set` 的逐字段持久化回归见 `test/rulesPersistence.test.ts`。

### 入群审核与班级库

`joinDecision` 控制新申请怎么处理：

| 取值 | 行为 |
|---|---|
| `manual`（默认） | 全部人工，只进 `/pending` |
| `auto_approve` | 全部自动通过（忽略规则；`autoApprove on` 是其便捷别名） |
| `approve_on_match` | 命中规则 → 通过，未命中 → 人工 |
| `reject_on_match` | 命中规则 → 拒绝，未命中 → 人工 |
| `reject_on_mismatch` | 未命中 → 拒绝，命中 → 人工 |

规则由三项组成（可组合）：`joinRequireClass`（答案必须包含班级库里的班级）、`joinRequireName`（必须包含姓名）、`joinAnswerPattern`（附加正则）。`joinReviewOpinion on` 时 `/pending` 会展示识别出的班级/专业/学院/年级、缺失项与建议。

`joinRequireClass` 匹配 `class-index.json` 的 `classes`：忽略空白、按子串包含、长班级名优先；`majors`/`college` 只用于展示与姓名排除，不参与匹配。因此班级名必须与索引一致（例如索引里是 `环境类2214`，写 `环工2214` 不会命中）。索引只在启动时加载一次，重新生成后需重启进程。

班级库来自 `CLASS_INDEX_FILE`（默认 `data/class-index.json`），由 `pnpm class:index` 从 `data/class.json` 生成（默认保留 2022-2026 级，可用 `CLASS_INDEX_YEARS` 调整）。索引缺失、正则无效或规则无法判定时**一律回退人工审核**，不会误放行。原始 `data/class.json` 与生成的索引都在 `.gitignore` 中，不要提交。

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLASS_INDEX_FILE` | 否 | 班级索引文件路径，默认 `data/class-index.json` |
| `CLASS_RAW_FILE` | 否 | 仅 `pnpm class:index` 使用：原始教务导出 JSON，默认 `data/class.json` |
| `CLASS_INDEX_YEARS` | 否 | 仅 `pnpm class:index` 使用：保留的年级范围，默认 `2022-2026`（也接受 `22-26`） |

```bash
pnpm class:index
# 等价于：
CLASS_RAW_FILE=data/class.json CLASS_INDEX_FILE=data/class-index.json CLASS_INDEX_YEARS=22-26 \
  node scripts/build-class-index.mjs
```

自动决策遵循「先官方、后本地」：官方审批接口调用失败时申请保持待审批状态。

### 入群申请推送（`/notify`）

能审批入群申请的人（群管理员 / 本群超管 / 全局超管）可以订阅私聊推送：

```text
/notify                               # 查看当前订阅
/notify on|off                        # 群内=本群；私信=你担任群管理员的全部群
/notify all on|off                    # 全部群
/notify <group_openid|群号> on|off     # 指定群
/notify test                          # 给自己发一张测试卡片
```

- 推送时机：默认只推送**仍需人工处理**的申请（`manual` / 规则无法判定）；群配置 `notifyAutoApproved on` 后，机器人自动通过/拒绝的申请也会推一张只读卡片（显示处理结果、无按钮）；
- 接收者：订阅了该群（或全部群）**且**在当前群有审批权限的人；订阅持久化在 `notification_subscriptions`；
- 卡片：Markdown 正文（群号、申请人+昵称、入群问题、回答、申请 ID、审核意见）+ 「同意 / 拒绝」指令按钮，第二行是两个红色预设拒因（回答错误 / 班级姓名），点击即把固定文案作为拒绝理由提交；按钮未开通（官方内邀）会自动降级为纯 Markdown → 纯文本（正文里会列出全部指令与预设拒因）；
- 回答来源：`verify_info.method = verify_message` 取 `verify_message`，`admin_review_qa` 取 `review_qa_list[].answer`（多个用空格拼接）；被邀请入群（`invited`）没有答案，班级类规则自动转人工；
- 去重：同一 (群, 申请, 人) 只推一次，投递记录在 `notification_deliveries`，重启后不重复；
- 推送是**主动消息**：用户可在 QQ 客户端关闭「允许主动发送」，失败只记日志，不影响 `/pending`。

### 全局规则（`all`）

超管可以把任一字段配置成全局默认，语法是 `/rules set all <字段> <值>`；未单独覆盖该字段的群会继承，已覆盖的群以自己的配置为准（**按字段继承**）。

```text
/rules all                          # 查看全局默认规则（仅超管）
/rules set all keywords 广告,刷屏    # 全局关键词
/rules set all warning 本群禁止广告。 # 全局警告文案
/rules set all autoApprove off
/rules set all keywords clear       # 清空全局关键词
```

- `all` 的别名：`global`、`default`、`全局`、`默认`；
- 全局规则只存一行：`group_configs` 中 `group_id = __default__` 的完整快照 + `group_keywords` 中 `group_id = __default__` 的关键词；
- 每次全局修改都会写入**完整快照**，因此多次局部修改不会互相覆盖；重启后由 `GroupConfigStore.load()` 合并回全局默认。
- 入群申请审批：

```text
/pending [#群短码|群号]                    # 查看本地待审批队列
/sync [#群短码|群号]                       # 从官方接口补齐待审批申请（按群 30 秒节流）
/approve <#申请短码>                       # 通过（自动定位所属群）
/approve <#群短码|群号> <#申请短码>          # 私信中显式指定群
/reject <#申请短码> [原因]
/reject <#群短码|群号> <#申请短码> [原因]
```

申请短码由 `/pending`、`/sync` 或推送卡片给出；完整 `join_request_id` 仍然兼容。审批顺序是「先调用官方接口，成功后再更新本地状态」；官方调用失败时申请保持待审批并返回错误。

审计查询（审核员及以上）：

```text
/audit [group_openid|群号] [数量]   # 默认 10 条，最多 50 条
```

### 私信指令

私信支持以下指令：

- `/myperm`
- `/help`
- `/test`（超级管理员）
- `/perm`（超级管理员）

群管理指令在私信中需要额外提供群号或 `#群短码`（`/approve`、`/reject` 带申请短码时也可以省略）：

```text
/pending <#群短码|群号>
/sync <#群短码|群号>
/approve <#申请短码>
/reject <#申请短码> [原因]
/rules <#群短码|群号>
/rules                                 # 私信 + 全局超管：等价 /rules all（查看全局默认规则）
/rules set <#群短码|群号> <字段> <值>
/notify [#群短码|群号|all] on|off
/notify test
/audit <#群短码|群号> [数量]
/status <#群短码|群号>
/perm grant gsuper <#群短码|群号> <userId|QQ号|#用户短码>
/perm grant admin <#群短码|群号> <userId|QQ号|#用户短码>
/perm grant mod <#群短码|群号> <userId|QQ号|#用户短码>
```

### 绑定 QQ号 / 群号

官方只提供 OpenID，因此需要自己维护映射：

```text
/bind qq <QQ号>                         # 绑定自己的 userId ↔ QQ号
/bind group <群号>                      # 群管理员绑定当前群
/bind user <userId> <QQ号>              # 超管绑定任意用户
/bind groupid <group_openid> <群号>     # 超管绑定任意群
/whois <QQ号|userId|群号|group_openid>  # 超管查询映射
```

绑定后可以直接用 QQ号/群号执行命令：

```text
/perm grant mod 123456
/status 654321
/pending 654321
```

**展示规则：已绑定显示解析号，未绑定显示随机短码；内部系统 id 永不暴露。**

- 已绑定 QQ号 / 群号 → 只显示 QQ号 / 群号；
- 未绑定用户 / 群 → 显示随机短码 `#M7K2Q9`（6 位 Base62、随机生成、唯一索引、碰撞重生成），不再显示 `userId` / `group_openid`；
- 入群申请 → 一律显示申请短码，替代又长又难读的 `join_request_id`；
- 覆盖范围：`/pending`、`/sync`、推送卡片与纯文本降级、`/audit`、`/status`、`/test`、`/myperm`、`/perm list`、`/notify` 状态、`/rules` 标题、`/bind` 成功回复；
- 命令参数同时接受群号/QQ号与短码：`/status 654321`、`/approve #M7K2Q9`、`/rules set #G7K2Q9 keywords 广告` 都能执行；完整 `join_request_id` 仍然兼容；
- **唯一例外是 `/whois`**（超管）：`/whois #M7K2Q9` 会显示短码对应的类型与真实系统 id，`/whois <QQ号>` 显示对应 `userId` 与短码；
- 短码持久化在 `short_codes` 表（`code` 主键 + `(kind, target_id)` 唯一），重启后同一 id 复用同一短码。

强制绑定规则：

- 除 `/help`、`/bind` 外，用户必须绑定 QQ 号。
- 群聊内除 `/help`、`/bind` 外，群必须绑定群号。
- 私信中按群号执行群管理命令时，该群号必须已绑定。
- 未绑定用户会返回：`请先绑定 QQ 号：/bind qq <QQ号>`。
- 未绑定群会返回：`请先绑定本群：/bind group <群号>`。

绑定关系持久化到数据库：

- 默认：SQLite 文件（`data/qq-group-ops.db`），启动时自动建表并载入全部绑定，`/bind` 写入数据库，重启后仍然有效。
- 数据库打开或迁移失败：启动直接报错退出，不会静默退化为内存模式。
- `DATABASE_URL=memory`：显式使用纯内存模式，重启后状态会丢失（仅调试用）。

## 数据库

默认 **SQLite**，不需要任何额外配置：

```bash
pnpm dev        # 直接可用，数据写入 data/qq-group-ops.db
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 否 | 留空 = SQLite；`postgres://…` = PostgreSQL；`sqlite:…` = 指定 SQLite 文件；`memory` / `sqlite::memory:` = 纯内存 |
| `SQLITE_PATH` | 否 | SQLite 文件路径，默认 `data/qq-group-ops.db` |

示例：

```env
# 默认：SQLite 文件
SQLITE_PATH=data/qq-group-ops.db

# 可选：切换到 PostgreSQL（本地可先执行 pnpm db:up）
# DATABASE_URL=postgres://qqbot:change-me@localhost:5432/qq_group_ops
# POSTGRES_PASSWORD=change-me

# 可选：纯内存模式，重启即丢，仅调试
# DATABASE_URL=memory
```

本地启动 PostgreSQL（可选）：

```bash
pnpm db:up     # docker compose --profile postgres up -d db
```

切换数据库不会自动迁移历史数据；SQLite 与 PostgreSQL 的数据文件/库需要各自备份。

启动时会自动执行 `src/db/schema.ts` 中的迁移。以下状态都会持久化并在启动时载入：

| 表 | 内容 | 服务 |
|---|---|---|
| `identity_bindings` | OpenID ↔ QQ号 / 群号 | `IdentityMapService` |
| `permission_grants` | 超管 / 群管理员 / 审核员授权 | `PermissionService` |
| `audit_records` | 审计记录 | `AuditLogStore` |
| `join_requests` | 入群申请与审批结果 | `JoinAuditService` |
| `group_configs` / `group_keywords` | 群配置与关键词 | `GroupConfigStore` |
| `group_settings` | 群扩展配置（命中动作、入群审核规则等，键值对） | `GroupConfigStore` |
| `notification_subscriptions` | 入群申请推送订阅（`__all__` 或 group_openid） | `NotificationService` |
| `notification_deliveries` | 推送投递记录（去重与排查） | `NotificationService` |
| `short_codes` | 随机短码 → 内部 id 映射（申请/用户/群） | `ShortCodeService` |
| `group_message_modes` | 全量消息模式诊断 | `GroupMessageModeRegistry` |
| `activities` / `activity_registrations` | 活动与报名 | `ActivityService` |

写入策略：

- 读走内存，写操作同步更新内存并进入顺序写穿透队列（`WriteQueue`），由运行时在**回复用户前**和**进程退出前** `flush()` 到数据库；
- 单个写入失败只记录错误日志并计数，不会中断后续写入；
- 启动时会把审计记录、入群申请全量载入内存，请结合 `AUDIT_LOG_RETENTION_DAYS` 等保留策略控制历史数据规模。

### 两种数据库的取舍

| | SQLite（默认） | PostgreSQL（可选） |
|---|---|---|
| 部署 | 零依赖，单文件 | 需要数据库服务 |
| 适用 | 单进程、单群或中小规模 | 多实例、高并发、大数据量 |
| 备份 | 复制 `data/` 目录（建议先停进程） | `pg_dump` |
| 要求 | Node.js 24+（`node:sqlite`） | 任意受支持 Node.js + `pg` |

## 日志

| 变量 | 必填 | 说明 |
|---|---|---|
| `LOG_LEVEL` | 否 | `debug` / `info` / `warn` / `error`，默认 `info` |
| `LOG_FILE` | 否 | 日志文件路径，默认 `logs/qq-group-ops.log`；设为空字符串可关闭文件日志 |
| `LOG_CONSOLE` | 否 | 是否输出到控制台，默认 `true` |
| `LOG_COLOR` | 否 | `auto` / `always` / `never`，默认 `auto` |

`pnpm dev` 会默认使用 `debug` 级别，便于开发调试。生产环境建议使用 `info` 或 `warn`。

彩色显示规则：

- `auto`：仅当标准输出是 TTY 且终端支持 ANSI 时着色；尊重 `NO_COLOR` 和 `FORCE_COLOR`
- `always`：始终输出 ANSI 颜色
- `never`：始终纯文本
- 文件日志始终为 JSON Lines，不包含 ANSI 颜色

## 数据保留

| 变量 | 必填 | 说明 |
|---|---|---|
| `RAW_MESSAGE_RETENTION_DAYS` | 否 | 消息原文保留天数；`0` 表示不保存（见下方说明） |
| `AUDIT_LOG_RETENTION_DAYS` | 否 | 审计记录保留天数，默认 `180`；`0` 表示不清理 |

清理行为（`RetentionService`）：

- 启动时执行一次，之后每 24 小时执行一次；
- 删除早于 `AUDIT_LOG_RETENTION_DAYS` 的审计记录；
- 删除早于同一保留期、且**已审批**的入群申请；待审批申请永不清理；
- 清理同时作用于内存缓存与数据库，避免启动全量载入导致内存无限增长。

`RAW_MESSAGE_RETENTION_DAYS` 目前是「无数据可清理」的状态：项目默认不保存消息原文，只保存审核结果与规则命中信息。保留该变量是为了后续需要短期留存原文时使用。

合规建议见 [DATA-COMPLIANCE.md](DATA-COMPLIANCE.md)。

## 预留配置

以下变量尚未被当前代码读取，仅作为后续阶段参考：

- Web 管理后台：`WEB_ADMIN_HOST`、`WEB_ADMIN_PORT`、`WEB_ADMIN_JWT_SECRET`
- 内容安全 API：`CONTENT_MODERATION_PROVIDER`、`CONTENT_MODERATION_API_KEY`
- AI 辅助：`LLM_PROVIDER`、`LLM_API_KEY`、`LLM_MODEL`

## 安全提醒

- 不要提交 `.env`。
- 不要把 AppID、Client Secret、Token、数据库密码发到 Issue 或日志中。
- 生产环境建议使用 Docker secrets 或部署平台的密钥管理。
