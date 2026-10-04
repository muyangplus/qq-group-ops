# 运维与部署（Operations）

> 从零部署、启动、排障，以及一次完整运营（迎新晚会）的操作示例。
>
> - 环境变量清单与逐项说明见 [CONFIGURATION.md](./CONFIGURATION.md)
> - 指令用法见 [COMMANDS.md](./COMMANDS.md)
> - 真机验收清单见 [ACCEPTANCE.md](./ACCEPTANCE.md)

## 包含内容

- 快速开始
- 迎新晚会

---

## 快速开始

```bash
corepack enable
pnpm install
cp .env.example .env
# 然后按需填写 .env（默认使用 SQLite，无需配置数据库）
```

默认数据库是 SQLite 文件 `data/qq-group-ops.db`，启动时自动建表，不需要 Docker 或额外的数据库服务。

> **必须在仓库根目录启动**：`.env`、`data/`、`logs/` 都是相对当前工作目录解析的——从别处运行
> 会在那个目录另建一份 `.env`/`data`/`logs`，看起来像「数据丢了」。

如果默认 npm 源不可用，可使用镜像：

```bash
pnpm install --registry=https://registry.npmmirror.com
```

`pnpm dev`、`pnpm start` 会自动读取项目根目录的 `.env`。

`pnpm dev` 会默认使用 `debug` 日志级别，控制台按 `LOG_COLOR=auto` 自动判断是否彩色，并把日志写入 `logs/qq-group-ops.log`。

`pnpm dev`（或先 `pnpm build` 再 `pnpm start` / `node dist/main.js`）启动后：
**填好 QQ 凭据**（`QQ_BOT_APP_ID` / `QQ_BOT_CLIENT_SECRET`）才会连接官方 WebSocket 网关；
**缺凭据时进入 fake 模式**——只加载状态、不连网，打印一条 `fake mode: official WebSocket gateway not started` 后直接退出。
因此「启动是否正常」可以在**不含 `.env` 的临时目录**里冒烟验证（数据与日志会写在该临时目录，不会碰到项目数据）：

```bash
# 冒烟验证：不读仓库 .env、不连官方网关，退出码 0 即启动链路正常
mkdir -p /tmp/qqops-smoke && cd /tmp/qqops-smoke
ADMIN_USER_IDS=10001 node /path/to/qq-group-ops/dist/main.js
```

常用命令：

```bash
pnpm dev         # 本地开发入口（tsx 直接跑源码）
pnpm class:index # 可选：把 data/class.json 转成班级索引（入群审核规则用）
pnpm db:up       # 可选：用 Docker Compose 启动 PostgreSQL
pnpm test        # 运行 Vitest
pnpm typecheck   # TypeScript 类型检查
pnpm build       # 编译到 dist/（tsc -p tsconfig.json）
pnpm start       # 运行编译后的入口（需先 pnpm build）
```

默认使用 SQLite，启动会自动建表并载入全部持久化状态。想切到 PostgreSQL 时，在 `.env` 里设置 `DATABASE_URL=postgres://...` 并执行 `pnpm db:up`；`DATABASE_URL=memory` 则是纯内存模式（重启即丢）。

> **仓库隐私守卫**：`test/privacyGuard.test.ts` 会扫描文档与代码，发现「9-12 位未登记数字」或
> 「openid 形状串」就让测试失败，防止把真实 QQ号 / 群号 / openid 写进示例。
> 该测试**自身不保存任何真实值**（连片段都不存），只做形状判断 + 占位符白名单。
> 想再按精确值兜底，可以在本地运行测试时设置 `PRIVACY_GUARD_IDS=<值1>,<值2>`（**只放本地环境变量，不要提交**）。
> 示例值统一用一眼假的占位符：`10001` / `654321` / `123456789` / `0123456789ABCDEF0123456789ABCDEF`。

## 事件通道：WebSocket 还是 Webhook（§D5）

默认走**官方 WebSocket 长连接**（出站连接，内网/家用宽带的机器都能跑，不需要公网入口）。
如果平台侧要求 HTTP 回调，或你的部署环境只提供公网 HTTPS 入站，则切到 **Webhook 模式**：

| | WebSocket（默认） | Webhook |
|---|---|---|
| 公网入口 | 不需要（出站连接） | **必须有**：公网 HTTPS 域名 + 证书（可挂反向代理） |
| 实例数 | 可多实例（官方网关按 session 分流） | **只能单实例**：多实例会重复收到同一事件 |
| 配置 | 零配置 | `EVENT_MODE=webhook` + `WEBHOOK_*` 五项 + 后台填回调地址 |
| 事件顺序 | 网关保证顺序 | 本项目**先回 ACK、再按接收顺序串行处理**（单实例内保序） |

切换步骤：

```bash
# .env
EVENT_MODE=webhook
WEBHOOK_PORT=3000          # 反向代理把 443 转发到这里
WEBHOOK_HOST=127.0.0.1     # 只让本机反代访问；确需直接暴露才写 0.0.0.0
WEBHOOK_PATH=/webhook/qq   # 必须与开放平台后台填写的一致
WEBHOOK_SECRET=            # 留空则复用 QQ_BOT_CLIENT_SECRET
```

1. 反向代理（Nginx / Caddy / frp 等）把 `https://<你的域名>/webhook/qq` 转发到 `127.0.0.1:3000`，
   **不要**改写请求头与请求体（`X-Signature-Ed25519` / `X-Signature-Timestamp` 与原始 body 都要原样透传）；
2. 在开放平台后台把回调地址填成同一个 URL，保存时平台会发一次 `op=13` 校验请求 ——
   日志出现 `webhook url validation answered` 即校验通过；
3. 启动后日志应出现 `webhook gateway listening` 与 `event gateway started {mode:"webhook"}`；
4. **不要再开 WebSocket 通道**（`EVENT_MODE` 二选一），否则同一事件会被处理两次。

排查：

| 现象 | 先看 |
|---|---|
| 平台保存回调地址报「签名校验不通过」 | 见下节「校验不通过怎么试」：九成是密钥填错/密钥格式不符，不是算法 |
| 事件进来但机器人不回 | 日志有没有 `webhook request rejected: bad signature`（401）；有则核对密钥与反代是否改写请求体 |
| 重复处理 | 是不是多实例部署，或同时开了 WebSocket |
| 完全收不到 | 反代是否只暴露了路径前缀、HTTPS 证书是否有效、后台是否保存了回调地址 |

### 校验不通过怎么试（签名算法对齐）

事件回调和 URL 校验握手**用同一对 Ed25519 密钥**，密钥由机器人密钥（Bot Secret）派生。
官方《安全和授权》写得很明确，本项目 `auto`（默认）与它逐字节一致：

```go
seed := botSecret                                    // 密钥原文字节
for len(seed) < ed25519.SeedSize { seed = strings.Repeat(seed, 2) }  // 翻倍到 ≥32 字节
rand := strings.NewReader(seed[:ed25519.SeedSize])    // 取前 32 字节
// 验签：msg = X-Signature-Timestamp + HTTP Body（header 原文 + 原始 body，不是 JSON）
```

`test/webhookSignature.test.ts` 里钉了官方 Demo 的公钥向量（secret 28 位 → seed 32 位 → 32 字节公钥逐字节比对），
算法被改错测试必红。

所以「签名校验不通过」基本不是算法问题，先按这个顺序查：

1. `WEBHOOK_SECRET` / `QQ_BOT_CLIENT_SECRET` 填的是不是 **Bot Secret**（别填成 AppID / Token）；
2. 反向代理有没有改写请求头或请求体 —— `X-Signature-*` 与**原始 body** 必须原样透传；
3. 后台填的回调地址与本服务 `WEBHOOK_PATH` 是否完全一致（含路径与结尾斜杠）。

三条都确认过仍不通过时，把「后台密钥字段的原文形态（多少位、是否含非十六进制字符）」与启动日志里的
`webhook url validation answered` / `webhook request rejected: bad signature` 一起发出来 ——
派生算法与握手签名内容都固定按官方实现（`WEBHOOK_KEY_DERIVATION` / `WEBHOOK_SIGN_CONTENT` 两个逃生舱已删除）。

## 管理 API（`ADMIN_API_ENABLED`）

**默认关闭**；打开后它是**机器人进程内的第二个 Fastify 监听口**（默认 `127.0.0.1:8787`），
与 webhook 端口互不相干，所以「webhook 必须对外」与「管理面只在回环」可以同时成立。
设计与认证见 [ADMIN-API.md](./ADMIN-API.md)，配置项见 [CONFIGURATION.md](./CONFIGURATION.md) 的「管理 API」一节。

```bash
# .env
ADMIN_API_ENABLED=true
ADMIN_API_HOST=127.0.0.1      # 对外由反向代理终结 TLS；不要直接 0.0.0.0
ADMIN_API_PORT=8787
ADMIN_API_SESSION_SECRET=<32 字符以上的随机串>
ADMIN_API_PUBLIC_BASE_URL=https://ops.example.com
ADMIN_API_COOKIE_SECURE=true  # 挂了 TLS 反代才开
```

**不需要第二个进程单元** —— 端口随机器人一起起停。systemd / compose 都不用改，
只要 `.env` 里有上面几项、并且机器人连了数据库（`DATABASE_URL=memory` 时没有令牌表，
监听口会被跳过并记一条 `管理 API 已开启但没有数据库，跳过监听口`）：

```bash
pnpm build && pnpm start            # 机器人起，管理 API 的监听口跟着起
curl -s http://127.0.0.1:8787/healthz   # 健康检查：{"ok":true,"version":…}
```

- 端口被占用只记 `管理 API 监听失败（机器人继续运行）` 并继续跑机器人 —— 管理面是旁路能力，
  不该拖垮收消息；改 `ADMIN_API_PORT` 或先停掉旧进程；
- `node dist/main.js --check`（启动自检）**不占端口**：自检只做初始化。

`pnpm admin:api`（`dist/adminApi/main.js`）是**只读巡检入口**：独立进程、只读仓储，
适合「不想重启机器人、只想看状态 / 审计」的场景；它不装配写端点（审批 / 规则 / 活动 / 导出
一律回 503），写操作一律走机器人进程内那个监听口。

### 重启、以及两个入口并存

管理 API 有**两个入口**，都用 `ADMIN_API_HOST:ADMIN_API_PORT`（默认 `127.0.0.1:8787`）：

| | 机器人进程内的监听口 | `pnpm admin:api` 只读巡检 |
|---|---|---|
| 谁能起 | 机器人（`ADMIN_API_ENABLED=true`） | 手工执行 |
| 读端点 | ✅ | ✅（直读仓储） |
| 写端点 | ✅ | ❌ 一律 503 |
| 会话 | 内存（**重启即全部失效**） | 内存（与机器人互不影响） |
| `/restart` 时 | **跟着机器人一起关掉再重建**，期间短暂不可用（几秒，前端表现为请求失败而不是 401） | 不受影响（除非你自己停它） |

- **同一个端口只能有一个入口**：两个都起时，后起的那个必然 `EADDRINUSE`。
  - 巡检先起 → 机器人侧只记一条 `管理 API 监听失败（机器人继续运行）` 并继续收消息。
    此时端口上服务的是**只读**的巡检进程：**写端点会 503**（日志里会写明这一点）；
  - 机器人先起 → 巡检进程打印同样的提示后退出（退出码 1）。
  - 想长期共存就换端口（例如只读巡检用 `ADMIN_API_PORT=8788`）。
- 自检（`node dist/main.js --check`，`/restart` 前后各跑一次）**不占管理端口**：
  自检在起监听口之前就返回了，所以不会和旧 / 新进程抢 8787。

反向代理**最省心的做法就是把整个域名转给 8787**：管理 API 自己会托管管理前台
（`web/dist`，见下一节），所以不需要在 nginx 里写 `root` / `try_files`：

```nginx
server {
  listen 443 ssl;
  server_name ops.example.com;
  # ssl_certificate / ssl_certificate_key ...

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

只想把 **API 反代出去**（页面交给别的静态托管 / 只想跑 `pnpm admin:api` 巡检）时，
收敛到三个前缀即可：

```nginx
location ~ ^/(api|auth|healthz) {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

> ⚠️ 不要把**只有三个前缀**的那个片段和「页面也交给 nginx」混着用而不配 `root`：
> 那样 `/login` 会落到默认站点（或 404），页面打不开。两种配法二选一，见下一节。

## 管理前台（E2-e）

管理后台是 `web/` 里的 Vue 工程（独立依赖）。**CD 会把它一起发布**：发版时门禁会
`pnpm --dir web install` + `pnpm web:build`，并把 `web/dist` 跟后端产物一起上传到应用目录，
所以服务器上**不需要**装前端依赖、也不需要手工 build / 拷贝。

### 交付方式 A（默认，推荐）：机器人自己托管

管理 API 默认就会托管 `web/dist`（`ADMIN_API_WEB_DIR`，默认值就是它）：`/`、`/login`、
`/pending` 等页面由它提供，带扩展名的请求按文件给、导航请求回退 `index.html`（SPA）。

- 反向代理只需要 `location / { proxy_pass http://127.0.0.1:8787; }`（上面第一段）；
- 「整个域名反代到 8787」于是完全够用，**不用**在 nginx 里配 `root`；
- 目录不存在（没构建 / 没部署前端）时自动跳过：接口照常，页面回 404 并提示；
- 想关掉（改回 nginx 托管）就设 `ADMIN_API_WEB_DIR=`（空值）。

### 交付方式 B：nginx 托管静态资源

不想让机器人发静态文件时，把 `ADMIN_API_WEB_DIR` 设成空值，改由 nginx 托管：

```nginx
server {
  listen 443 ssl;
  server_name ops.example.com;
  # ssl_certificate / ssl_certificate_key ...

  # SPA：找不到的路径一律回 index.html（前端路由自己处理）
  root /opt/qq-group-ops/web/dist;
  location / {
    try_files $uri $uri/ /index.html;
  }

  # 管理 API（机器人进程内的回环监听口）：同源反代，绕开 CORS 与 SameSite 限制
  location ~ ^/(api|auth|healthz) {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

同源是关键 —— 会话 cookie 是 `SameSite=Strict` 的，跨源会把登录态吃掉（两种方式都同源）。

- `.env` 里 `ADMIN_API_PUBLIC_BASE_URL=https://ops.example.com`（拼登录链接）、
  `ADMIN_API_COOKIE_SECURE=true`（挂了 TLS 才开）；
- **本地开发**不需要 nginx：`pnpm web:dev` 会把上面前缀代理到 `ADMIN_API_PROXY`；
- **只想在本机看一眼构建产物**：`pnpm web:build && pnpm --dir web run preview`（默认 4173，不代理 API）；
- **想手工补一次前端**（例如不想等下次发版）：在本地 `pnpm web:install && pnpm web:build`，
  把 `web/dist` 传到应用目录的同名位置即可（CD 走的是同一套命令、同一份产物）。

排障速查：

| 现象 | 原因 / 处理 |
|---|---|
| `/healthz` 连不上 | `ADMIN_API_ENABLED` 没开、端口被占用、或纯内存模式（看启动日志 `admin api listening (in-process)` / `管理 API 监听失败`） |
| 登录 401 `invalid_token` | 令牌已用过 / 超过 10 分钟 TTL / 复制时漏字符 —— 重新 `/admin login` 或 `pnpm admin:token --user=<openid>` |
| 登录 403 `csrf` | 页面之外的调用忘了带 `X-Admin-Request: 1` |
| 写端点 503 `unavailable` | 连到了只读巡检模式（`pnpm admin:api`）的端口；改用机器人进程内的监听口 |
| 写端点 403 `forbidden` | 该操作要的权限不够（审批 / 规则 / 活动要**本群群管理员 130**，全局规则要**平台超管 240**；`/api/audit` 里也有一条 `admin_api:denied`） |
| 只读端点 403 `forbidden` | 只读也有门槛（平台级信息要 240，群级要本群 120）；`/api/pending`、`/api/activities` 对够不着的群是**少返回**而不是 403 |
| 审计 400 `bad_request` | `GET /api/audit` 非平台超管必须带 `?group=<群 ID>` |
| 写端点 409 `conflict` | 这条入群申请已经被别人处理过（群管理后台 / 另一位管理员） |
| 429 `rate_limited` | 兑换端点每分钟 10 次、会话每分钟 `ADMIN_API_RATE_LIMIT_PER_MINUTE`（默认 60） |
| 接口 503 | 连着内存模式（没有数据库），或该数据源未装配 |
| 想立刻踢掉所有人 | 重启机器人（会话只在内存里）或换 `ADMIN_API_SESSION_SECRET` |

## 备份与恢复（SQLite）

默认库是 `data/qq-group-ops.db`（WAL 模式），因此**`.db` / `-wal` / `-shm` 是一套**：
只拷 `.db` 会丢掉还在 WAL 里、尚未 checkpoint 的提交。

**备份**（会话期间也可以做，机器人不必停）：

```bash
systemctl stop qqops           # 想绝对干净就先停服务（可选）
cp data/qq-group-ops.db* /backup/qqops-$(date +%Y%m%d_%H%M%S)/   # 三个文件一起拷
```

- `/migrate` 执行前会**自动**做一次同样的拷贝（同目录、命名 `{原名}_YYYYMMDD_HHMMSS{扩展名}`）；
- PostgreSQL 不做文件备份：迁移前自行 `pg_dump`（结果卡里也会提醒）。

**恢复**（**必须先停服务**，否则在线改文件会把库写坏）：

```bash
systemctl stop qqops
cp /backup/<那个时间点>/qq-group-ops.db data/qq-group-ops.db
cp /backup/<那个时间点>/qq-group-ops.db-wal data/qq-group-ops.db-wal   # 备份里没有就删掉这个目标文件
cp /backup/<那个时间点>/qq-group-ops.db-shm data/qq-group-ops.db-shm
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/qq-group-ops.db');console.log(db.prepare('PRAGMA integrity_check').get());db.close()"
systemctl start qqops
```

- 打开备份检查前先把它**单独放到一个干净目录**（身边没有 `-wal` 才是「只要 .db」的现场），
  避免误以为数据都在；
- `integrity_check` 要回 `ok`；再抽查关键表（`SELECT COUNT(*) FROM join_requests` 之类）与备份时刻对得上；
- 这套「备份 → 破坏 → 恢复 → 校验」的流程有**本机演练用例**照着跑：
  `node node_modules/vitest/vitest.mjs run --configLoader runner test/dbBackup.test.ts`
  （覆盖热库、WAL 里的未落盘提交、只拷 `.db` 会丢数据这三种情形）。真机演练（D8-b）
  就是把同一条流程在被托管的库上再走一遍。

## 配置搬家：`.env` → 系统配置（ADR-0066）

0.29.0 起，热改项（保留期 / 各种周期 / 部署监测 / 定时发言 / 管理后台会话·令牌·限流）**不再从
`.env` 读**：默认值在代码里、生效值存在库里的 `platform_settings` 表。升级**不需要你做任何事**
（启动时会自动导入，见第 2 步），但想让 `.env` 变干净就按这个顺序来：

1. **先备份**（导入只写库、不碰 `.env`，但删行前留一份总没错）：

   ```bash
   cp data/.env data/.env.bak-$(date +%Y%m%d_%H%M%S)
   ```

2. **升级并正常启动一次**（不是 `--check`），然后看超管私信里的「**配置已从 .env 导入**」卡，
   或 `logs/` 里的 `platform settings imported from env` 一行：

   - 「**已导入 X 项**」= 这些键的值已经写进库，**行为与升级前完全一致**；
   - 「**N 项与内置默认值相同**」= 没写库（值本来就一样，写进去只会多一行无意义的覆盖记录）；
   - 「**已忽略 X 项**」= 库里本来就有覆盖值（比如你在后台改过），`.env` 里那一项**不再有任何影响**；
   - 「⚠️ **N 项没导入**」= 值不合法（老版本会直接拒绝启动，现在降级成「按默认值跑」+ 提醒**一次**）：
     要么改成合法值（下次启动会再导入一次），要么删掉那一行。

3. **确认无误后删掉 `.env` 里那些行**（`.env.example` 末尾注释里列了全部热改项名字），再重启一次 ——
   行为**不应有任何变化**（一切以库为准）。想回到内置默认值：私信 `/config clear <项>`。

4. **以后怎么改**：私信 `/config set <项> <值>`（全局超管、只在私信），或管理后台「配置」页；
   改完**立即生效、不用重启**；面板的「来源」列会写清是「内置默认」「`.env` 默认」还是「已覆盖」。

> **`TZ` 是唯一例外**：展示时区仍然从 `.env` 读启动默认值（日志时间在连库之前就要用），
> 同时也能被 `/config set displayTimezone` 覆盖 —— 这一项**别从 `.env` 里删**。

### 想回退

`.env.bak-*` 就是回退材料：把行贴回去 + `/config clear` 掉这些项（等于删掉库里的覆盖行），
重启后老行为回来。**注意**：只要库里还有覆盖行，`.env` 里的同名键就永远不生效 ——
排查「我改了 `.env` 怎么没用」时，先看 `/config` 面板的「来源」列。

### 自检不写库

`node dist/main.js --check`（部署自检）**不会**执行导入 —— 它是只读演练。所以「自检通过」
不代表这次升级已经完成导入：导入发生在**正常启动**的那份进程里。

## 活动卡片（§B3）

活动卡片是 Markdown + 内嵌按钮，与入群申请共用三级降级（富消息 → 纯文本 → 回执）。
**成员卡**（发到群里的那张）：

```text
## 迎新晚会
材料学院迎新联欢，欢迎参加。

活动群：654321
报名：12 / 50
候补：3 人
截止：03-05 18:00
报名限制：学院 环境 · 年级 22、23
不接受：学院 化学与生命科学学院
相关链接：[报名入口](https://example.com/signup)

请点击下方按钮立即操作：
[ 我要报名 ] [ 取消报名 ]
[ 活动详情 ] [ 报名名单 ]     ← 「报名名单」只有管理者能看到
[ 订阅 开 ]
```

另外三张子卡（按钮太多就不硬塞，按 `docs/CARD-STANDARD.md` 拆开）：

- **配置卡**（`/activity create` 之后自动返回，也可点「配置」）：名额 `10/20/50/不限` + 自定义、
  学院/年级限制子卡、截止（不限/自定义）、`递补 自动/手动`、`报名通知 开/关`、`提醒@全体 开/关`、
  预览卡片、开放报名、取消活动、**绑定群**（列出全部绑定群 + 解绑，新增走 `/activity bind`）；
  需要自由文本的（自定义名额 / 截止）是指令按钮，点击预填指令；
- **管理卡**（点「管理」）：报名 X/Y、候补 N、**待释放名额 M**、学院分布（前 3）、年级分布、截止、
  递补方式；按钮：报名名单、释放名额（**只在有冻结名额时出现**）、重发卡片、开关报名、取消活动、
  统计图片（见下方「可选能力」）；
- **名单卡**：每页 5 人（§卡片规范 v2），默认只列 `序号 姓名（班级）备注`（**不显示学号 / 学院**），
  点「完整信息」才显示；候补区单独列出（最多 10 个 + 「还有 N 人」）；只有管理者可用。

要点：

- 活动可以**绑定多个群**（`activity_groups` 表；创建活动自动绑定创建群，私信里创建时用指定群号）：
  **开放报名**与「重发卡片」会发到**所有绑定群**，操作者的私信回执列出各群的成功 / 失败结果；
  `activities.group_id` 仍是「归属群」（创建地与权限依据）；绑定群全部解绑后回落到归属群；
- 报名限制同时支持**白名单**（`allowColleges` / `allowYears`）与**黑名单**（`denyColleges` / `denyYears`），**黑名单优先**，留空表示不限；
- 年级用**学号前两位**判断（`22`-`26`），学院用 `/profile` 的学院（可由班级库自动带出，匹配时允许「环境」匹配「环境科学与工程学院」）；
- 报名要求 `/profile` 完整；名额满自动进候补；
- **递补默认「手动释放名额」**：有人取消时名额被**冻结**（管理卡显示「待释放名额」），
  管理员点「释放名额」才会「递补候补第一位」或（没有候补时）放回公开池；
  `waitlistPromotion auto` 则取消后立刻自动递补；
- **定时提醒**：管理员用 `/activity set <短码> remindAt MM-DD HH:mm` 设置提醒时间（`clear` 取消），
  到点后在**所有绑定群**各广播一次提醒卡（去重键 `(活动, group:<群ID>, remind)`，重启不重发）；
  扫描间隔由 `ACTIVITY_REMIND_INTERVAL_MS` 控制（默认 1 分钟）；活动已取消 / 已关闭 / 已过截止时只清提醒、不广播。
- **满员广播**：**每次报名后恰好满员**时，以及**管理员把名额调小到「已满」**（名额 ≤ 已报名数 + 冻结名额）时，
  往**所有绑定群**各发一张「活动已满 X/X」卡
  （正文含「后续报名将自动进入候补队列（当前候补 N 人）」与截止时间），**每个群只发一次**
  （复用 `activity_notifications` 去重，键为 `(活动, group:<群ID>, full)`；群消息不占用户私信额度）；
- 活动（含短码/链接/限制/候补/冻结名额/绑定群）与报名记录都持久化，重启不丢；
- 权限：创建/修改/开停/看名单/绑定群需要**群管理员及以上**，活动**发布者本人**也能管理自己发布的活动；普通成员只能报名/取消/看详情/订阅。

### 消息落点（隐私优先）

| 场景 | 群里 | 私信 |
|---|---|---|
| 群内报名成功 / 进候补 | **不发任何消息** | 结果 + 姓名 / 学号 / 班级 / 序号 / 人数 |
| 群内报名未通过 | **不发任何消息** | **具体原因**（资料不全 / 不符合学院年级限制 / 已报名 / 已截止） |
| 群内取消报名 | **不发任何消息** | 回执（manual 模式含「待释放名额 +1」）；被递补者收到「你已递补成功（当前 Y/Z）」 |
| 私信里 `/activity join\|quit` | — | 原地回复（同上，可含完整信息） |
| 私信发送失败（唯一例外） | `<@!申请人>` + 「私信发送失败，请先私聊机器人再试」（**不含任何结果**） | — |
| 发布活动 | 成员卡（发到**所有绑定群**） | 操作者回执（各群发送结果 + 「机器人无法 @全体成员，如需通知全群请手动 @ 一条」+ 重发/关停入口） |
| 满员广播 | 「活动已满 X/X」卡（每个绑定群一次） | — |
| 订阅推送 | 不发 | 给**订阅者**私信活动卡 |
| 活动变更 / 取消 | 不发 | 给**已报名 + 候补**私信 |

排行榜式的「谁报名了」不再进群聊：群内只保留不含隐私的卡片（成员卡、已满卡、发布回执），
个人资料只在私聊出现。

私信失败（没私聊过机器人 / 关闭了「允许主动发送」）只记日志：群里最多回一条**不含结果**的提示，
**绝不**把隐私原因或报名结果降级到群里。

### 新活动订阅与通知额度

- 订阅入口只在**卡片上**：`/notify` 面板的「活动通知 本群 / 全部」开关，或活动卡上的「订阅」按钮
  （老指令 `/activity subscribe` 已删除）→ 该群发布新活动时私信你一张活动卡；
- 通知**只发给订阅者与当事人**，不群发、也**不假装能 @全体成员**（真机实测 5 种写法都不生效）；
- 去重：`activity_notifications` 的 `(活动, 用户, 类型)` 主键 → 同一活动同一类型只打扰一次（重启也不重复）；
- 封顶：每人每天最多 `ACTIVITY_NOTIFY_DAILY_LIMIT` 条（默认 `3`，`0` = 不限制），超限只记日志；
  这是为了不把官方主动私信额度（单用户每天 1000 条、单关系 20 qpm）打满。

### 统计图片与 CSV 导出

管理卡的「统计图片」和名单卡的「导出 CSV」是两个**只对管理者开放**的查看/导出入口：

- **统计图片**（`cb:activity:stats`）：渲染一张 PNG（宽度 720、高度自适应）并发到活动群，
  内容为标题、`报名 X/Y`、`候补 N`、`待释放名额 M`、`截止`、学院分布与年级分布（横向条形 + 人数）；
  操作者随后收到一张「已发送统计图片」卡；
- **导出 CSV**（`cb:activity:export`）：列固定为 `序号,姓名,学号,班级,学院,备注,候补`（候补行最后一列 `候补`），
  以代码块**私信给操作者本人**（群里不回执内容——学号 / 班级 / 学院都属于隐私字段）；
  名单超过单条消息长度上限时不硬塞，改为私信提示用 `/export #短码` 拿完整文件。

这两项都是**可选能力**，装配不上就降级，活动本身照常工作：

| 情况 | 结果 |
|---|---|
| 没装 `@napi-rs/canvas`（可选原生依赖） | 「统计图片」按钮不生成；直接调用回调 → **文字统计卡** |
| 系统没有中文字体、也下载不到字体 | 同上（先试 `ACTIVITY_STATS_FONT_URL`，仍失败就降级） |
| 图片上传 / 发送失败 | 渲染成功也降级为**文字统计卡**（拿到数据比拿到半张图重要） |
| 导出服务未装配 | 按钮不生成；调用回调提示「导出服务未装配」 |

字体策略：**系统优先**（Windows `msyh.ttc`、Linux `NotoSansCJK*` / `wqy-*`、macOS 苹方），
找不到才从 `ACTIVITY_STATS_FONT_URL`（默认 Noto Sans SC 官方发布地址）下载并缓存到
`data/fonts/`（`data/` 已 gitignore，**字体缓存不随包提交**）。容器里想真正出图：

```bash
pnpm add @napi-rs/canvas              # 可选依赖；装不上只会降级，不影响启动
# 也可以指向自建镜像的字体地址（留空 = 只用系统字体）
ACTIVITY_STATS_FONT_URL=https://example.com/NotoSansSC-Regular.otf
```

> 官方群图片上传没有「multipart 直传字节」接口：群聊富媒体上传
> （`POST /v2/groups/{group_id}/files`）只接受 `url` 直传或分片上传合并。本地渲染的 PNG 没有公网 URL，
> 因此走分片（`upload_prepare` → 逐片 `PUT` → `upload_part_finish` → 带 `upload_id` 合并），
> 拿到 `file_info` 后用 `msg_type: 7` 发送。端点可在 `QQOfficialEndpoints` 覆盖。

## 只跑一份进程（单实例闸，ADR-0064）

同一个应用目录**只能有一份** `node dist/main.js`。两份同时在跑的后果不是「多发一条通知」这么轻：
各自连网关、各跑一套周期任务（定时发言会重复发言）、同时写同一个 SQLite，
而且每次部署会各发一张「发现新版本」、各重启一次（自我维持成两份）。

```bash
# 只应该有**一行**输出
ps -ef | grep "dist/main.js" | grep -v grep
```

- 从 0.27.1 起，启动时会抢 `data/bot-instance.lock`：锁里的 pid 还活着且不是自己 →
  **拒绝启动**（日志记 `duplicate bot instance detected: refusing to start`，
  并留证 `data/duplicate-instance.json`，退出码 1）。持有者已经退出则自动接管。
- **只留一个「拉起者」**：用 pm2 / systemd / docker `restart:always` 时不要再依赖自我重启
  （`/restart` 仍能重载新版本，但守护进程也会拉起一份 —— 那一份会被单实例闸拒绝）。
- 发现有两份时的处理：确认部署已完成（FTP 传完），然后

```bash
cd /www/wwwroot/qqbot
pkill -f "dist/main.js"          # 两份都停
sleep 2
ps -ef | grep "dist/main.js" | grep -v grep     # 应无输出
# 用你平时的启动方式拉起**一份**（例如 nohup node dist/main.js >> logs/stdout.log 2>&1 &）
ps -ef | grep "dist/main.js" | grep -v grep     # 应只有一行
```

## 手工救急：包化部署（ADR-0065）

从这一版起 CD 不再逐文件同步，而是**两个文件、两段上传**：

| 文件 | 谁写 | 作用 |
|---|---|---|
| `incoming/deploy-<版本>.tgz` | CD 第一段 | 产物包：`dist/` + `web/dist/` + `scripts/` + `pnpm-lock.yaml` + `.env.example`，内含 `dist/build-info.json` |
| `incoming/deploy-<版本>.json` | CD 第二段（**最后落地**） | 投递标记：版本 / commit / **sha256** / **dist 指纹** / 构建时间。「它到了 = 传完了」 |

机器人每个扫描周期扫一次 `incoming/`，看到标记才动手：
**sha256 校验**（防半传）→ 解到 `data/incoming/<版本>/` → 用 `distFingerprint()` 与包内
`build-info.json` **自证** → **整目录替换** `dist/` `web/dist/` `scripts/`
（`data/`、`.env`、`logs/` **绝不碰**）→ 走既有「自检 → respawn」重启。
成功写 `data/deploy-state.json` 与 `data/deploy-receipt.json`，把包归档到 `data/packages/`
（**只留最近 3 个**），并作废 FTP 同步状态。失败则坏包改名 `*.failed-<ts>` 留证 + 私信超管，
**运行中的机器人不受影响**。

### 怎么手动应用一个包（CD 挂了 / 只想手工上一次）

```bash
cd /www/wwwroot/qqbot

# ① 把两个文件放好（版本号换成你要上的那个；`incoming/` 与 dist/ 同级）
ls -l incoming/deploy-<版本>.tgz incoming/deploy-<版本>.json   # 都应该有

# ② 先自己校验一遍 sha256（与标记里的 sha256 对上才继续）
sha256sum incoming/deploy-<版本>.tgz
grep -o '"sha256":[^,]*' incoming/deploy-<版本>.json

# ③ 剩下的交给机器人：它下个扫描周期（SCAN_INTERVAL_MS，默认 1 分钟）就会应用。
#    想立刻看结果：
tail -f logs/qq-group-ops.log | grep -i deploy
cat data/deploy-receipt.json          # 最近一次部署结果（成功/失败与原话原因）
cat data/deploy-state.json            # 当前生效 / 上一个版本
```

### 怎么手动回滚

**首选**：机器人 `/status proc` 卡片上的「回滚上一版」按钮，或管理后台「状态」页的同名按钮
（都是「重新应用 `data/packages/` 里的上一个包」，同一套校验）。手工等价操作：

```bash
cd /www/wwwroot/qqbot
cat data/deploy-state.json            # 看 previousVersion / previousSha
ls -l data/packages/                  # 上一个包还在不在（只保留最近 3 个）
# 把归档里的包当成新投递重新放一份（sha256 用归档包的实算值）
cp data/packages/deploy-<上一个版本>.tgz incoming/
sha256sum incoming/deploy-<上一个版本>.tgz
# 按上面的「手动应用」写一份 deploy-<上一个版本>.json 放进去（sha256 用刚算的值，
# distFingerprint 用 `node -p "require('./data/incoming/<上一个版本>/dist/build-info.json').distFingerprint"`）
# 没有现成的 build-info 就从归档里解出来看一眼：
tar -xzf data/packages/deploy-<上一个版本>.tgz -C /tmp/peek dist/build-info.json && cat /tmp/peek/dist/build-info.json
```

> 回滚**不是**「把文件换回去就完事」：它同样要过 sha / 指纹自证，所以拿不准就点按钮 ——
> 手工拼标记写错一个字段只会被拒绝（并私信说明原因），不会装上半个版本。

### 怎么清理 FTP 同步状态（上传被跳过时）

`ftp-sync-state-code.json` / `ftp-sync-state-marker.json` 是 FTP Action 记「上次传过什么」的
状态文件 —— **正常包化流程已经不需要它**（每轮只传 2 个文件 = 每次全量）。
机器人自己动过 `dist/`（自解包 / 回滚）之后会**主动删掉**它们，让下一轮 CD 全量。
手工清（例如怀疑上传被跳过、版本号升了代码没升）：

```bash
cd /www/wwwroot/qqbot
ls -l ftp-sync-state-*.json 2>/dev/null      # 有就说明还在
rm -f ftp-sync-state-code.json ftp-sync-state-marker.json
# 下一轮 CD 会因此全量上传（一次性，不是每次都全量）
```

### 三连 `grep -c`：确认 dist 真的是新的

「版本号变了」不代表「代码真的上来了」（0.27.3 真机事故：`package.json` 是新版、
`dist/adminApi/backend.js` 却是旧的）。**部署后**在服务器上跑这三条，三条都必须 ≥ 1：

```bash
cd /www/wwwroot/qqbot
grep -c boundGroupIds dist/adminApi/backend.js          # 后台群列表用绑定表当权威来源
grep -c 定时发言总开关 dist/services/platformSettings.js   # 定时发言总开关
grep -c isStartupCheck dist/main.js                     # 自检进程不参与单实例锁
```

- 任何一条是 `0` → 这次上传/替换**没真的生效**；先看 `data/deploy-receipt.json` 与日志，
  再按上面的「清理 FTP 同步状态」处理，然后重新发布。
- 另外看一眼 `dist/build-info.json` 与 `/healthz` 的 `distFingerprint` 是否一致 ——
  不一致说明「进程跑的产物」与「磁盘上的产物」不是同一份（等重启或重新部署）。

### 现场自证：跑的是哪份产物

```bash
curl -s http://127.0.0.1:8787/healthz | tee /dev/stderr | head -c 400
# { "ok": true, "version": "...", "distFingerprint": "...", "buildInfoCommit": "...",
#   "appliedVersion": "...", "rollbackVersion": "..." }
```

或者机器人里 `/status proc`（仅平台超管）：「构建自证」行给指纹 / commit / 构建时间，
「磁盘产物」行告诉你指纹是否与运行中的一致。
