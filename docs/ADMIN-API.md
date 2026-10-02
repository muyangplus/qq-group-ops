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

**令牌必须落库，不能只放内存**——这是 B2 的关键实现细节：签发方是**机器人进程**
（`/admin login`）或 `pnpm admin:token`（CLI），兑换方是**管理 API**
（E1-d 起通常就是机器人进程内的那个回环监听口，也可以是只读巡检进程），
内存里互相看不见；落库顺带解决了「重启后链接还有效」和「跨进程一次性」这两件事。
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

**落地形态（E1-d）**：

| 入口 | 进程 | 读端点 | 写端点 | 用在什么时候 |
|---|---|---|---|---|
| 机器人内监听口（`ADMIN_API_ENABLED=true`） | 机器人进程，`127.0.0.1:8787` | ✅ 走内存态服务 | ✅ 走领域服务 | 默认；写操作只有这里能做 |
| `pnpm admin:api` | 独立进程，默认同一个回环地址 | ✅ 直读仓储（没有内存态） | ❌ 回 503 | 机器人不方便重启时的巡检 |

两条都要求数据库：`DATABASE_URL=memory` 时没有令牌表（签不出、兑不了），机器人侧会跳过监听口
并记一条日志。监听口随机器人一起起停，**不需要第二个 systemd / compose 单元**（见
[OPERATIONS.md](./OPERATIONS.md)）；端口被占只记错误、不影响机器人收消息。

- **`/restart`（与部署监测的自动重启）走同一条路**：管理监听口在 `shutdown()` 里**先于关库**被关掉，
  新进程起来时重新 bind —— 所以重启期间管理 API 有几秒不可用，且**所有会话失效**（会话只存在内存里）。
- **两个入口不能共用端口**：后起的那个必然 `EADDRINUSE`。巡检先占则机器人侧降级为「只剩只读巡检」
  （**写端点 503**，日志会写明），机器人先占则巡检进程直接退出；要长期共存请给巡检换 `ADMIN_API_PORT`。

## 3. 分阶段计划（与 TODO 的 E1-a…E2-e 一一对应）

> **进度（2026-10-02）**：E1-a 配置 / 会话 / 限流 / 令牌表与仓储 / HTTP 层 ✅；
> E1-b 身份映射 + `/admin login` + `pnpm admin:token` + `/auth/me` 权限画像 ✅；
> E1-c 六个只读端点 ✅；E1-d 进程模型（同进程第二回环监听口）+ 四个写端点 ✅；
> E1-e 机器 token ✅；E1-f 可观测与运维文档 ✅；**E1-g 只读端点的逐路由门槛 ✅（E1 收口）**；
> **E2-a 前台脚手架 ✅**（`web/`：Vite + Vue 3 + TS + vue-router + pinia，独立依赖）；
> **E2-b 登录与会话保持 ✅**；**E2-c 五个页面 ✅**（状态 / 待审批 / 审计 / 规则 / 活动）；
> **E2-d 权限呈现 ✅**（前端按 `/auth/me` 隐藏或禁用入口，服务端仍强校验）；
> **E2-e 交付 ✅**（nginx 同源托管 `web/dist` + 反代三个前缀，片段见
> [OPERATIONS.md](./OPERATIONS.md)「管理前台」）。E2 收口；逐项勾选见 [../TODO.md](../TODO.md) §2。

### E1-a 骨架与安全底座（P0）

1. `src/adminApi/`：`host.ts`（同进程回环监听口，E1-d）+ `backend.ts`（接到真实服务图的读 + 写后端，
   E1-d）+ `server.ts`（Fastify 装配）+ `main.ts`（只读巡检进程入口）+ `config.ts` / `session.ts` /
   `rateLimit.ts` / `errors.ts` / `db/adminTokenRepository.ts`（令牌表仓储）；
   `/healthz` 不鉴权，只回 `{ ok, version, uptime }`（不暴露群 / 用户信息）；
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
   失败返回 403 并写明原因，**同时写审计** —— 只读端点的最终口径落在 **E1-g**（下面），
   写端点由领域层（`backend.ts`）判定，两者都写 `admin_api:denied`；
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

### E1-d 写端点与进程模型（P2，与 E2 一起做）

16. `POST /api/pending/:requestId/approve`、`POST /api/pending/:requestId/reject { reason }`
    —— 复用 `JoinApprovalService`（先官方接口、后本地状态）；路径参数同时接受完整 `request_id`
    与 `#申请短码`；申请不存在 → 404，已被别人处理 → 409，越权 → 403（三者都写审计）；
17. `PUT /api/rules { group, field, value }` —— 复用 `parseRuleSetting`，非法值整体拒绝（400）、
    不留半套状态；`group = __default__` 写全局规则（要平台超管 240），其余要本群群管理员 130；
    读端点 `GET /api/rules` 额外给了合并全局默认后的 `effective`（只读巡检模式没有内存态，不提供）；
18. `POST /api/activities/:code/open|close|cancel`（`ActivityService`；创建 / 绑定见 **E1-k**）；
    `GET /api/activities/:code/export.csv` **默认脱敏**（清空学号 / 班级 / 学院），
    `?full=1` 才带隐私列 —— 两种都要求本群 130 且都写审计，响应带 UTF-8 BOM 便于 Excel 直开；
19. **进程模型**：管理 API 作为机器人进程内的第二个 Fastify 监听口（`src/adminApi/host.ts`），
    读写都与指令层共用同一份服务图（`src/adminApi/backend.ts`：审批 / 规则 / 活动都调领域服务，
    审计读 `auditLog.all()`）；`pnpm admin:api` 降级为只读巡检。

权限判据与指令层**同一口径**（不新造一套）：审批 / 活动 / 群规则要本群 130，全局规则要平台 240；
越权与「值不合法」都会先写一条 `admin_api:denied` / `admin_api:rule_update`（`status = rejected`）
再回错，便于事后在 `/api/audit` 里区分「谁试过但没成功」。

### E1-e 机器调用的 token（P2）

20. **机器调用 token**（与一次性登录令牌分开，长时有效、按 scope 限定）：`ADMIN_API_TOKENS`
    （`token:scope`，如 `read` / `read:pending`，可配过期），`Authorization: Bearer`，
    用 `crypto.timingSafeEqual` 比较，日志里只打 token 前缀。
    机器令牌可以走写端点（要 `write` scope），审计 actor 记 `machine:<前 8 位>`，**完整令牌不进日志 / 审计**。

### E1-f 可观测性与运维（P1）

21. 请求日志：结构化一行（路由 / 状态 / 耗时 / actor / requestId），**不打凭据与 cookie**；
22. **管理 API 的「启用 / 监听地址 / 当前会话数」**：不在 `/status proc`（那是机器人在群里能看到的诊断），
    而是分散在更合适的三个地方 —— 启用与地址看启动日志 `admin api listening (in-process)` 与
    `/admin status`；会话数看 `GET /api/status` 的 `sessions`（只有登录后能读到）。写进运维文档；
23. 部署文档：[OPERATIONS.md](./OPERATIONS.md) 的「管理 API」一节（同进程起停 + 只读巡检 + 排障速查）。

**E1 退出条件**：未登录访问任何 `/api/*` → 401；越权 → 403 且有审计；
写操作全部能在 `/api/audit` 查到（actor 是登录账号 / 机器令牌前缀）；`ADMIN_API_ENABLED=false` 时完全不监听端口。

### E1-i 只读补齐：处罚 / 黑名单 / 申诉 / 投递 / 运维（P1，0.24.2 起）

> 目标：**先把「看得清」闭环**（见 [ADMIN-BACKEND.md](./ADMIN-BACKEND.md) §3 P1）。
> 全部只读、全部走与指令层相同的领域服务，因此门槛、排序、字段含义天然一致。

33. `GET /api/punishments?group=&status=&page=&pageSize=`：处罚记录。带**短码**（`#ABC123`）、
    被处罚人 / 执行者的展示信息、动作摘要（用词与卡片一致：`撤回消息 + 禁言 600 秒`）、
    触发原文（未保留则空串）、执行结果与状态（`active` / `released`）。
    门槛：平台超管 240 可**不传 group 看全量**（`listAll()`，指令层没有跨群列表，这条是管理面专用）；
    其余人必须带 `group=` 且本群 ≥120；
34. `GET /api/blacklist?group=`：本群一组 + 全局一组。**全局那组只有平台 240 拿得到**，
    否则 `globalVisible: false`（界面据此说明「权限不够」，而不是显示成「全局没人」）；
    本群列表 ≥120（与 `/blacklist` 一致）；
35. `GET /api/appeals?group=&status=`：申诉队列。每条给申诉人 / 处理人展示信息、关联处罚短码、
    处理备注，以及 `holdRemainingMinutes`（`APPEAL_HOLD_MINUTES` 减已等待分钟）与 `overdue`；
    视图另外给 `holdMinutes` 与 `pendingCount`。门槛与处罚相同（全量要 240，否则本群 ≥120）；
36. `GET /api/notify/deliveries?group=&status=&page=&pageSize=`：通知投递记录（谁收到了 / 失败原因 /
    降级说明），响应额外给**按状态汇总** `counts`（一眼看「失败多少」）。
    门槛与处罚相同 —— 排查「我说了怎么没通知」是审核员级别的只读需求；
37. `GET /api/health`（平台超管 240）：把 `/status proc` 的内容接进后台 ——
    **进程**（运行版本 vs 磁盘版本、启动时间、Node / pid / 内存、运行模式）、
    **写队列**（待写 / 失败 / 最近错误）、**数据库**（driver + 迁移问题明细）、
    **通知**（订阅人数 / 投递条数）、**模块健康**（全部模块的 state 与降级原因）、
    **恢复现场**（`data/restart-failed.json`、`data/rollback-notice.json`、`data/dist-broken/` 是否存在）。
    只读巡检进程没有这些内存态 → 503；
38. `POST /api/join/sync { group }`：同步官方入群申请队列（与指令层 `/sync` **同一个服务**）。
    **写但幂等**、门槛是**本群审核员 120**（不是 130 —— 它只把官方队列拉下来，不改变任何人的状态），
    写审计 `admin_api:join_sync`；返回 `fetched` / `pending` / 人话 `message`；
39. `GET /api/audit/export.csv?group=&full=`：审计记录 CSV（与 `/export audit` 同一实现）。
    默认**脱敏**（actor / target 只留首字符）、本群要 130；**`full=1` 要平台 240**
    （指令层的导出永远脱敏，这一步更进一步，所以单独抬高 —— CSV 会落到下载目录）；
    两种都写审计（领域层 `export_audit_records` + 管理面 `admin_api:audit_export`），响应带 UTF-8 BOM；
40. **`/api/pending` 附申请人资料摘要**：每项多一个可选 `profile`
    （姓名 / 学号（**中间打码**）/ 班级 / 学院 / 年级），没有填过资料时不带这个字段。
    完整学号只在名单导出的 `?full=1`（有门槛 + 审计）里出现。

**P1 的能力边界**：以上端点**只有机器人进程内那个监听口**装配（只读巡检模式回 503）——
它们都依赖内存态服务（处罚 / 黑名单 / 申诉 / 通知计数 / 模块健康表）。

### E1-j 写操作：处罚动作 / 黑名单 / 申诉复核（P2，0.24.2 起）

> 三条口径（[ADMIN-BACKEND.md](./ADMIN-BACKEND.md) §1）：**与指令层同源**（同一个领域服务，
> 所以通知话术、官方调用、连带效果都一致）、**不可逆动作要二次确认**（界面用 `ModalDialog`，
> API 侧靠 `X-Admin-Request: 1` + 审计兜底）、**每条都写 `admin_api:*` 审计**。

41. `POST /api/punishments/:code/release|mute|kick|blacklist`（本群 120；`blacklist` 的
    `scope=global` 要平台 240）：处罚动作，与 `/punish release|mute|kick|blacklist` **同一个
    `PunishmentService`**。`mute` 要 `seconds`（0 = 解除禁言）、`blacklist` 可带
    `scope` / `reason`、`release` 可带 `note`。
    成功后会**连带把该处罚下待处理的申诉判定为已通过**（指令层同样语义：处置即回应申诉），
    响应里的 `acceptedAppeals` 是条数；不可逆动作（`kick` / `blacklist`）的后果在界面二次确认里写明
    （`kick` 移出群、`blacklist` 默认同时移出群、`scope=global` 影响**所有已绑定群**）；
42. `POST /api/blacklist { scope, group?, userId, reason? }`、`DELETE /api/blacklist/:userId?scope=&group=`：
    黑名单增删，与 `/blacklist add|del` 同一服务。本群 120 / 全局 240；加入时**默认同时把人移出群**
    （指令层既有行为），响应给 `kickedGroups`（全局可能是多个群）；
43. `POST /api/appeals/:code/accept|reject`（本群 120）：申诉复核。
    **`accept` = 撤销该处罚**（`PunishmentService.release`：逐项撤销禁言 / 拉黑等，
    **撤回消息与移出群不可逆**）；`reject` 可带 `note`（留空用「已驳回」）。
    两种结果都会**私信申诉人**（`ModerationNotifier`，与指令层同一条通道）；
    已经处理过的申诉回 409（`conflict`），不存在回 404。

44. `PUT /api/notify/levels { topic, level }`、`POST /api/notify/levels/reset`（平台超管 240）：
    通知话题门槛，与指令层 `/notify level <话题> <数值>` **同一份存储**
    （`NotificationService.setTopicLevel` / `resetTopicLevels`）。数值口径一致：
    `-1` = 不限、`110`–`140` 群内轴、`210`–`240` 平台轴；非法话题 / 越界值回 400（中文原因来自领域服务）。
    **门槛是全局一套**，改一次所有群生效 —— 这是它必须 240 的原因。响应回**全部话题的新状态**
    （含当前门槛 / 默认门槛 / 订阅计数 / 说明文案），界面整体替换、不用再取一次；
45. `POST /api/notify/test { group? }`（任何登录管理员）：给自己发一张测试卡，
    与指令层 `/notify test` 同一条通道。**收件人取会话里的 userId，不接受请求体指定别人** ——
    它既不打扰别人也不泄漏数据，所以不需要额外门槛；私信发不出去时回 `ok: false` 与人话原因。
46. **订阅仍是个人偏好**：`GET /api/notify/topics` 只给「订了多少人」的计数，
    后台**不提供替别人订阅 / 退订**（那是每个人自己的选择，在机器人里用 `/notify` 改）。

47. `POST /api/rules/keywords { group, action, words }`（本群 130 / 全局 240）：规则关键词**逐条**增删。
    走 `GroupConfigStore.setOverride`（与 `/rules add|del keyword` 同一份存储），逐词按指令层同一套规则校验
    （trim / 空 / 单条 ≤ `RULE_KEYWORD_MAX_LENGTH` 50 字 / 重复）；
    **单个词失败不整批失败** —— 已存在 / 不存在的词进 `skipped`（带原因）并如实回给界面，
    响应另给 `added` / `removed` / 改完后的**完整**关键词表；
48. `POST /api/rules/reset-fields { group, fields }`、`POST /api/rules/reset { group }`（门槛同 47）：
    **恢复继承** —— 前者只清指定字段的覆盖（`clearFields`，回落到全局默认），后者整群重置
    （`removeOverride`，连带清空该群关键词行）。两者都**不可逆**（覆盖行被删掉），界面必须二次确认；
    响应给 `overriddenFields`（清完之后仍在覆盖的字段），界面据此刷新「覆盖中」标记；
49. `GET /api/aliases`、`PUT /api/aliases { alias, target }`、`DELETE /api/aliases/:alias`
    （**平台超管 240**）：班级 / 学院 / 专业别名表，与指令层 `/alias set|del` 同一份存储。
    类型（`class` / `college` / `major`）由服务按班级库**自动判定**，不需要调用方指定；
    班级库未加载时按服务原话回 400（「先在服务器执行 `pnpm class:index`」）；
    删不存在的别名回 `ok: false` 与说明，不静默成功。

### E1-k 写操作：活动创建 / 绑定群 / 改字段（P2，0.24.2 起）

> 与 **E1-j** 同一套三条口径（同源 / 不可逆要确认 / 每条写审计）。字段解析与两个连带副作用
> （名额调小到满员要广播「活动已满」、改完私信已报名 / 候补者）现在住在共享模块
> `src/services/activitySettings.ts`，指令层 `/activity set` 与管理后台**调同一份**
> （`resolveActivitySetting` + `applyActivitySettingValue`），所以两边不可能再漂移。

50. `POST /api/activities { group, title }`（本群群管理员 130）：新建活动，与 `/activity create`
    同一个 `ActivityService.createActivity`。**建出来是草稿、不广播**，并**自动绑定创建群**
    （指令层既有语义）；`open` 才往发布群发卡。响应 `activity` 是回读快照，`boundGroups`
    是当前发布 / 广播目标；
51. `POST /api/activities/:code/groups { group }`、`DELETE /api/activities/:code/groups/:group`
    （本群 130）：绑定 / 解绑发布群，走 `ActivityService.bindGroup` / `unbindGroup`。
    **重复绑定是幂等空操作**（消息说明「已经绑定过」，不报错）；**解绑最后一行绑定会回落到归属群**
    （`listBoundGroups` 既有语义），所以界面只在绑定数 > 1 时给「解绑」按钮。
    三条写各写 `admin_api:activity_create` / `admin_api:activity_bind` / `admin_api:activity_unbind` 审计；
    `GET /api/activities` 列表也补了 `boundGroups` / `closeAt` 字段（页面显示发布群与截止时间）；
52. `GET /api/activities/fields`：**活动字段目录**（字段名 / 中文名 / 输入类型 / 提示 / 能否 `clear` /
    改完是否私信），就是共享模块里的 `ACTIVITY_SETTING_FIELDS`。静态清单、不含数据，所以只要求
    **登录**；页面按它渲染「改字段」表单，不再各写一套字段清单；
53. `PUT /api/activities/:code { field, value }`（本群 130）：改一个活动字段，`field` / `value` 的
    写法与 `/activity set <短码> <字段> <值>` **完全一致**（含中文别名、`clear` 清空）。
    值不合法 / 字段不认识回 400（中文原因原样给界面，**不落库、不写审计**，与 `PUT /api/rules` 同口径）；
    成功写 `admin_api:activity_update` 审计，理由里带「旧值 → 新值」（`describeActivitySetting` 生成）。

**还没搬进后台的写操作**：[ADMIN-BACKEND.md](./ADMIN-BACKEND.md) §3 的 P2 **已全部落地**，
只剩 P3 的权限授予 / 撤销（`/perm`，见该文档 §3 P3）。

### E1-l 统计报表：群活跃 / 审核量 / 活动报名 / 通知投递（E5 非 AI 部分）

> 口径与理由见 [DECISIONS.md](./DECISIONS.md) 的 **ADR-0059**：**只用已有记录做聚合，不新增埋点**。
> 因此「群活跃」是**管理事件量**（审批动作 + 处罚 + 活动报名 + 投递），不是发言量。

54. `GET /api/reports?group=&days=`：四块报表。`days` 夹在 1–90（默认 7），按**本地日**分桶，
    **没有事件的天补 0 行**；响应给 `range` / `groups`（按群合计，事件数倒序）/ `daily` /
    `totals` / `activities`（按本期新增报名倒序，最多 20 条）。
    - **群活跃** `events` = 通过 + 拒绝 + 超时 + 处罚 + 报名 + 投递（每天一行，页面按天画分布）；
    - **审核量** = 审计里的 `approve_join_request` / `reject_join_request` / `expire_join_request`
      （**待处理不进报表**：实时队列看 `GET /api/pending`）；
    - **活动报名** = 本期新增 `registeredInRange` 与当前 `registered` / `waitlist` / `full` 分开给；
    - **通知投递** = `notification_deliveries` 的 `deliveries` / `deliveryFailed`（失败明细在
      `GET /api/notify/deliveries`）；
    - 门槛：平台超管 240 可不带 `group=` 看全量；其余人必须带 `?group=`（缺参数 400）且本群 ≥130；
55. `GET /api/reports/export.csv?group=&days=&full=`：与页面**同一份装配**的长表
    （`section,metric,bucket,group,value`）。默认脱敏：群只出展示标签、不含内部群 ID，本群要 130；
    `full=1` 追加 `group_id` 列且要平台 240；两种都写 `admin_api:report_export` 审计、都带 UTF-8 BOM。
56. **只读巡检模式没有这四块的数据源**（审计 / 处罚 / 活动都在机器人进程的内存里）→ 503，
    并说明去机器人进程内的监听口看。

### E1-g 只读端点的逐路由门槛（P1）

30. `GET /api/tasks`（平台超管 240）：**周期任务监测列表** —— 统一扫描周期 + 每个任务的
    节拍 / 上次执行 / 下次最早执行 / 是否因依赖模块降级被整轮跳过，外加部署监测的「待重启」
    （目标版本 / 当前版本 / 检测与计划重启时刻）。数据来自 `TickScheduler.snapshot()`
    （只读、不触发任务、不更新 `lastRun`）；只读巡检进程没有调度器 → 503 并说明该去哪看。
    与 `SCAN_INTERVAL_MS` 的关系：**全项目只有一个定时器**，每个任务只声明自己的最小间隔；
31. `GET /api/settings`（平台超管 240）：可改的热改项（当前生效值 + 来源 `env` / `override`）
    + `.env` 只读项。**密钥类（`*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_KEY`）不回传值**，
    只回「配没配」—— 值不经过浏览器（免得进缓存 / 截图）；
32. `PUT /api/settings { key, value }`、`DELETE /api/settings/:key`（平台超管 240）：
    改一项热改配置 / 恢复 `.env` 默认值。**走机器人 `/config` 的同一套存储**
    （`PlatformSettingsStore.set` / `clear`：校验 → 落库 → 立即生效），不新造配置通路；
    校验失败回 400（中文原因原样给界面，**不落库、不写审计**），成功写
    `admin_api:setting_update` / `admin_api:setting_clear` 审计（理由里带旧值 → 新值）。
    可改范围**只限** `SETTING_DEFINITIONS` 里的项：`.env` 的密钥 / 端口 / 数据库等仍然只能
    登服务器改文件后重启 —— 后台不提供「改线上密钥」这种能力。

### E1-g 只读端点的逐路由门槛（P1）

24. **每个只读端点都声明门槛**，由 HTTP 层统一判定（`readAccessOf` + `auditDenied` 两个注入点），
    失败返回 403 并写一条 `admin_api:denied` 审计：

| 端点 | 门槛 |
|---|---|
| `GET /api/status`、`GET /api/notify/topics`、`GET /api/tasks`、`GET /api/settings` | 平台超管 240（平台级信息 / 全局话题门槛 / 运维面板）|
| `GET /api/rules?group=__default__` | 平台超管 240（全局规则）|
| `GET /api/rules?group=<群>` | 本群审核员 120（与 `/rules` 查看口径一致）|
| `GET /api/audit` | 平台超管 240 拿全量；其余必须带 `?group=<群>`（缺参数 400）且本群 ≥120 |
| `GET /api/pending` | 按**本群 ≥120 裁剪**（与 `/pending` 一致；通过 / 拒绝仍要 130）|
| `GET /api/activities` | 按**本群 ≥120 裁剪**（带报名人数的管理视图）|
| `GET /api/punishments`、`GET /api/appeals`、`GET /api/notify/deliveries` | 平台超管 240 拿全量；其余必须带 `?group=<群>`（缺参数 400）且本群 ≥120 |
| `GET /api/blacklist?group=` | 本群那组 ≥120；**全局那组只有平台 240**（拿不到时 `globalVisible: false`）|
| `GET /api/health` | 平台超管 240（进程 / 队列 / 模块健康 / 恢复现场）|
| `POST /api/join/sync`（写但幂等） | 本群**审核员 120**（与 `/sync` 一致：只拉官方队列，不改用户状态）|
| `GET /api/audit/export.csv` | 本群 130（脱敏）；`?full=1` 与不带 `group=` 的**全量**要平台 240 |
| `POST /api/punishments/:code/release\|mute\|kick`、`POST /api/appeals/:code/accept\|reject` | 本群**审核员 120**（与指令层一致）|
| `POST /api/punishments/:code/blacklist`、`POST /api/blacklist`、`DELETE /api/blacklist/:userId` | 本群 120；**`scope=global` 要平台 240**（会影响所有绑定群）|
| `PUT /api/notify/levels`、`POST /api/notify/levels/reset` | 平台超管 240（门槛全局一套）|
| `POST /api/notify/test` | 任何登录管理员（**只发给自己**，收件人取会话）|
| `POST /api/rules/keywords`、`POST /api/rules/reset-fields`、`POST /api/rules/reset` | 本群群管理员 130；`group=__default__` 要平台 240（与 `PUT /api/rules` 一致）|
| `GET /api/aliases`、`PUT /api/aliases`、`DELETE /api/aliases/:alias` | 平台超管 240（别名表是全局配置）|
| `POST /api/activities`、`POST /api/activities/:code/groups`、`DELETE /api/activities/:code/groups/:group`、`PUT /api/activities/:code` | 本群**群管理员 130**（与指令层 `create` / `bind` / `unbind` / `set` 一致；`code` 所属群决定判定对象）|
| `GET /api/activities/fields` | **任意登录会话**（静态字段目录，不含任何数据）|
| `GET /api/reports` | 平台超管 240 拿全量；其余必须带 `?group=<群>`（缺参数 400）且本群 ≥130 |
| `GET /api/reports/export.csv` | 本群 130（脱敏长表）；`?full=1` 与不带 `group=` 的**全量**要平台 240 |

- **不报错、只裁剪**：列表类端点（待审批 / 活动）对够不着的群直接少返回，而不是整条 403 ——
  多群管理员看到的自然是自己那几行；
- **机器令牌不受逐路由门槛限制**：`ADMIN_API_TOKENS` 是运维自己配的服务凭据（`read` / `write`
  scope 显式给），按平台级只读处理；
- **未装配 `readAccessOf` 时全量放行**：这是单元测试用的路径，也是「只读巡检模式」在
  没有权限表（纯内存库）时的兜底 —— 真实部署两条入口都会装配它；
- `?group=` 统一是**内部群 ID**（`/auth/me` 返回的 `groups[].groupId`），不接受 `#群短码`：
  短码解析是机器人侧的展示能力，API 不为它引入依赖。

### E2-a…E2-e 管理后台（P3）

25. **E2-a 脚手架**（✅ 已完成）：`web/`（Vite 7 + Vue 3 + TypeScript + vue-router + pinia），
    根 `pnpm web:install` / `web:dev` / `web:typecheck` / `web:build` / `web:test`；开发期 vite proxy 把
    `/api`、`/auth`、`/healthz` 转发到 `ADMIN_API_PROXY`（默认 `http://127.0.0.1:8787`），
    浏览器看到同源地址，因此不涉及 CORS、`SameSite=Strict` 的 cookie 也能直接带上；
    产物 `web/dist` 不进 `dist/`（CD 默认不发，`.gitignore` 覆盖）。
    组件测试（P2 收尾那批）用 `web/vitest.config.ts`：jsdom + `@vue/test-utils`，
    只在 `fetch` 一层造假，CI 与 CD 都跑 `pnpm web:test`（见 [DEVELOPMENT.md](./DEVELOPMENT.md) §1）。
    脚手架里已经带了**最小可用的登录链路**：`src/api/client.ts`（同源 + 写操作自动带
    `X-Admin-Request: 1` + 统一 `ApiError`）、`src/stores/session.ts`（`/auth/me` / `/auth/token` /
    `/auth/logout`，并用与后端同一套两轴折算提供 `isSuperAdmin` / `levelIn(group)`）、
    登录页（支持私信链接的 `?token=` 预填）与占位看板。
26. **E2-b 登录与会话保持**（✅ 已完成）：登录页与私信链接的 `?token=` 预填随 E2-a 落地；
    这一项补上会话保持 —— 路由守卫首次导航问 `/auth/me`，没会话就带 `?redirect=<原地址>`
    去登录页（`?token=` 一起带过）；任何一个 API 拿到 401（cookie 过期 / 换过会话密钥 /
    机器人重启）都由 `api/client.ts` 的 `onUnauthorized` 送回登录页并标 `?expired=1`，
    登录页据此说明「是过期，不是令牌错」；登录成功回跳原地址；顶栏显示会话剩余时间。
    `/auth/me` 的 401 用 `silent401` 豁免：那是「我还没登录」的正常分支，
    否则会和路由守卫互相打断；
27. **E2-c 页面**（✅ 已完成）：五个页面都接上了真实端点 ——
    - **状态** `/status`：`GET /api/status`（平台超管；非超管连请求都不发）；
    - **待审批** `/pending`：列表（按自己够权限的群过滤 + 分页）、通过 / 拒绝各自二次确认，
      拒绝可写自定义理由（留空 = 指令层默认文案），按钮按「本群 130」禁用；
    - **审计** `/audit`：按群 / 操作人 / 动作过滤 + 分页；非超管默认选中第一个够 120 的群
      （服务端不带 `?group=` 会回 400）；
    - **规则** `/rules`：群选择（超管多一个「全局规则」`__default__`）、覆盖字段点选 + 生效配置表格，
      改字段时**提交前给 diff**（旧值 → 新值），确认后 `PUT /api/rules`，
      非法值由机器人侧解析器整体拒绝并原样显示；
    - **活动** `/activities`：按群 / 状态过滤 + 分页，开放 / 结束 / 取消（本群 130 起，
      已是目标状态的按钮禁用），「名单 / 完整名单」两个下载链接（`export.csv` 与 `?full=1`）；
      另加「新建活动（草稿）」表单、每行的发布群绑定 / 解绑与**改字段**（本群 130，见 E1-k）；
      每行列出当前发布群与截止时间，绑定数 > 1 时才给「解绑」（最后一行会回落到归属群）；
      改字段的字段清单来自 `GET /api/activities/fields`，写法与 `/activity set` 一致（含 `clear`）。
    - **报表** `/reports`（E5，见 E1-l）：群选择（超管多一个「全部群 / 全量」）+ 近 7 / 30 / 90 天，
      四块汇总（群活跃按天分布 / 审核量 / 活动报名 / 通知投递）+ 按群表；「导出 CSV」脱敏、
      「导出完整 CSV」（超管）多一列内部群 ID；页面上写明「群活跃是管理事件量，不是发言量」。
28. **E2-d 权限呈现**（✅ 已完成）：按 `/auth/me` 的两轴画像决定入口与可用性 ——
    非平台超管不显示「状态」入口、待审批 / 活动 / 规则的写按钮按本群 130 禁用、
    审计默认收敛到自己够权限的群；**全部只是体验**：服务端逐路由门槛（E1-g）与写端点判定
    （本群 130 / 全局 240）才是硬约束 —— 直接调 API 一样会被 403 并留 `admin_api:denied` 审计。
29. **E2-e 交付**（✅ 已完成）：`web/dist` **由 CD 一起发布**（门禁先 `pnpm --dir web install` +
    `pnpm web:build`，再跟后端产物一起上传到应用目录）—— 服务器上不用装前端依赖、不用手工构建。交付有两条路：
    - **默认（推荐）：管理 API 自己托管** `ADMIN_API_WEB_DIR`（默认 `web/dist`）—— `/`、`/login`、
      `/pending` 由它提供，导航请求回退 `index.html`；于是反代「整个域名 → 8787」就够了，
      nginx 里不用写 `root` / `try_files`（把 `ADMIN_API_WEB_DIR` 留空即可关掉，改回 nginx 托管）；
    - **nginx 托管**：`root <应用目录>/web/dist` + `try_files … /index.html`，并只反代
      `/api`、`/auth`、`/healthz` 到 `127.0.0.1:8787`。片段见 [OPERATIONS.md](./OPERATIONS.md)「管理前台」。

    两种方式都同源（会话 cookie 是 `SameSite=Strict`，跨源会把登录态吃掉）。
    本地开发用 `pnpm web:dev`（自带代理），想在本机看构建产物用 `pnpm --dir web run preview`。
33. **E2-f 展示层与配置页**（✅ 已完成）：
    - **展示口径**：列表与选择器**优先出绑定号（QQ号 / 群号），其次短码，完整官方长码只出现在「详情」里**。
      服务端把这份信息算成 `AdminApiEntityRef`（`kind` / `officialId` / `label` / `externalId` /
      `shortCode`），挂在 `/api/audit`、`/api/pending`、`/api/rules`、`/api/activities` 的每一项上，
      以及 `/auth/me` 的 `groups[]` 上；前端只读 `label`，长码收进折叠区（`components/EntityLabel.vue`）。
      **短码只查不造**（`ShortCodeService.existingCode`）：读端点不给历史 actor 现造短码；
      审计记录补上 `targetUserId`（「操作对象」列）；审计页的时间统一成本地 `YYYY-MM-DD HH:MM:SS`；
    - **配置页** `/settings`（平台超管）：可改项就地编辑（布尔用下拉）+「恢复默认」，
      `.env` 只读项单独一张表（密钥类显示「已配置 / 未配置」）；沿用「非超管连请求都不发」的口径；
    - **状态页** `/status` 除了原有只读状态，多了「周期任务监测」表格与「待生效的部署」区块。

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
