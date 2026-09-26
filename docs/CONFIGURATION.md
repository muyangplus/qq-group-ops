# 配置说明（Configuration）

本文说明 QQ Group Ops 当前支持的环境变量。项目使用 `.env` 加载配置；仓库只提交 `.env.example`。

> 部署/启动/排障见 [OPERATIONS.md](./OPERATIONS.md)，指令用法见 [COMMANDS.md](./COMMANDS.md)。

## 目录

- 快速开始
- 官方机器人
- 限流与重连
- 机器人自检
- 权限
- 群规则与内容审核
- 个人资料与活动
- 数据库
- 日志
- 数据保留
- 预留配置
- 安全提醒

---

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
| `/perm`、`/rules all`、`/rules overrides`、`/bind user\|groupid`、`/whois`、`/alias` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/approve`、`/reject`、`/rules set`、`/rules add\|del keyword`、`/bind group`、`/notify` | ✅ | ✅（本群） | ✅（本群） | ❌ | ❌ |
| `/pending`、`/sync`、`/audit`、`/test`、`/rules`、`/status` | ✅ | ✅（本群） | ✅（本群） | ✅（本群） | ❌ |
| `/myperm`、`/help` | ✅ | ✅ | ✅ | ✅ | ✅ |

存储方式：本群超级管理员复用 `permission_grants` 的 `scope = 'super_admin'` + 非空 `group_id`（全局超管为 `group_id = ''`），因此**不需要改表结构**。

## 群规则与内容审核

> 逐步示例、私信写法、字段速查与常见报错见 README 的 [「配置群规则（完整示例）」](../README.md#配置群规则完整示例)。

群管理员在群内（或私信中带群号）配置规则：

```text
/rules                                             # 查看当前群规则（概览卡 + 5 个子卡）
/rules set keywords 广告,刷屏,加群                  # 设置关键词（逗号、顿号或空格分隔）
/rules set keywords clear                          # 清空关键词
/rules add keyword 广告                              # 逐条追加关键词（trim、去重、单条 ≤50 字）
/rules del keyword 广告                              # 逐条删除关键词（不存在会明确报错）
/rules set warning 本群禁止广告，请撤回。           # 自定义警告文案
/rules set warning clear                           # 恢复默认警告文案
/rules set punish 警告,撤回,禁言                     # 违规处理：多选（警告/撤回/禁言/踢出/拉黑）
/rules set muteDuration 600                        # 禁言时长（秒），供「禁言」动作使用
/rules set wordFilter on|off                       # 关键词过滤总开关
/rules set joinAudit on|off                        # 入群审核开关
/rules set autoApprove on|off                      # 全部自动通过（等价 joinDecision auto_approve）
/rules set joinDecision manual|auto_approve|approve_on_match|reject_on_match|reject_on_mismatch
/rules set joinRequireClass on|off                 # 答案必须包含班级库中的班级
/rules set joinRequireName on|off                  # 答案必须包含姓名
/rules set joinAnswerPattern <正则>|clear          # 追加自定义正则
/rules set joinReviewOpinion on|off                # /pending 是否展示审核意见
/rules set notifyAutoApproved on|off               # 机器人自动通过/拒绝的申请是否也推送通知
/rules set allowColleges 某学院,某学院              # 学院白名单（空 = 不限）
/rules set denyColleges 某学院                      # 学院黑名单（优先于白名单）
/rules set allowYears 22,23                         # 年级白名单（两位）
/rules set denyYears 26                             # 年级黑名单
/rules set export on|off                           # 导出功能开关
/rules set enabled on|off                          # 机器人本群总开关
/rules overrides [+页码]                            # 覆盖率总览（仅超管）：哪些群覆盖了哪些字段
```

私信中使用时需要在 `set` 后加群号：

```text
/rules set <group_openid|群号> keywords 广告,刷屏
/rules add <group_openid|群号> keyword 刷屏
```

规则卡片（§C）：

- `/rules` 返回**概览卡**：正文标明「本群覆盖」了哪些字段（其余继承全局），入口为
  开关设置 / 入群审核 / 违规处理 / 关键词 / 名单筛选 / 更多设置；末行是 `恢复全部继承` 与（超管）`全局规则`；
- **按钮显示当前状态**（`过滤 开` = 当前开启），点击开关/枚举即生效并回到同一张子卡；
- 每张子卡正文逐条列 `字段：当前值（继承全局 / 本群覆盖）`，底部 `恢复本页继承`（二次确认）
  只清本页字段的覆盖，其余覆盖保持不变；`恢复全部继承` 等价旧的整群 `removeOverride`；
- 关键词子卡每页 3 条，每条一个「删」回调；学院每页 4 个（来自班级库）、年级 22–26 一行点选，白/黑名单切换；
- 全局规则卡（`/rules all`）与群规则同构（目标 `__default__`），底部 `覆盖率总览`
  分页列出 `listOverrideSummaries()` 的结果；
- **降级路径**：`/rules set <字段> <值>`（含 `all`）行为与权限完全保留；卡片按钮不可用时仍可手输。

审核行为：

- 群配置里的关键词会真正参与消息审核；命中后默认动作是**警告**（发送该群的警告文案并写入审计）。
- 「违规处理」是**多选**（0.16.0 起）：`警告` / `撤回` / `禁言` / `踢出` / `拉黑` 互相独立、可任意组合，按「撤回 → 禁言 → 踢出 → 拉黑 → 警告」顺序执行；动作**尽力而为**，单个失败不影响其他动作，失败会记在日志中（带 `_failed` 后缀）；全部失败时 `/audit` 里的审计状态为 `pending`。其中**拉黑不自动踢人**：只落本群黑名单（入群审批最高优先级拒绝）并尝试官方拉黑，官方要求目标不在群中，人在群里时该调用失败只记日志。旧指令 `keywordRecall` / `keywordPunish` 已移除，老库里的这两个字段会自动换算成新多选。
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
- **字段级恢复继承**：`clearFields(groupId, fields)` 只清指定字段——`group_configs` 对应列置 `NULL`
  （仓储层 `clearColumns`，**只清列不动其它列**）、`group_settings` 对应 KV 行删除；全局清字段回落到
  种子默认（内置默认 / 启动配置）。「恢复本页继承」按钮与 `/rules set <字段> clear` 走的就是这条路径；
- **新增规则字段的硬约束**：`EffectiveGroupConfig` 的每个字段都必须在 `SQL_FIELDS` 或 `SETTING_FIELDS` 中（`PERSISTED_CONFIG_FIELDS` 导出供测试双向校验），遗漏会导致 `pnpm test` 失败；
- `/rules set`、`/rules add|del keyword` 与 `clearFields` 的持久化回归见 `test/rulesPersistence.test.ts`。

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

班级库来自 `CLASS_INDEX_FILE`（默认 `data/class-index.json`），由 `pnpm class:index` 从 `data/class.json` 生成（默认保留 2022-2026 级，可用 `CLASS_INDEX_YEARS` 调整）。索引缺失、正则无效或规则无法判定时**一律回退人工审核**，不会误放行。原始 `data/class.json` 与生成的索引（JSON + SQLite）都在 `.gitignore` 中，不要提交。

JSON 产物除 `classes` / `majors` / `classInfo` 外，还带三张对照关系：`colleges`（学院列表）、`collegeMajors`（学院 → 专业）、`majorColleges`（专业 → 学院）；同一份数据会额外落一份 SQLite（`meta` / `colleges(name PK)` / `majors(name PK, college)` / `classes(className PK, major, college, year)`），供离线分析与别名表联查。机器人运行时读的仍然是 JSON。

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLASS_INDEX_FILE` | 否 | 班级索引文件路径，默认 `data/class-index.json` |
| `CLASS_RAW_FILE` | 否 | 仅 `pnpm class:index` 使用：原始教务导出 JSON，默认 `data/class.json` |
| `CLASS_INDEX_YEARS` | 否 | 仅 `pnpm class:index` 使用：保留的年级范围，默认 `2022-2026`（也接受 `22-26`） |
| `CLASS_INDEX_SQLITE_FILE` | 否 | 仅 `pnpm class:index` 使用：SQLite 产物路径，默认 `data/class-index.sqlite`；设 `-` 跳过 |

```bash
pnpm class:index
# 等价于：
CLASS_RAW_FILE=data/class.json CLASS_INDEX_FILE=data/class-index.json \
  CLASS_INDEX_SQLITE_FILE=data/class-index.sqlite CLASS_INDEX_YEARS=22-26 \
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
- 全局卡与群规则卡**同一套子卡结构**（`/rules all`）；在任意子卡点「恢复本页继承」会删掉该页字段的全局覆盖，
  回落到**种子默认**（`builtinDefault`），没被清的全局覆盖保持不变；
- `/rules overrides [+页码]`（或全局卡上的「覆盖率总览」）分页列出每个群显式覆盖的字段，便于排查继承差异；
  仅全局超管可用，群角色调用返回「权限不足」卡。
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

### 交互菜单（`/menu`）

QQ 端的系统交互菜单，三级结构：主菜单 → 系统 / 管理 / 超管菜单 → 功能子菜单。

```text
/menu           主菜单：按权限显示「系统菜单 / 管理菜单 / 超管菜单」入口
/menu sys       系统菜单：帮助 / 绑定 / 我的权限 / 个人资料 / 活动（所有人）
/menu admin     管理菜单：待审批 / 同步 / 规则 / 审计 / 状态 / 自检（审核员及以上）
/menu review    审核操作：/approve、/reject 的用法（群管理员及以上）
/menu ops       活动运营：活动创建/开停/名单、/export（群管理员及以上）
/menu super     超管菜单：/perm、/rules all、/whois、/alias、/bind user|groupid（仅全局超管）
```

要点：

- 菜单按钮都是**指令按钮**（`action.type = 2`）：点击等价于发送对应指令，
  权限校验、审计与手输完全一致，不新增任何事件类型
  （群里点击是先把指令填进输入框，部分客户端需再按发送；单聊会直接发送，需客户端 8983+）；
- 自定义按钮是官方**内邀白名单**能力，未开通时自动降级为纯文本菜单，正文里同样列出指令；
- 需要参数的指令（如 `/approve <申请ID>`）在菜单正文里给用法，不提供点不动的死按钮；
- 群里 `@机器人` 不带内容、私信里第一次与机器人交互，都会收到主菜单；
- 私信「首次推送」的记录方式由 `MENU_FIRST_PUSH` 控制：
  - `pnpm dev` 默认 `memory`（只记内存，重启可以再验证一次）；
  - 正式启动默认 `persistent`（入库 `menu_deliveries`，重启不重复推送）；
  - 想显式指定时在 `.env` 写 `MENU_FIRST_PUSH=memory|persistent`。

### 回调按钮翻页（`/testmenu`）

仅全局超管可用，用于验证官方回调按钮与互动事件链路：

```text
/testmenu         第 1 页
/testmenu 2       直接跳到第 2 页（1-3）
```

- 网关 intent 现在包含 `INTERACTION (1<<26)`：
  `GROUP_MEMBER_EVENT | GROUP_AND_C2C_EVENT | INTERACTION_EVENT`（重启后生效）；
- 收到 `INTERACTION_CREATE`（`type=11` 消息按钮）后必须调 `PUT /interactions/{id}` 回包
  （请求体只有 `{ code }`），否则客户端会一直 loading 直到超时；同一 id 只能回一次；
- 官方**没有更新原消息的接口**：翻页是回包后由机器人**主动发送**新的一页；
- **不能**把 interaction id 当 `msg_id` 发被动消息：真机实测群聊返回
  `400 请求参数msg_id无效或越权`，所以代码不再走被动通道（避免每翻一页白等十几秒）；
- 双通道兜底：卡片正文与第二行按钮保留 `/testmenu <页码>`；
- 当前行为：**每次翻页发一条新卡片**，旧卡片留在聊天记录里（官方没有编辑接口）；
  若以后要"看起来像原地翻页"，可用撤回旧卡片近似实现。

### @ 渲染自检（`/testat`）

仅全局超管、**在群里**执行，用于实测「怎样发才能真正 @ 到人」：

```text
/testat         发 3 条：纯文本 @、Markdown 首行 @、Markdown 正文中间 @
/testat all     再多发 5 条 @全体候选（@everyone / <@!all> / <@!everyone> / 文字 / 纯文本），会打扰全群
```

**真机实测结论（本机群聊，2026-09）**：

- Markdown 卡片里的 `<@!openid>`（首行、正文中间都算）**生效** → 项目所有 @ 反馈继续用卡片内 @；
- 纯文本 `content` 里的 `<@!openid>` **不生效**，纯文本 `@everyone` **也不生效**；
- 所以**官方「内嵌格式只在 content 生效」这条文档在群聊 Markdown 上不成立**，以实测为准；
- **@全体成员：官方群聊能力做不到**。`/testat all` 穷举了 5 种写法（Markdown 里的 `@everyone`、
  `<@!all>`、`<@!everyone>`、纯文字 `@全体成员`，以及纯文本 `<@!all>`），**全部不生效**；
  需要通知全群时只能由管理员手动 @全体，或改用其它触达方式（活动模块用「通知发起人/私信参与者」补齐）；
- 纯文本通道仍保留在 `RichMessageSender.sendPlainToGroup()/sendPlainToUser()`（`/testat` 的对照项在用）。

### 卡片标准与分页

所有指令输出都是菜单式卡片（规范见 [CARD-STANDARD.md](CARD-STANDARD.md)）：

- `/menu` 覆盖全部指令：系统 / 管理 / 超管 + 活动 / 审核操作 / 活动运营，
  **导航按钮是回调**（点击即出下一张卡片，不用再发消息）；需要参数的指令在正文给用法；
- 导航 / 查看 / 翻页按钮是**回调按钮**；开关与枚举（规则开关、入群决策、订阅开关）也是回调，
  点击即自动生效；执行动作里需要自由文本或不可逆的仍是指令按钮（危险动作带二次确认）；
- 回调自动完成的动作都会回一张**刷新后的卡片**；群内会在开头**单独一行 @ 操作人**，私聊不 @（操作人就是接收者本人）；
- 列表分页：每页固定条数 + 回调翻页，正文同时给出 `+页码` 指令，例如
  `/pending +2`、`/audit 20 +2`、`/activity list +2`、`/activity signups #A7K2Q9 +2`；
- 排版约束：一行按钮文字合计 ≤12 字、单个按钮 ≤10 字、整盘 ≤5 行，过挤就拆子卡；
- 按钮未开通时自动降级为纯文本；手动指令统一在 `/help` 里查，卡片只保留分页用的 `+页码` 提示；
- **活动卡片拆成四张子卡**：成员卡（群里那张）/ 配置卡 / 管理卡 / 名单卡；
  活动配置项多（名额、限制、截止、递补、开关、起停），按标准拆开而不是硬塞一张卡。

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
/whois                                  # 超管查询映射：群聊=当前群，私聊=你自己
/whois <QQ号|userId|群号|group_openid>  # 超管查询指定目标
/whois <@对方>                          # 群内 @ 某人（官方 at 段）指定目标
/whois profile <@对方|QQ号|userId|#短码> # 超管查询个人资料（姓名/学号/班级/学院/年级）
```

绑定后可以直接用 QQ号/群号执行命令：

```text
/perm grant mod 123456
/status 654321
/pending 654321
```

**展示规则：已绑定显示解析号，未绑定显示随机短码；内部系统 id 永不暴露。**

- 已绑定 QQ号 / 群号 → 只显示 QQ号 / 群号；
- 未绑定用户 / 群 → 显示随机短码 `#M7K2Q9`（6 位、**数字 + 大写字母**、随机生成、唯一索引、碰撞重生成），不再显示 `userId` / `group_openid`；启动时会把历史遗留的含小写短码统一重生成成大写（旧短码随即失效，需重新获取）；手输时大小写不敏感；
- 入群申请 → 一律显示申请短码，替代又长又难读的 `join_request_id`；
- 覆盖范围：`/pending`、`/sync`、推送卡片与纯文本降级、`/audit`、`/status`、`/test`、`/myperm`、`/perm list`、`/notify` 状态、`/rules` 标题、`/bind` 成功回复；
- 命令参数同时接受群号/QQ号与短码：`/status 654321`、`/approve #M7K2Q9`、`/rules set #G7K2Q9 keywords 广告` 都能执行；完整 `join_request_id` 仍然兼容；
- **唯一例外是 `/whois`**（超管）：`/whois #M7K2Q9` 会显示短码对应的类型与真实系统 id，`/whois <QQ号>` 显示对应 `userId` 与短码；**不带参数时直接查当前上下文**（群聊=当前群、私聊=你自己）；`/whois profile <@对方|QQ号|userId|#短码>` 额外给出该用户的个人资料（姓名/学号/班级/学院/年级），同样仅限全局超管（资料属个人信息，不开放给群管理员）；
- **`/whois` 的结果只走私信**（隐私优先，用户确认）：
  - 私聊里发指令 → 直接回复；群聊里发指令 → 结果私信给操作人，群里只回一张「已私信发送」的提示卡，**群里不出现任何查询内容**；
  - 私信发送失败（例如对方从没和机器人私聊过、未开启主动消息）→ 群里只提示「先私聊机器人再试」，**绝不降级到群里显示结果**；
  - 权限不足 / 用法 / 未找到映射这类不含隐私的提示仍在原处直接回；
  - 群内可用 `@` 指定目标：`/whois <@对方>`、`/whois profile <@对方>`（官方 at 段自带对方 id）；
    `@昵称` 无法反查（官方成员列表接口当前不可用），会提示改用 QQ号 / userId / 短码；
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

## 个人资料与活动

### `/profile`（个人资料）

| 变量 | 必填 | 说明 |
|---|---|---|
| 无 | — | 个人资料不需要环境变量；班级库复用 `CLASS_INDEX_FILE` |

```text
/profile                                      查看
/profile set <班级> <姓名> <11位学号>           智能识别（顺序/分隔符随意）
/profile set name <姓名>
/profile set id <11位学号>                     前两位必须是 22-26
/profile set class <班级>                      必须在 class-index.json 的 classes 里
/profile set college <学院>                    可手动覆盖（默认由班级库带出）
/profile set year <年级>                       可手动覆盖，**只写两位**（22）；四位年份会被拒绝
/profile set <字段> clear                     清除单个字段
/profile clear                                清空
```

- 智能识别：11 位数字 = 学号；能在班级库里匹配到的最长班级名 = 班级；剩余 2-4 个连续汉字 = 姓名；
  支持空格 / `-` / `+` / `/` 等分隔符，也支持完全不带分隔符（`材化2211张三22123456789`），
  以及 `班级=材化2211 姓名=张三 学号=22123456789` 显式写法；
- 识别到多个班级/姓名或存在认不出的内容时**整体不写入**，返回错误并列出识别结果；
- 写入前整体校验（学号前缀 22-26、班级必须在班级库中、姓名 1-20 字），避免"写一半失败"；
- **年级统一两位**：输入只接受 `22`/`23`/…，四位完整年份（`2022`）直接报错；班级库里的四位年份
  （`njmc=2022`）写入个人资料时会自动转成两位；启动时历史数据的四位年份会收敛成两位并写回；
- 存储：`user_profiles`（`user_id` 主键 + 姓名/学号/班级/学院/年级）；
- 班级库缺失时 **拒绝** 设置班级（不会静默存一个查不到的班级）；
- 报名活动前要求「姓名 + 学号 + 班级」齐全。

### `/alias`（班级 / 学院 / 专业别名表）

```text
/alias                                          查看别名表（卡片）
/alias set <别名> <规范名>                       新增/覆盖（类型自动判定）
/alias del <别名>                               删除
```

- 仅**全局超级管理员**；入口在 `/menu super`，详细用法 `/help alias`；
- 规范名必须来自 `data/class-index.json`（班级 / 学院 / 专业之一），类型由目标自动判定，
  不需要用户指定；别名不能与规范名完全相同；
- 别名用于：
  - `/profile set` 的智能识别（别名先展开成规范名，再走班级/学院匹配，专业别名不参与）；
  - 入群审核的「班级+姓名」匹配（回答里写别名也能命中班级，自定义正则仍匹配原始回答）；
- 匹配忽略空白差异、**长别名优先**（`环工2214` 不会被 `环工` 切碎）；
- 全局生效；存储：`class_aliases`（`alias` 主键 + `target` + `kind` + `updated_at`）。

### `/activity`（活动发布 / 报名 / 管理）

```text
/activity                                      本群活动列表（按「报名中 / 草稿 / 已结束」分组）
/activity list <群号|#群短码> [+页码]
/activity create <标题>                         创建（群管理员+；私信需先写群号）→ 返回配置卡
/activity set <#活动短码> <字段> <值>
/activity open <#活动短码>                      开放并把卡片发到**所有绑定群**（回调 cb:activity:open 等价）
/activity close|/activity cancel <#活动短码>
/activity bind <#活动短码> <群号|#群短码>        绑定发布 / 广播目标群（可多个）
/activity unbind <#活动短码> <群号|#群短码>      解绑目标群
/activity join <#活动短码> [备注]                报名（群内结果只私信）
/activity quit <#活动短码>                      取消报名（群内结果只私信）
/activity info <#活动短码>
/activity signups <#活动短码> [+页码] [full]    报名名单（群管理员/发布者；默认不含学号/学院）
/activity subscribe|unsubscribe [群号|#群短码]  订阅/退订「新活动通知」（默认本群）
```

回调命名空间 `activity`（`cb:activity:<action>[:args]`，**renderer 内部重新做权限校验**）：

| action | 参数 | 权限 | 行为 |
|---|---|---|---|
| `join` / `quit` | `<短码>` | 任意成员 | 报名 / 取消报名（带官方 `modal` 二次确认）；**群内静默**，结果只私信 |
| `info` | `<短码>` | 任意成员 | 活动详情卡 |
| `signups` | `<短码>:<页码>[:full]` | 管理者 | 名单卡（分页；`full` 才显示学号/学院） |
| `page` | `<群>:<页码>` | 任意成员 | 活动列表翻页 |
| `config` / `manage` / `preview` | `<短码>` | 管理者 | 配置卡 / 管理卡 / 成员卡预览 |
| `open` / `status` / `cancel` | `<短码>[:open\|close]` | 管理者 | 开放报名（发到所有绑定群）/ 开停 / 取消活动 |
| `release` | `<短码>` | 管理者 | 释放一个冻结名额（优先递补候补第一位） |
| `resend` | `<短码>` | 管理者 | 把成员卡重发到**所有绑定群** |
| `set` | `<短码>:<字段>:<值>` | 管理者 | 配置卡上的快捷设置（名额 / 截止 / 递补 / 开关 / 学院年级列表） |
| `bindings` | `<短码>[:<页码>]` | 管理者 | 绑定群子卡（每页 5 个，含解绑与「绑定群」指令按钮） |
| `bind` | `<短码>` | 管理者 | 绑定群操作说明卡（预填 `/activity bind <#短码> `） |
| `unbind` | `<短码>:<群ID>:<页码>` | 管理者 | 解绑该群（固定动作，点一下即生效） |
| `college` / `year` | `<短码>:<allow\|deny>:<页码>[:<取值>]` | 管理者 | 学院 / 年级白黑名单子卡（`●` 标已选，点一下切换） |
| `subscribe` | `<群>:<on\|off>` | 任意成员 | 切换「新活动通知」订阅 |
| `stats` | `<短码>` | 管理者 | §B3 统计图片；**未装配统计服务时降级为文字统计卡** |
| `export` | `<短码>` | 管理者 | §B3 CSV 导出（私信给操作者）；**未装配时提示不可用** |

`/activity set` 字段：

| 字段 | 说明 |
|---|---|
| `title` / `desc` | 标题 / 简介 |
| `capacity` | 名额上限（正整数；`clear` 取消限制） |
| `group` | 卡片里展示的活动群号 |
| `link <url>` / `link <说明=url>` | 追加链接（可多次）；`links clear` 清空 |
| `closeAt <MM-DD HH:mm\|YYYY-MM-DD HH:mm>` | 报名截止时间；`clear` 取消（懒校验，到期即拒绝报名） |
| `waitlistPromotion auto\|manual` | 递补方式：自动递补 / 手动释放名额（**默认 manual**） |
| `mentionAll on\|off` | 开放报名时是否提示操作者手动 @全体（机器人**无法** @全体成员） |
| `notifyCreator on\|off` | 有人报名时是否私信通知活动发起人 |
| `allowColleges` / `denyColleges` | 学院白名单 / 黑名单（逗号、顿号或空格分隔） |
| `allowYears` / `denyYears` | 年级白名单 / 黑名单（22、23…；`2022` 也接受） |

- 存储：`activities` / `activity_registrations`（原有）+ `activity_details`（短码、群号、链接、限制）
  + `activity_waitlist`（候补）+ `activity_settings`（@全体 / 通知发起人 / 截止 / 递补方式 / 冻结名额）
  + `activity_groups`（**绑定群**，§B4），全部是 `CREATE TABLE IF NOT EXISTS` 幂等升级，老库无需 ALTER；
- 活动短码是 6 位随机短码（**数字 + 大写字母**，`#A7K2Q9`），在 `activity_details.code` 上有唯一索引；启动时同样会把含小写的旧活动短码重生成；
- 报名规则：**黑名单优先**，白名单为空表示不限；年级来自 `/profile` 学号前两位；学院匹配允许简称（`环境` 命中 `环境科学与工程学院`）；
- 名额满了自动进候补；`auto` 模式取消报名立刻递补，`manual` 模式（默认）名额被**冻结**，
  管理员在管理卡上点「释放名额」才转成递补或放回公开池；
- **绑定群**（`activity_groups`）：创建活动自动绑定创建群；`/activity bind|unbind` 与配置卡的
  「绑定群」子卡维护。`activities.group_id` 仍是**归属群**（创建地 / 权限依据），绑定群是
  **发布与广播的目标群集合**；绑定全部解绑后回落到归属群。发布（`open`）、重发卡片会打到
  所有绑定群，操作者私信回执列出各群成功 / 失败；
- **满员广播**：某次报名后恰好满员时，往所有绑定群各发一张「活动已满 X/X」卡，
  **每个群只发一次**（复用 `activity_notifications` 去重，键 `(活动, group:<群ID>, full)`；
  群消息不占用户私信额度。`group:<群ID>` 是伪接收者，不会与真实用户 ID 冲突）；
- 卡片发送与入群申请共用 `RichMessageSender`：Markdown+按钮 → Markdown → 纯文本；
- 权限：`canApproveJoin`（群管理员+）或活动发布者本人。

**消息落点（隐私优先，§B4 群内静默）**：

- **群内报名 / 取消报名一律静默**：群里点回调或手输 `/activity join|quit` 都**不发任何群消息**
  （连「原因已私信」都不发），成功 / 候补 / 失败原因一律私信本人，私信可以带姓名/学号/班级/序号/人数；
- **唯一例外**：私信发送失败（没私聊过机器人 / 关闭主动消息 / 被限流）时，群里允许回一条
  **不含任何结果**的提示「`<@!申请人>` 私信发送失败，请先私聊机器人再试」，
  **绝不**把结果或原因降级到群里；
- 私聊里用 `/activity join|quit` 仍然原地回复（命令与回调都一样）；
- 活动发布：群内发成员卡（**发到所有绑定群**），并私信操作者回执（各群发送结果 +
  「机器人无法 @全体成员」提示 + 重发/关停入口），并给**订阅者**私信活动卡；
- 活动取消 / 变更 / 递补：只私信当事人（已报名 + 候补），不往群里发；
- 主动私信**去重**（`activity_notifications` 的 `(活动, 用户, 类型)` 主键）+ **每人每天封顶**
  （`ACTIVITY_NOTIFY_DAILY_LIMIT`，默认 3），失败只记日志。

### 活动统计图片与 CSV 导出（§B3）

管理卡的「统计图片」与名单卡的「导出 CSV」是两个**可选能力**：

- 统计图 = `ActivityStatsService`（`src/services/activityStats.ts`）：宽度固定 720、高度按内容自适应，
  内容为标题、`报名 X/Y`、`候补 N`、`待释放名额 M`、`截止`、学院分布与年级分布（横向条形 + 人数）；
- 导出 = `ActivityExportService`（`src/services/activityExport.ts`）：列固定为
  `序号,姓名,学号,班级,学院,备注,候补`，以代码块**私信给操作者本人**（群里不回执内容）。

依赖与字体（**任一项拿不到就降级为文字统计卡，绝不影响启动**）：

| 项目 | 说明 |
|---|---|
| `@napi-rs/canvas` | **可选依赖**，用变量拼包名的动态 `import()` 加载；没装 → `render()` 返回 `undefined` → 文字统计卡 |
| 系统字体（优先） | Windows `C:/Windows/Fonts/msyh.ttc` 等；Linux `/usr/share/fonts/**/NotoSansCJK*`、`wqy-*`；macOS 苹方 |
| `ACTIVITY_STATS_FONT_URL` | 系统字体都没有时从这里下载并缓存到 `data/fonts/`；默认 Noto Sans SC 官方发布地址 |
| 缓存目录 | `data/fonts/`（`data/` 已 gitignore，**字体缓存不随包提交**）；文件名固定 `activity-stats.otf` |
| 发送 | 官方「群聊富媒体上传」（`{ file_type: 1, ... }` → `file_info`）+ `msg_type: 7` 富媒体消息；上传/发送失败同样降级为文字统计卡 |

```bash
# 没有系统中文字体（常见于容器）时，指向可达的字体地址；留空表示「只用系统字体」
ACTIVITY_STATS_FONT_URL=https://example.com/NotoSansSC-Regular.otf

# 容器里想真正出图，需要先装可选依赖（原生包）
pnpm add @napi-rs/canvas
```

- 「统计图片」按钮只在**既能渲染又能发送**时生成（避免点了没反应的入口）；
- CSV 超过单条消息长度上限（默认 1800 字符）时不硬塞，改为私信提示用 `/export #短码` 拿完整文件
  —— 被平台截断的半份名单风险更高；
- 官方群图片上传没有「multipart 直传字节」接口：`QQOfficialEndpoints` 里的
  `groupFileUpload`（`/v2/groups/{groupId}/files`）、`groupFileUploadPrepare`
  （`/v2/groups/{groupId}/upload_prepare`）、`groupFileUploadPartFinish`
  （`/v2/groups/{groupId}/upload_part_finish`）都可按官方文档与自建代理覆盖。

### 关键词豁免（审核员及以上）

操作 | 权限
---|---
`/profile`、`/activity join|quit|info|subscribe` | 任意已绑定用户
`/activity create|set|open|close|cancel|signups` | 群管理员+ 或活动发布者
`cb:activity:<config|manage|preview|open|status|cancel|release|resend|set|college|year|stats|export>` | 同上（回调 renderer **重新校验**一次）
`cb:activity:<join|quit|info|page|subscribe>` | 任意成员
消息关键词判断 | **审核员及以上直接豁免**（不警告/不撤回/不处罚、不写审计，仅 debug 日志）

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
| `user_profiles` | 个人资料（姓名/学号/班级/学院/年级） | `UserProfileService` |
| `class_aliases` | 班级/学院/专业别名 → 规范名 | `ClassAliasService` |
| `activity_details` | 活动短码/群号/链接/学院年级限制 | `ActivityService` |
| `group_message_modes` | 全量消息模式诊断 | `GroupMessageModeRegistry` |
| `activities` / `activity_registrations` | 活动与报名 | `ActivityService` |
| `activity_waitlist` | 活动候补名单 | `ActivityService` |
| `activity_settings` | 活动扩展设置（@全体 / 通知发起人 / 截止 / 递补方式 / 冻结名额） | `ActivityService` |
| `activity_subscriptions` | 活动通知的按群订阅 | `ActivityNotificationService` |
| `activity_notifications` | 活动通知去重 + 每人每日计数 | `ActivityNotificationService` |

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
| `JOIN_REQUEST_TTL_DAYS` | 否 | 待审批入群申请有效期（天），默认 `7`；超过即标记 `expired`（不删数据，`/whois` 可追溯），`0` 表示不自动过期 |
| `ACTIVITY_NOTIFY_DAILY_LIMIT` | 否 | **活动通知**每人每日上限，默认 `3`；非负整数，`0` = 不限制 |
| `ACTIVITY_NOTIFY_RATE_PER_SECOND` | 否 | **活动通知**令牌桶速率（条/秒），默认 `5`；正整数，`0` = 不限制。桶容量按速率向上取整，桶空时**排队等待**下一个令牌（不丢通知） |
| `ACTIVITY_REMIND_INTERVAL_MS` | 否 | **活动定时提醒**的轮询间隔（毫秒），默认 `60000`（1 分钟）；`0` = 关闭扫描。提醒由 `/activity set <短码> remindAt MM-DD HH:mm` 设置，到点在所有绑定群广播一次 |
| `ACTIVITY_STATS_FONT_URL` | 否 | 统计图片的中文字体下载地址（系统字体都没有时才用）；默认 Noto Sans SC 官方发布地址，留空表示只用系统字体 |
| `APPEAL_HOLD_MINUTES` | 否 | **申诉值班**单人持有时间（分钟），默认 `15`；`0` = 不自动转派。申诉默认通知**所有管理员**（群管理员 / 本群超管 / 全局超管），**审核员之间轮单**（一次只通知一位），超时未处理转给下一位 |
| `APPEAL_FORWARD_INTERVAL_MS` | 否 | 申诉值班超时扫描间隔（毫秒），默认 `60000`；`0` = 关闭扫描（等价于不自动转派） |

> **申诉派发口径**：管理员全部通知是为了"必须有人知道"；审核员轮单是为了不打扰所有人。
> 处理完成后，`ModerationNotifier.notifyAppealHandled` 会把结果同步给其余订阅者（脚本同步卡），
> 并且申诉人本人会收到通过 / 驳回的结果私信。值班记录是内存态：进程重启后会从第一位审核员重新开始，
> 投递去重键带 `attempt`，所以不会把同一张卡重复推给同一个人。

`ACTIVITY_NOTIFY_DAILY_LIMIT` 的用途：活动发布 / 变更 / 取消 / 递补的通知走**主动私信**，
而官方对主动消息有限额（单用户每天 1000 条、单关系 20 qpm、未认证机器人 5 qps & 30 qpm），
用户还可以在 QQ 客户端关闭「允许主动发送」。因此活动通知在 `activity_notifications` 里
按 `(活动, 用户, 类型)` **去重**，并用这个变量做**每人每天封顶**；超过上限只记 warn 日志、不再发送
（活动本身的状态不受影响）。

`ACTIVITY_NOTIFY_RATE_PER_SECOND` 是**平滑发送速率**的令牌桶：一次活动变更可能有几十个接收人，
逐条串行发送时用它限速，避免瞬间打满官方 qps；桶空时该条通知会等待（`waitedMs` 记 debug 日志），
而不是被丢掉。它只作用于活动通知，入群申请推送不受影响。

清理行为（`RetentionService`）：

- 启动时执行一次，之后每 24 小时执行一次；
- 删除早于 `AUDIT_LOG_RETENTION_DAYS` 的审计记录；
- **先把过期的待审批申请标记为 `expired`**（有效期 = `JOIN_REQUEST_TTL_DAYS`，默认 7 天）：
  标记后不再出现在 `/pending`、推送与统计里，但 `/audit` 记 `expire_join_request`、`/whois` 仍可追溯；
- 删除早于同一保留期、且**已审批**的入群申请；未过期的待审批申请不清理；
- `/sync` 会与官方列表对账：官方已不再返回、且已存在超过 1 小时的本地待审批也标记为过期；
- 查询 `/pending` 时还会做一次懒清理，保证卡片里不出现过期项。
- 清理同时作用于内存缓存与数据库，避免启动全量载入导致内存无限增长。

`RAW_MESSAGE_RETENTION_DAYS` 控制**触发处罚的那条消息原文**的保留期：默认 `0` 表示不落库
（隐私优先，只保存审核结果与规则命中信息）；设为 `3–7` 后，关键词 / 正则命中的消息会以**单行 + 截断 ≤200 字**
存进 `punishment_records.message_excerpt`，只用于审核员与当事人本人的**私信卡片**（群里那张「处罚通知」不带原文、
也不写命中的具体规则）。到期由 `RetentionService` **只清原文**，处罚记录本身仍按 `AUDIT_LOG_RETENTION_DAYS` 保留。
也可按群覆盖：`/rules set rawMessageRetentionDays 7`（`clear` 归零）。

`ACTIVITY_STATS_FONT_URL` 只影响活动统计图片：系统已有中文字体（Windows 雅黑 / Linux Noto CJK 等）时
根本不会请求它；下载成功的字体会缓存到 `data/fonts/activity-stats.otf`（`data/` 已 gitignore，
**不随包提交**），重启后直接复用。字体与 `@napi-rs/canvas` 都拿不到时统计图降级为文字统计卡，
**不会影响启动或活动本身**（清理行为同样不碰字体缓存）。

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
