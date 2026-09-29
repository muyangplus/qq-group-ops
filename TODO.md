# TODO

> **唯一的待办入口**：只列**未完成**项，每项给出验收 / 落点 / 阻塞；已完成的历史变更见
> [CHANGELOG.md](./CHANGELOG.md)，阶段目标与范围见 [docs/ROADMAP.md](./docs/ROADMAP.md)。
>
> 标签口径：`P0` 最急 → `P3` 可延后；`⚠️` 需先澄清 / 取证；`真机` 需要真实 QQ 群环境；`（记录）` 是已知约束、不一定动。
>
> 当前状态（2026-09-27）：测试 **113 文件 / 903 用例**全绿；**0.21.0 已发版**（tag + GitHub Release，
> 含统一计时任务、部署监测自动重启、状态/重启卡文案改人话、私信卡片权限修复）。
> `[Unreleased]` 现有：一次性数据迁移 `/migrate` + 主体代码不再兼容老格式、配置瘦身、`-1` 永久保留、卡片文案去自证式声明。
> 已完成：A1–A5、B1–B3、B6–B11、C1–C3、C5–C6、C9、D1、D3、D5、D10、F1–F2、H1–H8、D9（0.19.0 起）。

## 1. 待办

### P0

- [ ] **启动稳健性：模块隔离 + 功能闸门 + 重启前预检 / 回滚**
  - 目标（用户确认）：单个模块出错**不拦启动**，只把该模块与它的**功能域**屏蔽掉并明确拒绝使用；
    同时防止「`/restart` / 自动部署之后新版本起不来」。范围 = 全做（层 1–4）、粒度 = **按功能域**、
    降级告知 = **新增超管话题「启动报告」**。
  - 现状失败点（一处抛错整个进程就死）：① `loadSettings()`（核心 env，**保持快速失败**）；
    ② `openPersistence()` → `migrate()`（**层 3 已完成**：数据步骤失败只记 issues）；
    ③ `createRuntime()` 构造期；④ `runtime.load()` 里 17 个 service 顺序 `await`；
    ⑤ 网关连接（已是「失败重试、不阻塞」，是要推广的正例）。
  - **层 1 模块注册表**：`runtime.load()` 的 17 个 `await` 换成 `{ key, label, load, features, critical? }`
    清单 + 逐项 try/catch；失败标 `degraded` 并继续；提供「重试加载」（修好数据不用重启）。
  - **层 2 功能闸门**：`Availability` 单一事实来源（模块降级 → 它声明的 feature 全部不可用）；
    挂点四处：指令入口（按「指令 → feature」表拦）、回调 renderer、`eventRouter`、tick 任务 `enabled`；
    命中一律回「该功能当前不可用：X 模块初始化失败（原因）」，**不执行任何业务**；`/help` 与菜单隐藏入口。
  - **层 4A 重启前预检**：`node dist/main.js --check` 只读自检（settings + DB 连接 + schema + 各模块 load），
    由 `respawn.mjs` 在**旧进程退出后、拉起新进程前**跑；失败就不拉起 + 写 `data/restart-failed.json` +
    私信超管。`/restart` 与部署自动重启共用同一套。
  - **层 4B 自动回滚**：启动成功时把 `dist/` 快照到 `data/dist-backup/`，新版起不来就换回去；
    需要处理快照体积，以及 `package.json` 变更后 `node_modules` 未必兼容的边界。
  - 明确不做：DB 连不上 / 核心 env 非法 / 建表失败 → **保持快速失败**（否则会「以什么都不做的姿态在线」）；
    每次降级必须在 日志 + `/status proc` + 启动报告卡 三处可见 —— 隔离加载本身会掩盖代码 bug。
  - 验收：① 人为让某模块 `load()` 抛错 → 进程照起、其它模块功能正常，日志/状态卡/私信里能看到该模块；
    ② 该模块的指令 / 回调 / 事件 / tick 全部被拒且有明确文案，修好后「重试加载」即恢复；
    ③ 预检失败时 `/restart` 与自动重启都被拦下并私信超管；④ `--check` 失败返回非 0；
    ⑤ 回滚演练：人为让新 `dist` 启动失败 → 自动换回上一版并成功启动。

- [ ] **D4 真机验收**（批次2 退出条件）
  - 内容：跑 `docs/ACCEPTANCE.md` 的 J32–J56 + M 组，连带 B / C 节里标了 `真机` 的确认项。
  - 验收：逐项回填「通过 / 不通过 / 原因」；不通过项转成本文件里的新条目。

### P1

- [ ] **非核心 `.env` 配置项改为超管热修改（`/config`）**
  - 口径：`.env` 只留**启动就必需 / 安全相关**的项，其余全部改成**全局超管在运行时改、立即生效**（不重启）。
  - 留在 `.env`（核心）：`QQ_BOT_APP_ID` / `QQ_BOT_CLIENT_SECRET` / `QQ_BOT_TOKEN` / `EVENT_MODE` /
    `WEBHOOK_PORT|HOST|PATH|SECRET`、`DATABASE_URL` / `DATABASE_TARGET`（热配置本身存在这个库里）、
    `LOG_*`（日志在配置之前就要建）、`CLASS_INDEX_FILE`（启动时读文件）、`ADMIN_USER_IDS`（超管种子）。
  - 改热修改（按现在的 `.env.example` 小节）：数据保留三项（`RAW_MESSAGE_RETENTION_DAYS` /
    `AUDIT_LOG_RETENTION_DAYS` / `JOIN_REQUEST_TTL_DAYS`）、`MENU_FIRST_PUSH`、活动通知三项
    （`ACTIVITY_NOTIFY_DAILY_LIMIT` / `ACTIVITY_NOTIFY_RATE_PER_SECOND` / `APPEAL_HOLD_MINUTES`）、
    统一计时与部署四项（`SCAN_INTERVAL_MS` / `AUTO_RESTART_ON_DEPLOY` / `DEPLOY_RESTART_DELAY_MINUTES` /
    `DEPLOY_CHECK_INTERVAL_MS`）、`ACTIVITY_STATS_FONT_URL`、`TZ`。
  - 存储：新增 `platform_settings` 键值表（`CREATE TABLE IF NOT EXISTS`，与 `group_settings` 同思路，免 ALTER），
    启动时载入；**优先级 = DB 覆盖 > `.env` 默认值**，`/config clear <项>` 回落到 `.env`。
  - 热生效：`settings` 收敛成**可变的单一来源**，服务在**用的时候**读当前值而不是构造时固化 ——
    例如 `TickScheduler` 每轮读 `SCAN_INTERVAL_MS`、`RetentionService` 每次运行读保留期、
    `DeployWatcher` 每次检查读宽限期；需要重建连接/文件句柄的项不进这份清单。
  - 命令：`/config`（**仅全局超管、只在私信**）列出每项「当前值 + 来源（`.env` / 已覆盖）」；
    改值用「填入指令」按钮（卡片键盘打不了自由文本），`/config set <项> <值>`、`/config clear <项>`，
    每次改动写审计（平台级动作，`groupId=""`）。
  - 验收：① 改完**立即生效、不重启**（`SCAN_INTERVAL_MS`、`AUDIT_LOG_RETENTION_DAYS` 各验一次）；
    ② `clear` 回落到 `.env`；③ 非法值被拒绝且不改库；④ 非全局超管 / 群里不可用；
    ⑤ 每次改动都能在 `/audit` 查到；⑥ `.env.example`、`docs/CONFIGURATION.md` 与 `/help config` 标注哪些是热量项。
  - 关联：与下面「处罚原文按群清理」一起定 `RAW_MESSAGE_RETENTION_DAYS` 的去留（本条落地后它从 `.env` 挪进 `/config`）。
- [ ] **处罚原文按群清理（保留口径不一致，⚠️ 待定方案）**
  - 现状：**是否存原文**看本群 `rawMessageRetentionDays`（`0` 不存 / `-1` 永久 / `N` 存），
    而**清理**看环境变量 `RAW_MESSAGE_RETENTION_DAYS`（默认 `0` = 不清理）。
    于是某群执行 `/rules set rawMessageRetentionDays 7`、环境变量仍是默认值时，
    原文会**永久留在库里**（隐私 + 无上限增长）。
  - 方案（待定）：清理改成按群策略（该群 `> 0` 时按自己的天数清 `message_excerpt`，`-1` / `0` 不动）；
    此时环境变量只剩「全局总开关」这一个语义 —— 是直接删掉 `RAW_MESSAGE_RETENTION_DAYS`
    （配置瘦身，保留口径完全交给 `/rules`），还是保留成「全局上限」？
  - 落点：`RetentionService` 注入 `configStore`；`PunishmentService` 增加「列出有原文的群」与「按群清空原文」。
- [ ] **B4 文本内容安全 API 接入**（批次4 · Phase 2 · ⚠️ 官方能力未确认）
  - 阻塞：公开资料只能确认小程序体系有 `msgSecCheck`，未见 QQ 机器人开放平台向普通机器人开放文本审核接口；
    先在开放平台后台确认权限集，或真机调一次记录错误码（真机清单 R3）。
  - 验收：拿到官方接口后接入，含误报 / 漏报处理策略；**确认前不写盲接口**。
- [ ] **B5 图片 / 文件 / 链接审核**（批次4 · Phase 2 · ⚠️ 同 B4：等权限集确认）
- [ ] **D2 Docker Compose 启停补测**（批次2 · ⚠️ 待 Docker Desktop 引擎启动）
  - 已完成：`docker compose config --quiet` 通过、`--profile postgres` 服务列表正确、
    `.dockerignore` 实测少传约 106 MB。
  - 待补：镜像 build + postgres 启停（用独立项目名 `-p qqops-smoke`，收尾 `down -v`，避免污染真实数据卷）。
- [ ] **真机确认：`/migrate` 在真实库上跑通**（P0 已实现，等一次真实执行）
  - 触发前先备份数据库；确认：预览条数与实际老数据对得上、确认后改写成功、**再跑一次全是 0**、
    `/rules` 的违规处理动作迁移前后一致、老短码失效而新短码可查（`/whois`、`/punish`）、审计里有一条 `data_migrate`。
- [ ] **真机确认：`/restart` 在真实部署里确实能拉起新进程**
  - 触发一次 `/restart`，确认：回执卡先到、进程确实退出、几秒内重新起来、并且收到「机器人已重启」的私信回执；
    收不到就查 `data/restart-failed.json` 与启动日志（自我重启助手是脱离会话启动的，SSH 会话断开不影响它）。
  - 附带确认：**服务器/容器重启后不会自恢复**（这是自我重启模式的已知边界），需要长期守护时改 docker / systemd / pm2。
- [ ] **真机确认：`/status proc` 的数据与真实部署一致**（版本号、数据库类型/路径、写队列计数、待审批条数）
- [ ] **真机确认：`/whois` 群内完全静默**、私信失败才回一条「请先私聊机器人再试」（批次2）
- [ ] **真机确认：规则开关标签与恢复继承**——点击后标签变为当前状态，`恢复本页继承 / 恢复全部继承` 生效（批次2）
- [ ] **真机确认：官方是否有「用户撤回消息」下行事件**（决定处罚订阅能否扩到这一口径）（批次2）
- [ ] **真机确认：拉机器人进测试群是否也收到 `GROUP_MEMBER_ADD`**
  - 若会：迎新的判据要排掉「机器人自己」，否则机器人会被自己的欢迎语 @ 一遍；
    payload 里没有任何能识别机器人自己的字段，届时靠实际 openid 对比或官方文档确认。
- [ ] **真机确认：迎新走哪条 @ 通道生效**
  - 现在纯文本 `content` 与卡片 `<@!openid>` **两条都发**；确认哪条在客户端真能提醒到人后，可只留一条。

### P2

- [ ] **A2 好友申请 / 群邀请审核**（批次4 · Phase 2 · ⚠️ 官方能力待取证）
  - 事件已确认存在（`C2C_FRIEND_ADD` / `GROUP_ADD_ROBOT` 现在已按话题订阅通知超管），
    但**是否有审批 / 回执接口**未验证；取证见真机清单 R18。
  - 拿到结论后的可能方向：好友添加 → 欢迎语 + 引导 `/bind qq`；机器人入群 → 自动绑定群 + 管理引导卡；
    若平台没有审批接口，「审核」要改成「事件通知 + 自动引导」，不做防申请策略。
- [ ] **D6 安全审计与依赖更新策略**（批次5 · Phase 4 退出条件）
  - `pnpm audit` 周期化 + 依赖升级与回归流程；产出「安全与合规检查清单」。
    （Dependabot 已配，对应本条前半。）
- [ ] **D7 个人数据删除能力**（批次5 · Phase 4）
  - 过期数据清理已有；**按用户删除 / 导出个人数据未做**。
- [ ] **D8 部署演练 + 备份恢复演练**（批次5 · Phase 4 退出条件）
- [ ] **真机确认：活动报名 / 取消群内完全静默**、结果只走私信，私信失败只出现不含结果的提示（批次2）
- [ ] **真机确认：满员广播每群一次**——报名满员后所有绑定群各收到一次「活动已满」卡，重复触发不重复发（批次2）

### P3

- [ ] **E1 管理 API**（批次4 · Phase 2）Fastify / Node.js + 登录鉴权 + 限流 + 最小权限。
- [ ] **E2 Vue 3 + TypeScript 管理后台**（批次4 · Phase 2）
  - 审核队列、规则配置、日志查询、权限管理；验收：能在后台完成入群审批、规则配置与活动报名管理。
- [ ] **E3 AI 判断入群理由**（批次5 · Phase 3）只把可疑内容送模型，控制成本。
- [ ] **E4 AI 辅助疑难内容审核**（批次5 · Phase 3）AI 仅作辅助，保留人工复核入口与误判回滚机制。
- [ ] **E5 统计报表与自动化策略**（批次5 · Phase 3）
- [ ] **E6 AI 判断后的超管确认与策略更新闭环**（批次5 · Phase 3，依赖 E3 / E4）
  - 触发：AI 参与判断后私信全局超管样本摘要 + 结论与置信度 + 命中规则 + 实际动作，并询问「判断是否正确、是否更新策略」；
  - 一键动作（都先给 diff、再写审计；AI 只给建议、不直接落库）：标记正确 / 标记误判（回滚或转人工复核）/
    修正或扩充关键词 / 补班级学院映射 / 微调对应规则字段；
  - 打扰控制：只对「AI 参与且不确定 / 可疑」的样本推送，可配每日上限；
  - 验收：超管能从私信卡片完成一次策略修正，且改动可追溯（审计 + diff）。
- [ ] **H8-2 个人提醒类活动私信补退订入口**（前置：先让活动通知带上发布群）
  - 现状：候补 / 名额 / 变更类私信只有 `activityId`、拿不到群号，退订范围会退错群，所以**没有**退订按钮。
- [ ] **H8-5 `/rules … all` 的目标收敛**
  - 现在走 `meetsInGroup(__default__, 130)`（实际只有 240 能过），可显式拆成 `meetsGlobal(240)`：
    纯可读性，运行期无差别。

## 2. 已知约束（`（记录）` 类，不一定动）

- **旧版本的 GitHub Release 页面不补建**（2026-09-27 决定）：31 个 tag 里只有 `v0.18.0` / `v0.18.2` / `v0.19.0`
  有 Release 页面，其余 28 个保持现状 —— `cd-ftp.yml` 由「Release published」触发，
  每补一个都会跑一次部署（当前卡在 FTP 被动端口），收益不值得这批运行。
- **B6b 全局规则卡「种子默认」的覆盖展示**：重启前后展示存在边界差异，纯展示、不影响实际生效值；下次动全局规则卡时顺手修。
- **B7 能力边界**：官方下行事件没有「用户撤回消息」，处罚订阅只覆盖「机器人自己的审核动作」；真机抓到再扩口径。
- **C7 学院点选每页 4 个**：受卡片标准硬约束（每行按钮 ≤12 字、整盘 ≤5 行），非缺陷。
- **C8 活动统计图片依赖**：`@napi-rs/canvas` 未随包安装时按钮不生成、回调降级为文字统计卡（设计如此）；
  字体优先系统字体，缺失时从 `ACTIVITY_STATS_FONT_URL` 下载并缓存到 `data/fonts/`。
- **C9 / R17 机器人无法 @全体**：真机穷举 8 种出站写法全部无效，`mentionAll on` 只提示操作者手动 @；
  平台放开能力前不再重复验证。
- **H8-3 通知卡退订按钮**：文案 4 字（官方按钮上限 10 字）；同一张卡只有一行退订（id 冲突时不追加）；
  键盘满 5 行时宁可不加（宁可少按钮，也不能让整张卡发不出去）。
- **通知话题门槛**：全局一套（`group_settings.__default__.notifyTopicLevels`），改一次全群生效；
  改入口只有全局超管（`/notify level` 或面板底部「门槛」），卡片键盘打不了数字，所以按钮只做「填入指令」。

## 3. 真机与验收索引

- 真机清单与回填模板：[docs/REAL-MACHINE-CHECKLIST.md](./docs/REAL-MACHINE-CHECKLIST.md)（R1–R18）；
  一次跑完照 [docs/REAL-MACHINE-RUN.md](./docs/REAL-MACHINE-RUN.md)。
- 验收用例：[docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md)。
- 已发布版本的实现细节与决策：[CHANGELOG.md](./CHANGELOG.md)、[docs/DECISIONS.md](./docs/DECISIONS.md)。
