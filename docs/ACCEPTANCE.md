# 真实环境验收清单

本文对应 [ROADMAP](ROADMAP.md) Phase 1 的退出条件，用于在**真实 QQ 群**中逐项验收。每个验收项都给出操作、预期结果与失败排查方向。

> 建议在一个测试群 + 一个测试机器人上执行，避免影响正式群。
> 执行前请确认 `.env` 已填写 `QQ_BOT_APP_ID`、`QQ_BOT_CLIENT_SECRET`、`ADMIN_USER_IDS`。

## 0. 准备

```bash
pnpm install
cp .env.example .env      # 填写 AppID / Secret / ADMIN_USER_IDS
pnpm typecheck && pnpm test && pnpm build
pnpm dev
```

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
| B4 | 用 QQ号执行命令 | 超管 `/whois <QQ号>` | 返回对应 userId |
| B5 | 群号绑定 | 群管理员 `/bind group <群号>` | `已绑定：group_openid ... ↔ 群号 ...` |
| B6 | 强制绑定 | 未绑定用户在群里发 `/myperm` | 返回 `请先绑定 QQ 号：/bind qq <QQ号>` |
| B7 | 权限持久化 | 超管 `/perm grant mod <QQ号>` 后重启进程 | `/myperm` 仍是 moderator，权限未回退 |

## 2. 入群审批闭环（Phase 1 关键退出条件）

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| C1 | 收到申请 | 用小号申请入群（或先 `/sync` 拉取） | `/pending` 能看到申请 ID 与申请人 |
| C2 | 官方同步 | `/sync` | 输出 `已同步官方待审批申请，当前待审批 N 条`；30 秒内重复执行提示冷却 |
| C3 | 通过 | `/approve <申请ID>` | 回复 `已通过入群申请 ...`，**且该用户真的进入群** |
| C4 | 拒绝 | `/reject <申请ID> 资料不完整` | 回复 `已拒绝...`，用户未进群，`/audit` 里 reason 为「资料不完整」 |
| C5 | 官方失败不误报 | 权限不足/接口报错时执行 `/approve` | 返回 `审批失败：...`，`/pending` 里申请仍是待审批 |
| C6 | 自动通过 | `/rules set autoApprove on` 后再有申请 | 无需人工操作即通过（日志 `auto approved join request`） |

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
| F1 | 禁言 | 触发一次禁言动作（或临时把关键词动作配置为禁言） | 该成员被禁言，`/audit` 有记录 |
| F2 | 解除禁言 | 时长为 0 | 立即解除 |
| F3 | 踢人 | 触发踢人动作 | 成功；若返回 `11253` 说明应用未在白名单，需要向平台申请 |

> 目前关键词命中默认动作是「警告」；禁言/踢人需要在规则引擎中配置对应动作（见 `src/services/moderation.ts`）。

## 6. 持久化与数据保留

| # | 验收项 | 操作 | 预期结果 |
|---|---|---|---|
| G1 | SQLite 默认 | 不配置 `DATABASE_URL` 启动 | `databaseDriver: sqlite`，生成 `data/qq-group-ops.db` |
| G2 | 停机不丢数据 | 改配置/绑定后正常 Ctrl+C 退出再启动 | 数据仍在 |
| G3 | PostgreSQL 可切换 | `.env` 设 `DATABASE_URL=postgres://...` + `pnpm db:up` | `databaseDriver: postgres`，功能一致 |
| G4 | 内存模式 | `DATABASE_URL=memory` | 启动告警，重启后数据清空（预期） |
| G5 | 保留清理 | 日志中查看 `retention cleanup finished` | 启动时执行一次，无过期数据时为 0 |

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
```

## 8. 失败排查速查

```bash
# 是否被限流（应只在首次启动出现 /gateway 请求）
rg '"url":"https://api.sgroup.qq.com/gateway"' logs/qq-group-ops.log
rg 'cooling down|rate limited' logs/qq-group-ops.log

# 网关连接与重连
rg 'gateway (hello|ready|reconnect scheduled|invalid session|resumed)' logs/qq-group-ops.log

# 事件是否到达
rg '"message":"dispatch"' logs/qq-group-ops.log

# 审批调用
rg 'approveJoinRequest|approved join request|auto approved' logs/qq-group-ops.log

# 审核命中
rg 'rule matched|moderation:' logs/qq-group-ops.log

# 持久化写入失败
rg 'persistence write failed' logs/qq-group-ops.log
```

常见问题：

- **非 @ 消息没反应**：群管理员未开启「接收所有消息」，用 `/status` 看 `全量消息模式`。
- **400 频率限制**：等待 1–2 分钟；确认 `QQ_BOT_CACHE_FILE` 生效，重启复用 token 与网关地址。
- **审批后没进群**：查看是否返回 `审批失败`；确认机器人在群内是管理员、开放平台侧有相应权限。
- **踢人失败 11253**：该接口仅白名单机器人可用，需要向平台申请。
- **数据没保存**：确认 `DATABASE_URL` 不是 `memory`，并检查 `persistence write failed` 日志。
