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

**选 A**，理由：唯一能同时满足「多人多设备」「映射到现有 `userId` 做最小权限」「审计能落到人」的方案，
且不依赖任何未取证能力；C 作为**附加层**（默认只监听 `127.0.0.1`，对外必须显式配置 + 反代 TLS）。
B 的做法不浪费：改成 **机器调用用的 API token**（见 §3 E1-e），给 CI / 脚本只读访问。

写操作的安全底座（A 方案必做）：会话 cookie 用 `HttpOnly + SameSite=Strict + Secure`（配了 TLS 时），
登录失败按「IP + 账号」双维度限流并锁定，所有写操作校验自定义头（`X-Admin-Request: 1`）防 CSRF，
CORS 默认关闭（同源部署）。

## 2. 运行形态对比

| 维度 | 独立入口 + 默认绑本机 | 复用机器人进程与端口 |
|---|---|---|
| 暴露面 | 小：默认不出网，要暴露必须显式改 `ADMIN_API_HOST` | 大：webhook 端口本就对外，管理面跟着一起暴露 |
| 隔离性 | 好：管理面崩溃 / 重启不影响网关与定时任务 | 差：共享事件循环与数据库连接池，一个慢查询拖垮收消息 |
| 部署复杂度 | 中：多一个进程单元（systemd / compose service），CD 可选加一步 | 小：不用新单元 |
| 权限最小化 | 好：可以只给它只读账号 / 只读连接 | 差：同进程天然拿到全部能力 |
| 资源 | 多一份进程（几十 MB） | 省 |
| 适用 | 生产（推荐） | 本机玩具 / 临时排查 |

**选独立入口**：`pnpm admin:api`（新文件 `src/adminApi/main.ts`），默认 `ADMIN_API_ENABLED=false`、
`ADMIN_API_HOST=127.0.0.1`、`ADMIN_API_PORT=8787`；对外必须显式配置并由反向代理终止 TLS。
CD 产物已经包含 `dist/`，**默认关闭**即可零影响；开启与否写进 [CD.md](./CD.md) 与 [OPERATIONS.md](./OPERATIONS.md)。

## 3. 分阶段计划（与 TODO 的 E1-a…E2-e 一一对应）

### E1-a 骨架与安全底座（P0）

1. `src/adminApi/`：`main.ts`（进程入口）+ `server.ts`（Fastify 装配）+ `routes/*`；`/healthz` 不鉴权，
   只回 `{ ok, version, uptime }`（不暴露群 / 用户信息）；
2. 配置项进 `.env.example`：`ADMIN_API_ENABLED` / `ADMIN_API_HOST` / `ADMIN_API_PORT` /
   `ADMIN_API_SESSION_SECRET` / `ADMIN_API_ACCOUNTS`（`user:scrypt$...`）；**这些属于核心安全项，不进 `/config` 热改**；
3. 认证：`POST /auth/login`（scrypt 校验 + 会话 cookie）、`POST /auth/logout`、`GET /auth/me`；会话默认 12 小时滑动过期；
4. 登录限流与锁定：按 IP + 账号计数（默认 15 分钟内 5 次失败锁 15 分钟），成功即清零；
5. 全站限流：令牌桶，默认 60 req/min/会话（复用活动通知那套令牌桶思路）；
6. CSRF：写操作必须带 `X-Admin-Request: 1`；CORS 默认关闭；
7. 审计：登录成功 / 失败、权限拒绝、每个写操作都写 `audit_log`（平台级 `group_id = ""`，`actor_id` = 账号映射的 `userId`）。

### E1-b 身份与权限映射（P0）

8. `ADMIN_API_ACCOUNTS` 的每个账号可带 `openid`：登录后映射成 `userId`，直接复用 `PermissionService` 两轴判定；
   没配 openid 的账号按**只读 + 仅平台级状态**处理；
9. 每个路由声明所需门槛（例：`GET /api/audit` 需某群 130 或平台 240），统一前置钩子判定，
   失败返回 403 并写明原因，**同时写审计**。

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

19. `ADMIN_API_TOKENS`（`token:scope`，scope 形如 `read` / `read:pending`，可过期）：`Authorization: Bearer`，
    只读优先；token 用 `crypto.timingSafeEqual` 比较，日志里只打 token 前缀。

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

- **不做 OAuth 扫码登录**：官方是否开放该能力未取证（见真机清单 R3/R18），且会话方案已满足需求；
- **不做多租户 / 按群隔离的独立账号体系**：权限复用现有两轴模型，账号只是「登录凭据」；
- **管理 API 不暴露消息原文**：`RAW_MESSAGE_RETENTION_DAYS` 的短期原文只走机器人卡片，API 一律不返回；
- **不在管理面提供个人数据删除**：那属于 `/data`（见 COMMANDS.md「个人数据删除 / 导出」），
  平台级动作不在浏览器里做，避免误点。
