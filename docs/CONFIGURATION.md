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
| `QQ_BOT_TOKEN` | 否 | 已有 access token；留空时由客户端自动获取 |
| `QQ_BOT_SANDBOX` | 否 | 是否使用沙箱环境，默认 `false` |

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
/perm list
/perm grant super <userId|QQ号>
/perm revoke super <userId|QQ号>
/perm grant admin <userId|QQ号>
/perm revoke admin <userId|QQ号>
/perm grant mod <userId|QQ号>
/perm revoke mod <userId|QQ号>
```

说明：

- `/myperm`：所有用户可查询自己的权限。
- `/help`：只显示当前用户有权限执行的指令。
- `/perm`：仅超级管理员可用。
- `super`：全局超级管理员。
- `admin`：当前群的群管理员。
- `mod`：当前群的审核员。
- 当前权限配置保存在内存中，重启后恢复为 `ADMIN_USER_IDS` 的初始值；PostgreSQL 持久化待实现。

### 私信指令

私信支持以下指令：

- `/myperm`
- `/help`
- `/test`（超级管理员）
- `/perm`（超级管理员）

群管理指令在私信中需要额外提供 `group_openid` 或已绑定的群号：

```text
/pending <group_openid|群号>
/approve <group_openid|群号> <申请ID>
/reject <group_openid|群号> <申请ID> [原因]
/rules <group_openid|群号>
/status <group_openid|群号>
/perm grant admin <group_openid|群号> <userId|QQ号>
/perm grant mod <group_openid|群号> <userId|QQ号>
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

强制绑定规则：

- 除 `/help`、`/bind` 外，用户必须绑定 QQ 号。
- 群聊内除 `/help`、`/bind` 外，群必须绑定群号。
- 私信中按群号执行群管理命令时，该群号必须已绑定。
- 未绑定用户会返回：`请先绑定 QQ 号：/bind qq <QQ号>`。
- 未绑定群会返回：`请先绑定本群：/bind group <群号>`。

当前映射保存在内存中，重启后丢失；PostgreSQL 持久化待实现。

## 数据库

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 生产是 | PostgreSQL 连接字符串 |

示例：

```env
DATABASE_URL=postgres://qqbot:change-me@localhost:5432/qq_group_ops
```

当前 PostgreSQL 相关代码包括：

- `src/db/schema.ts`
- `src/db/migrate.ts`
- `src/db/pgQueryable.ts`
- 审计 / 入群申请 / 群配置仓储

生产接入仍在继续完善。

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
| `RAW_MESSAGE_RETENTION_DAYS` | 否 | 消息原文保留天数；`0` 表示不保存 |
| `AUDIT_LOG_RETENTION_DAYS` | 否 | 审计日志保留天数，默认 `180` |

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
