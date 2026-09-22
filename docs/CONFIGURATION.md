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

## 权限

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_QQ_IDS` | 否 | 超级管理员 QQ 号，逗号分隔 |

示例：

```env
ADMIN_QQ_IDS=123456,234567
```

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
