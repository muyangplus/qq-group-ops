# 管理 API 与管理后台（E1 / E2）设计

> 阶段目标见 [ROADMAP.md](./ROADMAP.md)：**批次4 · Phase 2** —— 管理 API（Fastify + 登录鉴权 + 限流 + 最小权限）
> 与 Vue 3 管理后台。本文只定**怎么做**（方案对比 + 分阶段计划），进度与勾选在 [TODO.md](../TODO.md) §2 的 E1 / E2。
>
> 现状前提：机器人本身是 Fastify（webhook 通道，见 ADR-0049），权限模型已经是**群内 / 平台两轴**（ADR-0050），
> 审计写入 `audit_log`（平台级动作 `group_id = ""`）。管理面必须复用这三样，不新造一套。

## 1. 认证方案对比

| 维度 | A 账号密码 + 会话 cookie | B openid 白名单 + 一次性令牌 | C 不做登录（网络隔离） |
|---|---|---|---|
| 实现量 | 中：scrypt 哈希 + 会话存储 + CSRF + 过期 / 登出 | 小：白名单 + 令牌签发与校验 | 最小：零代码 |
| 依赖官方新能力 | 无 | 无（**不做 OAuth**，手工填自己的 openid） | 无 |
| 安全强度 | 中：口令泄露是主要风险，可叠加限流 / 锁定 / 2FA | 中高：短时令牌、不存口令 | 低：端口一旦暴露等于全开 |
| 多人 / 多设备 | 好：每人每设备独立会话 | 一般：每人自己换令牌，手工操作多 | 差 |
| 与现有权限模型结合 | **好**：账号映射到 `userId` → 直接复用两轴判定 | 好：openid 本身就是 `userId` | 差：没有身份，只能按最高权限跑，做不了最小权限 |
| 审计归属 | 好：`actor_id` 就是登录账号对应的人 | 好 | 差：只能记 IP |
| 运维成本 | 需要 `.env` 配账号与会话密钥 | 需要为每个管理员手工发令牌 | 需要反代 + 内网限制 |
| 失效手段 | 改密码 / 撤销会话即全失效 | 删白名单 / 令牌 | 断网 |

**选 B2：机器人私信一次性令牌 + 会话 cookie**（2026-09-29 改定）。理由：

- **少一类凭据**：服务器上不再存口令哈希，只存会话密钥；令牌本身**只存 `sha256`**，库泄露也拿不到可用令牌；
- **身份天然正确**：令牌里带的就是 openid（= 机器人 `userId`），权限直接复用现有两轴模型（ADR-0050），`actor_id` 也不用手工映射；
- **加人 / 移除复用现有能力**：默认门槛 = 平台超管（240），撤销超管即失去签发资格，不用改 `.env` 重启；
- **爆破面小**：令牌是 32 字节随机串、一次性、默认 10 分钟 TTL；不需要"登录失败锁定"那套（只对兑换端点做 IP 限流）。

流程：

```text
① 管理员私信机器人 /admin login   →  ② 机器人签发一次性令牌（私信里给链接 + 可粘贴的令牌）
                                      ↓
③ 浏览器打开 <ADMIN_API_PUBLIC_BASE_URL>/login?token=… （QQ 里链接点不动就手工粘贴令牌）
                                      ↓
④ POST /auth/token 兑换 → 校验（未用过 + 未过期 + 在有效期内）→ 标记已用 → 种会话 cookie
```

**令牌必须落库，不能只放内存**——这是 B2 的关键实现细节：签发方是**机器人进程**或 `pnpm admin:token`
（CLI），兑换方是**独立的管理 API 进程**，三者是不同进程，内存里互相看不见；
落库顺带解决了「重启后链接还有效」和「跨进程一次性」这两件事。
表：`admin_api_tokens(token_hash PK, user_id, created_at, expires_at, used_at)`，
`token_hash = sha256(明文令牌)`，兑换时 `used_at IS NULL` 才通过并立刻写下 `used_at`（一次性）。

**应急入口（机器人挂了 / 私信收不到时）**：`pnpm admin:token --user=<openid|#短码>` 直接落一行令牌并把
链接/令牌打到终端——能登服务器本来就是这个后台的最高信任级别，所以这条既简单又不降低安全性。

写操作的安全底座（B2 同样需要）：会话 cookie 用 `HttpOnly + SameSite=Strict`（配了 TLS 再加 `Secure`），
所有写操作校验自定义头（`X-Admin-Request: 1`）防 CSRF，CORS 默认关闭（同源部署），
兑换端点按 IP 限流，登录 / 兑换 / 权限拒绝都写审计。

## 2. 运行形态对比

| 维度 | 独立入口 + 默认绑本机 | 复用机器人进程与端口 |
|---|---|---|
| 暴露面 | 小：默认不出网，要暴露必须显式改 `ADMIN_API_HOST` | 大：webhook 端口本就对外，管理面跟着一起暴露 |
| 隔离性 | 好：管理面崩溃 / 重启不影响网关与定时任务 | 差：共享事件循环与数据库连接池，一个慢查询拖垮收消息 |
| 部署复杂度 | 中：多一个进程单元（systemd / compose service），CD 可选加一步 | 小：不用新单元 |
| 权限最小化 | 好：可以只给它只读账号 / 只读连接 | 差：同进程天然拿到全部能力 |
| 资源 | 多一份进程（几十 MB） | 省 |
| 适用 | 生产（推荐） | 本机玩具 / 临时排查 |

**选「同进程 + 独立回环监听口」**（2026-09-29 修订，取代原先的"独立进程"决定）：

- 管理 API 是**机器人进程内的第二个 Fastify 实例**，默认 `ADMIN_API_HOST=127.0.0.1`、`ADMIN_API_PORT=8787`，
  由 `ADMIN_API_ENABLED` 控制是否启动；**不复用 webhook 那个口**，所以
  「webhook 端口必须对外」与「管理面只在回环」这两件事可以同时成立；
- **一份内存态、一份 tick**：管理进程与机器人共用同一个 `GroupConfigStore` / `ActivityService` / 通知订阅 /
  短码表，写端点直接调领域服务（与指令层同一入口），不存在"两份缓存互相看不见"或"两个 tick 重复清理"的问题；
- 换来的代价只有一条：管理面与机器人同进程，管理面出问题会拖累机器人。缓解：只绑回环、出口交反代、
  已有的限流 + 审计 + CSRF，且管理代码路径只有"读仓储 / 调服务"，没有长任务。

为什么不再选"独立进程"（原决定）：独立进程若只读仓储，写端点就得把动作丢回机器人执行（多一张动作表 + 轮询延迟）；
若让独立进程也建一套服务图，就会出现**两份内存态** —— 机器人在群里改了规则、管理面那份还是旧的，
反过来的写也可能被最后一次写入覆盖，还得人为指定 tick 归谁跑。这两种代价都比"同进程"高。

`pnpm admin:api`（`src/adminApi/main.ts`）**保留但降级为只读巡检模式**：不注册写端点，
用于"不想重启机器人、只想看状态 / 审计"的场景；写操作一律走机器人进程里的那个监听口。

## 3. 分阶段计划（与 TODO 的 E1-a…E2-e 一一对应）

> **进度（2026-09-29）**：E1-a 配置 / 会话 / 限流 / 令牌表与仓储 / HTTP 层 ✅；
> E1-b 身份映射 + `/admin login` + `pnpm admin:token` + `/auth/me` 权限画像 ✅；
> E1-c 六个只读端点 ✅；E1-e 机器 token ✅；E1-f 可观测与运维文档 ✅；
> **E1-d 写端点 + 进程模型调整进行中**（同进程第二回环监听口 → 四个写端点）；
> E2-a…e 未开始。逐项勾选见 [../TODO.md](../TODO.md) §2 的 E1 / E2。

### E1-a 骨架与安全底座（P0）

1. `src/adminApi/`：`main.ts`（进程入口）+ `server.ts`（Fastify 装配）+ `config.ts` / `session.ts` /
   `rateLimit.ts` / `tokens.ts`（令牌仓储）；`/healthz` 不鉴权，只回 `{ ok, version, uptime }`
   （不暴露群 / 用户信息）；
2. 配置项进 `.env.example`：`ADMIN_API_ENABLED` / `ADMIN_API_HOST` / `ADMIN_API_PORT` /
   `ADMIN_API_SESSION_SECRET` / `ADMIN_API_COOKIE_SECURE` / `ADMIN_API_PUBLIC_BASE_URL` /
   `ADMIN_API_TOKEN_TTL_MINUTES` / `ADMIN_API_ALLOWED_OPENIDS`（可选）/
   `ADMIN_API_RATE_LIMIT_PER_MINUTE`；**这些属于核心安全项，不进 `/config` 热改**；
3. 令牌表 `admin_api_tokens(token_hash PK, user_id, created_at, expires_at, used_at)` + 仓储：
   `issue(userId, ttl)` 只把明文令牌返给调用方、库里只存 `sha256`；`redeem(token)` 一次性
   （校验未用过 + 未过期 → 立刻写 `used_at`）；顺手清过期行；
4. 兑换与登出：`POST /auth/token { token }`（校验 + 种会话 cookie）、`POST /auth/logout`、
   `GET /auth/me`（返回 userId 与到期时间）；会话默认 12 小时滑动过期；
5. 限流：兑换端点按 IP 滑窗（默认 10 次/分钟），会话级全站限流默认 60 req/min；
6. CSRF：写操作必须带 `X-Admin-Request: 1`；CORS 默认关闭；
7. 审计：令牌签发 / 兑换（成功与失败）、权限拒绝、每个写操作都写 `audit_log`
   （平台级 `group_id = ""`，`actor_id` = openid）。

### E1-b 身份与权限映射（P0）

8. 身份就是 openid：令牌兑换后拿到的 `userId` 直接进 `PermissionService` 两轴判定；签发端门槛 =
   平台超管（240），可用 `ADMIN_API_ALLOWED_OPENIDS` 进一步收窄；
9. 每个路由声明所需门槛（例：`GET /api/audit` 需某群 130 或平台 240），统一前置钩子判定，
   失败返回 403 并写明原因，**同时写审计**；
10. 机器人侧：`/admin login`（默认仅全局超管、只私信）→ 签发一次性令牌 → 私信链接与令牌；
    `PUBLIC_BASE_URL` 没配时只给令牌（浏览器里手工粘贴）；
11. 应急 CLI：`pnpm admin:token --user=<openid|#短码> [--ttl=10]` —— 直接落一行令牌并打印链接/令牌，
    用于机器人不可用时（能登服务器 = 后台的最高信任级别）。

### E1-c 只读端点（P1）

10. `GET /api/status`：版本 / 数据库类型与路径 / 写队列计数 / 模块健康（复用 `/status proc` 的数据源）；
11. `GET /api/pending`（分页 / 按群过滤）+ `GET /api/pending/:code`；
12. `GET /api/audit`：按群 / 操作人 / 动作 / 时间范围过滤 + 分页；
13. `GET /api/rules?group=`：生效值 + 覆盖字段（全局规则需平台 240）；
14. `GET /api/activities` + `GET /api/activities/:code`（名单默认脱敏：不含学号，`?full=1` 需群 130 且写审计）；
15. `GET /api/notify/topics`：话题门槛与各群订阅计数。

### E1-d 写端点（P2，与 E2 一起做）

16. `POST /api/pending/:code/approve`、`POST /api/pending/:code/reject { reason }`（复用 `JoinApprovalService`）；
17. `PUT /api/rules { group, field, value }`（复用 `parseRuleSetting`，非法值整体拒绝）；
18. `POST /api/activities/:code/open|close|cancel`；`GET /api/activities/:code/export.csv`（脱敏 + 审计）。

### E1-e 机器调用的 token（P2）

19. **机器调用 token**（与一次性登录令牌分开，长时有效、按 scope 限定）：`ADMIN_API_TOKENS`
    （`token:scope`，如 `read` / `read:pending`，可配过期），`Authorization: Bearer`，
    用 `crypto.timingSafeEqual` 比较，日志里只打 token 前缀。

### E1-f 可观测性与运维（P1）

20. 请求日志：结构化一行（路由 / 状态 / 耗时 / actor / requestId），**不打凭据与 cookie**；
21. `/status proc` 增加「管理 API：启用 / 监听地址 / 当前会话数」；
22. 部署文档：systemd 与 docker compose 两种单元示例，写进 [OPERATIONS.md](./OPERATIONS.md) / [CD.md](./CD.md)。

**E1 退出条件**：未登录访问任何 `/api/*` → 401；越权 → 403 且有审计；连续失败登录被锁定；
写操作全部能在 `/audit` 查到（actor 是登录账号）；`ADMIN_API_ENABLED=false` 时完全不监听端口。

### E2-a…E2-e 管理后台（P3）

23. **E2-a 脚手架**：`web/`（Vite + Vue 3 + TS + vue-router + pinia），`pnpm web:dev` / `pnpm web:build`；
    开发期 vite proxy 到管理 API；产物 `web/dist` 不进 `dist/`（CD 默认不发）；
24. **E2-b 登录与会话**：登录页 + `GET /auth/me` 保持会话，401 自动跳登录；
25. **E2-c 页面**：状态看板 / 待审批（通过 · 拒绝 + 二次确认）/ 审计查询（过滤 + 分页）/ 规则编辑（字段级，提交前给 diff）/
    活动列表与开关；
26. **E2-d 权限呈现**：按登录账号的两轴权限隐藏或禁用入口（**服务端仍然强校验**，前端只做体验）；
27. **E2-e 交付**：管理 API 静态托管 `web/dist`（同源，省掉 CORS）或独立 nginx；CD 加一步（默认不发）。

**E2 退出条件**：能在后台完成一次入群审批、改一个规则字段、并查到对应的审计记录；
所有入口在权限不足时不可用（且直接调 API 也会被拒）。

## 4. 明确不做（能力边界）

- **不做账号密码登录**：改用私信一次性令牌（B2），服务器上不存任何口令哈希；
  机器人不可用时用 `pnpm admin:token` 应急（见 §1）；
- **不做 OAuth 扫码登录**：官方是否开放该能力未取证（见真机清单 R3/R18），且 B2 已覆盖同一体验；
- **不做多租户 / 按群隔离的独立账号体系**：权限复用现有两轴模型，账号只是「登录凭据」；
- **管理 API 不暴露消息原文**：`RAW_MESSAGE_RETENTION_DAYS` 的短期原文只走机器人卡片，API 一律不返回；
- **不在管理面提供个人数据删除**：那属于 `/data`（见 COMMANDS.md「个人数据删除 / 导出」），
  平台级动作不在浏览器里做，避免误点。
