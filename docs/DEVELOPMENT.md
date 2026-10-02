# 开发指南

面向要改这个仓库的人：怎么跑、代码怎么分层、新指令加在哪、测试怎么写、提交前要过什么。

## 1. 环境与常用命令

| 目的 | 命令 |
|---|---|
| 本地开发 | `pnpm dev`（`tsx watch`，读 `.env`，`MENU_FIRST_PUSH` 自动为 memory） |
| 类型检查 | `pnpm typecheck` |
| 全量测试 | `pnpm test` |
| 单文件测试 | `node node_modules/vitest/vitest.mjs run --configLoader runner test/xxx.test.ts` |
| 构建 + 启动 | `pnpm build && pnpm start`（`dist/` 不会自动更新） |
| 班级索引 | `pnpm class:index`（读 `data/class.json`，输出 JSON + SQLite） |
| 依赖漏洞审计 | `pnpm check:audit`（`pnpm audit --audit-level=high`；每周 CI 也自动跑，处置流程见 [SECURITY.md](./SECURITY.md)） |
| 管理前台（首次） | `pnpm web:install`（只装 `web/` 自己那套依赖，根 `pnpm install` 不受影响） |
| 管理前台开发 | `pnpm web:dev`（默认 http://127.0.0.1:5173，`/api`、`/auth`、`/healthz` 代理到 `ADMIN_API_PROXY`，默认 127.0.0.1:8787） |
| 管理前台检查 / 构建 | `pnpm web:typecheck`（`vue-tsc`）、`pnpm web:build`（类型检查 + `vite build`，产物 `web/dist`，**不进 `dist/`**） |

> 前端是**独立的一套依赖**：根 `pnpm install` 不装 Vue / Vite，`pnpm web:*` 都走 `pnpm --dir web`。
> `web/pnpm-workspace.yaml` 是 pnpm 12 的**构建脚本白名单**（只放行 `esbuild`）——
> 删掉它 `pnpm web:install` 会以 `ERR_PNPM_IGNORED_BUILDS` 失败。
> **CI 与 CD 都会构建前端**（`pnpm --dir web install` + `pnpm web:build`）：CI 用来尽早发现前端坏了，
> CD 是把它跟后端产物一起发布（`dist-deploy/web/dist`）。

> 在受限沙箱/CI 里 `pnpm` 可能因锁文件或 store 权限失败，此时直接用 node 二进制：
> `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`、
> `node node_modules/vitest/vitest.mjs run --configLoader runner`（`--configLoader runner` 用来避开 `spawn EPERM`）。

### 配置改动：三份 `.env` 要一起改（维护者约定）

| 文件 | 角色 | 进 Git？ | 随 CD 上传？ |
|---|---|---|---|
| `.env.example` | 模板与文档（全部键 + 默认值 + 说明） | ✅ | ✅（部署白名单里有它）→ **只放占位符** |
| `.env` | 本地调试实际生效的那份 | ❌ | ❌ |
| `data/.env` | 线上配置的母本（部署时覆盖服务器上的 `.env`） | ❌（`data/` 整体忽略） | ❌ |

代码里新增 / 改名一个键时，**三份一起改**：只改模板会让本地与线上「查无此项」→
进程悄悄用代码默认值，现象是「配置改了却没生效」。改完自检（只看键名、不打印值）：

```bash
grep -ohE '^[A-Za-z_][A-Za-z0-9_]*=' .env.example | tr -d '=' | sort -u > /tmp/ex.txt
grep -ohE '^[A-Za-z_][A-Za-z0-9_]*=' .env data/.env | tr -d '=' | sort -u > /tmp/real.txt
comm -23 /tmp/ex.txt /tmp/real.txt   # 模板有、真实配置没有 → 漏改，补上
comm -13 /tmp/ex.txt /tmp/real.txt   # 真实配置有、模板没有 → 模板缺说明，补注释
```

> 外部贡献者只需要自己的 `.env`：`data/.env` 是**本项目维护者**的线上配置副本，
> 别人 clone 下来不会有这个文件，忽略即可。

## 2. 目录结构

```
src/
├── adapters/     官方 API 客户端、WebSocket 网关、事件映射（对外部世界只在这里）
│                 qqOfficial.ts 只做 barrel：Types / Client / Payload 三个模块
├── adminApi/     管理 API：config / session / rateLimit / server（HTTP 层）
│                 host.ts（同进程回环监听口）+ backend.ts（接真实服务图）+ main.ts（只读巡检进程）
├── core/         领域无关的基础设施：日志、模型、枚举、instrumentation
├── db/           schema 与仓储（同一套 SQL 通过 Queryable 适配 SQLite / PostgreSQL）
├── services/     业务服务（权限、审核、活动、规则、推送、短码、别名、个人资料…）
│   └── commands/ 指令层子模块（按域拆分）
├── runtime.ts    依赖装配 + 回调 renderer 注册
├── gatewayRunner.ts / eventRouter.ts  事件 → 指令 → 回复
└── main.ts       进程入口

web/              管理后台（Vite + Vue 3 + TS，独立依赖，见 docs/ADMIN-API.md）
├── src/api/      最小 HTTP 客户端（同源、写操作带 CSRF 头、统一抛 ApiError）
├── src/stores/   pinia：会话与权限画像（两轴折算与后端一致）
└── src/views/    页面（E2-c 逐项落地）

test/
├── commands/     指令层用例（按域分文件）
└── helpers/      共享夹具与替身（含 adminCommandsHarness.ts）
```

## 3. 指令层：门面 + 领域子模块

`AdminCommandService`（`src/services/adminCommands.ts`，约 900 行）是**门面**：它保留全部对外 API
（`handle()`、各 `xxxCard()`），把「路由、装依赖、`ensureCard` 兜底」留给自己，领域逻辑都在
`src/services/commands/*`：

| 文件 | 职责 |
|---|---|
| `commands/support.ts` | 纯工具与常量：按钮构造、解析/格式化、用法文案、字段标签、`CommandResult`/`CardResult` 类型 |
| `commands/context.ts` | `AdminCommandContext`（各服务的只读依赖）+ `CommandHelpers`（门面暴露的小工具：`cardify`、`mention`、展示名、目标解析、`renderNotice`、活动实例态访问器） |
| `commands/displayHelpers.ts`、`commands/targetResolvers.ts` | 展示名与目标参数解析 |
| `commands/<domain>Commands.ts` | 领域逻辑，导出 `fn(ctx, …)` 形式；不直接依赖门面类，避免循环引用 |

**已拆出的领域模块（19 个）**：`support`、`context`、`displayHelpers`、`targetResolvers`、
`help`、`menu`、`status`、`test`、`whois`、`profile`、`alias`、`bind`、`perm`、`review`、
`notify`、`rule`、`activity`、`activityCard`、`activityFlow`。

### 服务层的同类约定

- **大服务 = 主类文件 + `<name>Core.ts`**：类型、常量、纯函数放 Core，主类文件只留类并从 Core
  import；公开名字由主类文件原样再导出，外部 import 路径不变（`activity` / `activityCards` /
  `activityStats` / `groupConfig` 都按这个结构，单向依赖无环）。
- **推送统一走 `services/pushService.ts`**：入群申请推送与活动通知共用
  「按 key 去重 → 可选每日封顶 → 发送 → 记录 → 汇总」骨架，各自只提供自己的 `PushStore` 适配器、
  发送通道与记录形状；两者语义差异用选项表达（`recordOnFailure`、`dailyLimit`）。

其中活动域按三层拆分（单向依赖）：`activityCardCommands` ← `activityFlowCommands` ← `activityCommands`。

### 新增一个领域模块的步骤

1. 在 `src/services/commands/<domain>Commands.ts` 里写 `export function xxxCard(ctx: AdminCommandContext, …): CommandResult`；
2. 需要新依赖就往 `AdminCommandContext` 加字段，需要新工具就往 `CommandHelpers` 加签名并在门面 `context()` 里实现；
3. 门面对外的方法保留成**一行包装**：`public xxxCard(...) { return xxxCard(this.context(), ...); }`
   —— 这样 `runtime.ts` 的回调 renderer 与测试都不用改；
4. `dispatchCommand` 里的 `case` 直接调模块函数；
5. 纯搬迁：**不改文案、按钮 id、回调 data、权限与行为**；测试只允许「搬家」不允许改弱。

## 4. 测试：按域分文件 + 共享夹具

- 指令层用例放 `test/commands/*.test.ts`（按域分文件，单文件控制在 400 行内）；
- 共享装配放 `test/helpers/`。`adminCommandsHarness.ts` 用**活绑定**模式：

  ```ts
  // test/helpers/adminCommandsHarness.ts
  import { beforeEach } from "vitest";
  export let service: AdminCommandService;
  beforeEach(() => {
    service = new AdminCommandService({ ... });
  });
  ```

  测试文件只需 `import { service, api, withShortCodes } from "../helpers/adminCommandsHarness.js";`
  即可读到每次用例前重新装配的夹具——**测试体不用改**，多文件共享同一套装配逻辑。
  （`export let` 的绑定是活的，赋值只发生在 helper 内部；测试里不要给 import 的夹具赋值。）
- 替身（如 `canvasStub.ts`、`fakeActivityNotificationRepository.ts`）同样放 `test/helpers/`。

## 5. 卡片与交互规范

- 所有指令输出（含错误、用法提示）都必须是卡片：见 [CARD-STANDARD.md](./CARD-STANDARD.md)；
- 导航 / 查看 / 翻页 / 开关 / 枚举用**回调按钮**（`cb:<namespace>:<action>[:args]`），
  需要参数或不可逆的动作用**指令按钮**；回调 renderer 必须自己再校验一次权限；
- 排版硬约束：一行按钮文字合计 ≤12 字、单个 ≤10 字、整盘 ≤5 行；
- 平台**没有**「更新原卡片」接口：回调后只能主动发新卡，旧卡留在聊天记录；
- 群里要 @ 到人用 Markdown 卡片里的 `<@!openid>`（真机验证有效）；`@全体成员` 官方不支持。

## 6. 用脚本批量搬运时的注意事项（踩过的坑）

拆大文件时用「脚本按区间剪切 + 改名 + 生成包装」很快，但这些都是实际踩过的坑：

1. **参数名解析要兼容单行签名**：签名可能是单行（`public testCard(a: X, b: Y): T {`），
   只按「行首 `name:`」匹配会拿到 0 个参数，生成 `fn(ctx, )` 这种坏包装；
   正确做法是先取括号内文本 `\(([^)]*)\)` 再拆参数；首参是对象类型（`fn(input: {`）时，`ctx` 要换行插在 `(` 之后。
2. **不要往目标模块追加整块 import**：重复绑定同名符号会直接编译失败（`Duplicate identifier`）。只补缺失的名字；
   跨目录搬运时相对路径要重算（`./commands/x.js` → `./x.js`），**裸包名**（`"vitest"`）不要跟着 rebase。
3. **切函数块不要用「行内容等于 `}`」**：模板字符串里可能出现单独一行的 `}`，会把函数截断并静默丢行。
   用「下一个函数声明 / 下一个函数注释起点」作为边界，并断言覆盖行数。
4. **删区间要先合并**：相邻领域常共享分隔空行，逐个 splice 会越删一行；按原始行号排序合并后再删。
5. **别把只在当前文件内用的东西顺手 export**：跨模块 import 会把模块表面撑大；搬完可以反向检查一遍。
6. **判断「某名字是否被用到」要先把展开运算符抹平**：`...formatRules(x)` / `[...PROFILE_ENTRY_YEARS]` 里的
   `...` 会让「前面是 `.` 就当成属性访问」的负向前瞻失效，于是漏 import、漏报；
   先 `text.replace(/\.\.\./g, " ")` 再匹配（这个坑在死代码清理与拆服务时各踩过一次）。
7. **一次只搬一个领域**，搬完立刻 `tsc --noEmit`；任何异常直接 `git checkout -- <文件>` 回滚，
   **绝不提交半成品**（顺序：先 tsc → 再跑全量测试 → 最后提交）。
8. **别用 PowerShell 管道/重定向来判断行尾**：Windows PowerShell 会把管道与 `>` 的输出重新写成 CRLF，
   于是 `git show HEAD:文件 | ...`、`... > tmp.txt` 量出来的 CR 数是假的（曾据此误报某个文件是 CRLF）。
   要判断仓库里的真实行尾，用 `git add --renormalize <文件>` 看有没有暂存差异（无差异 = 仓库里已是 LF），
   或直接用 Node 读文件字节。

## 7. 测试与提交

- 提交前跑：`tsc --noEmit` + 全量 `vitest` + `test/privacyGuard.test.ts`（禁止真实 QQ号/群号/openid，
  示例只用 `10001` / `654321` / `0123456789ABCDEF0123456789ABCDEF` 这类占位值）；
- 提交信息用中文 Conventional Commits（`feat(...)`、`fix(...)`、`refactor(...)`、`docs:`），**代码与文档分开提交**；
- 版本与变更记录见 [CHANGELOG.md](../CHANGELOG.md)（Keep a Changelog + SemVer），待办见 [TODO.md](../TODO.md)。

## 8. 文档地图

改代码时该更新哪份文档：

| 文档 | 什么时候改 |
|---|---|
| [README.md](../README.md) | 项目定位、技术栈、目标/非目标、权限模型发生变化（保持 ≤250 行，细节放 docs/） |
| [COMMANDS.md](./COMMANDS.md) | 指令用法、按钮语义、示例输出变化 |
| [OPERATIONS.md](./OPERATIONS.md) | 部署方式、启动参数、运营流程示例变化 |
| [CONFIGURATION.md](./CONFIGURATION.md) | 新增/修改环境变量（同时更新 `.env.example`） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层、目录、组件职责变化 |
| [DECISIONS.md](./DECISIONS.md) | 做了需要留痕的技术取舍（追加 ADR，不修改历史条目） |
| [CARD-STANDARD.md](./CARD-STANDARD.md) | 卡片交互规范变化 |
| [ACCEPTANCE.md](./ACCEPTANCE.md) | 新增需要真机验收的交互 |
| [SECURITY.md](./SECURITY.md) | 审计频率 / 处置流程 / 依赖升级口径 / 安全例外变化 |
| [ADMIN-API.md](./ADMIN-API.md) | 管理 API / 管理后台的认证与运行形态、分阶段计划变化 |
| [DATA-COMPLIANCE.md](./DATA-COMPLIANCE.md) | 保留期、删除与导出、PIPIA 口径变化 |
| [ROADMAP.md](./ROADMAP.md) / [TODO.md](../TODO.md) | 计划与已知限制变化 |
