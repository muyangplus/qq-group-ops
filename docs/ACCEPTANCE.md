# 真实环境验收清单

本文对应 [ROADMAP](ROADMAP.md) Phase 1 的退出条件，用于在**真实 QQ 群**中逐项验收。每个验收项都给出操作、预期结果与失败排查方向。

> 建议在一个测试群 + 一个测试机器人上执行，避免影响正式群。
> 执行前请确认 `.env` 已填写 `QQ_BOT_APP_ID`、`QQ_BOT_CLIENT_SECRET`、`ADMIN_USER_IDS`。

## 0. 准备

```bash
pnpm install
pnpm class:index          # 可选：配置班级+姓名入群规则时需要
cp .env.example .env      # 填写 AppID / Secret / ADMIN_USER_IDS
pnpm typecheck && pnpm test && pnpm build
pnpm dev
```

`pnpm test` 中的 `test/acceptance.test.ts` 已用真实 SQLite 文件 + 官方 API 测试替身自动跑通
B/C/D/G 组的核心链路（审批闭环、关键词警告/处罚与审计、班级+姓名入群规则、按群隔离、重启恢复、动态 `/help`），
因此人工验收只需聚焦**依赖真实 QQ 平台**的部分（真的进群、真的禁言/踢人、真实事件推送）。

启动后应看到（`logs/qq-group-ops.log` 或控制台）：

- `bot cache status { tokenCached, gatewayUrlCached, cacheFile }`
- `gateway hello { heartbeatIntervalMs }`
- `gateway ready: bot authenticated`

| # | 验收项 | 操作 | 预期结果 | 失败排查 |
|---|---|---|---|---|
| A1 | 机器人上线 | `pnpm dev` | 日志出现 `gateway ready`，`/test` 有响应 | 检查 AppID/Secret；是否被限流（`400 频率限制`） |
| A2 | 首次拉起缓存 | 首次启动后看日志 | 出现 `access token acquired` 与 `gateway url received` | 反复出现说明缓存文件不可写（`QQ_BOT_CACHE_FILE`） |
| A3 | 重启复用缓存 | 重启进程 | 出现 `gateway url reused from cache`、`access token reused from cache`，且**不再**请求 `/gateway` | 若仍请求，检查缓存文件是否被删或 AppID 变化 |
| A4 | 限流不硬打 | 反复快速重启 5 次 | 不出现 `/gateway` 400；必要时出现 `cooling down` 日志 | 仍报 400 说明缓存未生效 |

## 1. 绑定与权限

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| B1 | 用户绑定 | 群内或私信 `/bind qq <QQ号>` | `已绑定：userId ... ↔ QQ ...` |
| B2 | 查询自己的权限 | `/myperm` | 显示权限等级与各项能力布尔值 |
| B3 | 动态帮助 | `/help` | 只出现当前用户有权限执行的指令；未绑定用户只看到 `/help`、`/bind` |
| B3b | 指令主题帮助 | 管理员执行 `/help rules`，普通成员也执行一次 | 管理员看到完整字段说明 + 该群当前生效值；普通成员只看到「权限不足 + 所需权限」，不展示 `/rules set` 细节 |
| B4 | 用 QQ号执行命令 | 超管 `/whois <QQ号>` | 返回对应 userId |
| B5 | 群号绑定 | 群管理员 `/bind group <群号>` | `已绑定：group_openid ... ↔ 群号 ...` |
| B6 | 强制绑定 | 未绑定用户在群里发 `/myperm` | 返回 `请先绑定 QQ 号：/bind qq <QQ号>` |
| B7 | 权限持久化 | 超管 `/perm grant mod <QQ号>` 后重启进程 | `/myperm` 仍是 moderator，权限未回退 |
| B8 | 本群超管只在本群生效 | 超管 `/perm grant gsuper <QQ号>`（在群 g1 内），再让该用户去另一个群执行 `/approve` | 群 g1 内可审批/改规则；别的群或私信中报「权限不足」；`/perm`、`/rules all` 始终被拒 |
| B9 | 全局超管不被本群超管顶掉 | 只配置本群超管后重启进程 | 日志出现 `seeding super admins from configuration`，`ADMIN_USER_IDS` 仍是全局超管 |
| B10 | 超管私信看帮助 | 全局超管私信 `/help rules`、`/help notify` | 正常返回详细帮助，不再出现「权限不足」 |
| B11 | 超管私信看全局规则 | 全局超管私信发 `/rules`（不带群号） | 显示全局默认规则（等价 `/rules all`） |

## 2. 入群审批闭环（Phase 1 关键退出条件）

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| C1 | 收到申请 | 用小号申请入群（或先 `/sync` 拉取） | `/pending` 能看到申请 ID 与申请人 |
| C2 | 官方同步 | `/sync` | 输出 `已同步官方待审批申请，当前待审批 N 条`；30 秒内重复执行提示冷却 |
| C3 | 通过 | `/approve <申请ID>` | 回复 `已通过入群申请 ...`，**且该用户真的进入群** |
| C4 | 拒绝 | `/reject <申请ID> 资料不完整` | 回复 `已拒绝...`，用户未进群，`/audit` 里 reason 为「资料不完整」 |
| C5 | 官方失败不误报 | 权限不足/接口报错时执行 `/approve` | 返回 `审批失败：...`，`/pending` 里申请仍是待审批 |
| C6 | 自动通过 | `/rules set autoApprove on` 后再有申请 | 无需人工操作即通过（日志 `auto approved join request`） |
| C7 | 班级+姓名规则 | 先 `pnpm class:index`，再 `/rules set joinRequireClass on`、`/rules set joinRequireName on`、`/rules set joinDecision approve_on_match`、`/rules set joinReviewOpinion on`；用正确回答与错误回答各申请一次 | 正确 → 自动通过；错误 → 保持待审批，`/pending` 显示识别到的班级/姓名与「建议：人工审核」 |
| C8 | 规则不误放行 | 删除/改名 `data/class-index.json`，或把 `joinAnswerPattern` 设成无效正则（应被拒绝保存），再触发一次申请 | 规则无法判定时一律转人工，日志有 `configIssue`，绝不会自动通过 |
| C9 | 决策模式 | 分别试 `reject_on_match` 与 `reject_on_mismatch` | 命中/未命中按表格语义自动拒绝，且 `/audit` 里 reason 为截断后的审核意见 |
| C10 | 订阅推送 | 群管理员在群里 `/notify on` | 回复「已开启」；`/notify` 显示「群 654321：已开启」；重启后 `/notify` 仍是已开启 |
| C11 | 收到卡片 | 用小号再申请一次入群 | 私聊收到 Markdown 卡片：群号、申请人、回答、审核意见，底部第一行「同意 / 拒绝」、第二行两个红色预设「拒绝：回答错误」「拒绝：班级姓名」 |
| C12 | 按钮审批 | 点「同意」并在二次确认里确认 | 自动发送 `/approve <group> <申请ID>`，申请通过；`/audit` 出现 `approve_join_request` |
| C12b | 预设拒因 | 点「拒绝：回答错误」并确认 | 自动发送 `/reject <group> <申请ID> 请正确回答问题。`，申请人收到的拒绝理由即为该文案 |
| C12c | 问答式入群验证 | 群设置为「管理员设置问题」（`admin_review_qa`）后申请一次 | 卡片「回答」显示申请人填写的答案、「入群问题」显示管理员设置的问题；班级+姓名规则能识别到 |
| C13 | 按钮未开通时降级 | 若应用没有自定义按钮白名单 | 仍能收到纯 Markdown（或纯文本）推送，内容带完整指令；日志出现键盘降级告警，审批流程不受影响 |
| C14 | 主动消息失败可见 | 在 QQ 客户端关闭「允许主动发送」后再申请一次 | 推送失败只记日志与投递状态，申请仍在 `/pending`；`/notify test` 返回失败提示 |

> C3 依赖官方 `approval_join_request` 接口与机器人权限；若返回 `11253` 或权限错误，请确认机器人在该群的管理员身份与开放平台权限。

## 3. 关键词审核

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| D1 | 配置关键词 | 群管理员 `/rules set keywords 测试违禁词` | 返回 `已更新群规则`，`/rules` 里能看到该关键词 |
| D2 | 命中警告 | 群里发送含关键词的消息 | 机器人发出该群警告文案（`/rules set warning ...` 可改） |
| D3 | 审计留痕 | `/audit` | 出现 `moderation:warn` 记录，reason 为 `命中关键词：...` |
| D4 | 按群隔离 | 在另一个群发同样内容 | 不触发（除非该群也配置了关键词） |
| D5 | 立即生效 | 追加一个关键词后立刻测试 | 无需重启即生效 |
| D6 | 重启保留 | 重启进程后 `/rules` | 关键词仍在 |
| D7 | 关闭过滤 | `/rules set wordFilter off` 后再发关键词 | 不再触发 |
| D8 | 命中撤回 | `/rules set keywordRecall on` 后发含关键词的消息 | 消息被撤回，且仍发出警告；`/audit` 的 detail 含 `recall` |
| D9 | 命中处罚 | `/rules set keywordPunish mute`（或 `kick` / `kick_blacklist`）后再发 | 该成员被禁言/移出/移出并拉黑；日志里能看到动作成功或 `*_failed`，全部失败时 `/audit` 状态为 `pending` 且警告仍会发出 |

## 4. 非 @ 指令识别

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| E1 | 开启全量消息 | 群管理员在机器人资料页开启「接收所有消息」 | 日志出现 `group message reception enabled` |
| E2 | 状态可见 | `/status` | `全量消息模式：all` |
| E3 | 非 @ 指令 | 群里直接发 `/myperm`（不 @ 机器人） | 机器人正常回复 |
| E4 | 未开启时行为 | 关闭「接收所有消息」 | `/status` 显示 `at_only`，非 @ 指令无响应（属预期） |

## 5. 禁言 / 踢人（可选，取决于开放平台权限）

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| F1 | 禁言 | `/rules set keywordPunish mute` 后触发关键词 | 该成员被禁言（时长取 `muteDuration`），`/audit` 有记录 |
| F2 | 解除禁言 | 时长为 0 | 立即解除 |
| F3 | 踢人 | `/rules set keywordPunish kick`（或 `kick_blacklist`）后触发关键词 | 成功；返回 `11253` 说明应用未在白名单，需要向平台申请 |
| F4 | 纯拉黑 | 目标不在群时调用黑名单接口（`updateMemberBlacklist`） | 成功；目标是群成员时该接口会报错，属预期 |

> 关键词命中的默认动作是「警告」；撤回与处罚由 `keywordRecall` / `keywordPunish` 配置（见 README「关键词处罚与入群审核规则」）。

## 6. 持久化与数据保留

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| G1 | SQLite 默认 | 不配置 `DATABASE_URL` 启动 | `databaseDriver: sqlite`，生成 `data/qq-group-ops.db` |
| G2 | 停机不丢数据 | 改配置/绑定后正常 Ctrl+C 退出再启动 | 数据仍在 |
| G3 | PostgreSQL 可切换 | `.env` 设 `DATABASE_URL=postgres://...` + `pnpm db:up` | `databaseDriver: postgres`，功能一致 |
| G4 | 内存模式 | `DATABASE_URL=memory` | 启动告警，重启后数据清空（预期） |
| G5 | 保留清理 | 日志中查看 `retention cleanup finished` | 启动时执行一次，无过期数据时为 0 |
| G6 | 规则全部入库 | 逐项执行 `/rules set`（含 `all` 与只改扩展字段的情况）后重启进程 | 每个字段都保持修改后的值：单群规则、全局规则、仅扩展字段的群覆盖都不丢 |

## 7. 验收记录模板

```text
验收人：
验收时间：
机器人 AppID：
测试群 group_openid：
Node / pnpm 版本：
数据库：SQLite / PostgreSQL
提交版本：git rev-parse --short HEAD

A 接入网关：通过 / 未通过      备注：
B 绑定与权限：通过 / 未通过    备注：
C 入群审批闭环：通过 / 未通过  备注：
D 关键词审核：通过 / 未通过    备注：
E 非 @ 指令：通过 / 未通过     备注：
F 禁言/踢人：通过 / 未通过     备注：
G 持久化：通过 / 未通过        备注：
H 入群申请推送：通过 / 未通过  备注：
```

## 8. 失败排查速查

```bash
# 是否被限流（应只在首次启动出现 /gateway 请求）
rg '"url":"https://api.bot.qq.com/gateway"' logs/qq-group-ops.log
rg 'cooling down|rate limited' logs/qq-group-ops.log

# 网关连接与重连
rg 'gateway (hello|ready|reconnect scheduled|invalid session|resumed)' logs/qq-group-ops.log

# 事件是否到达
rg '"message":"dispatch"' logs/qq-group-ops.log

# 审批调用
rg 'approveJoinRequest|approved join request|auto approved' logs/qq-group-ops.log

# 审核命中
rg 'rule matched|moderation:' logs/qq-group-ops.log

# 入群申请推送（订阅、降级、失败）
rg 'notification (subscribed|delivered)|join request push|custom keyboard rejected|notification attempt failed' logs/qq-group-ops.log

# 持久化写入失败
rg 'persistence write failed' logs/qq-group-ops.log
```

常见问题：

- **非 @ 消息没反应**：群管理员未开启「接收所有消息」，用 `/status` 看 `全量消息模式`。
- **400 频率限制**：等待 1–2 分钟；确认 `QQ_BOT_CACHE_FILE` 生效，重启复用 token 与网关地址。
- **审批后没进群**：查看是否返回 `审批失败`；确认机器人在群内是管理员、开放平台侧有相应权限。
- **踢人失败 11253**：该接口仅白名单机器人可用，需要向平台申请。
- **收不到入群推送**：确认 `/notify` 已开启、你在这个群有审批权限、已 `/bind qq`；若是主动消息被关闭或按钮未开通，看日志里的降级/失败记录，`/notify test` 可自检。
- **数据没保存**：确认 `DATABASE_URL` 不是 `memory`，并检查 `persistence write failed` 日志。
