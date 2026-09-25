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

> 在受限沙箱/CI 里 `pnpm` 可能因锁文件或 store 权限失败，此时直接用 node 二进制：
> `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`、
> `node node_modules/vitest/vitest.mjs run --configLoader runner`（`--configLoader runner` 用来避开 `spawn EPERM`）。

## 2. 目录结构

```
src/
├── adapters/     官方 API 客户端、WebSocket 网关、事件映射（对外部世界只在这里）
│                 qqOfficial.ts 只做 barrel：Types / Client / Payload 三个模块
├── core/         领域无关的基础设施：日志、模型、枚举、instrumentation
├── db/           schema 与仓储（同一套 SQL 通过 Queryable 适配 SQLite / PostgreSQL）
├── services/     业务服务（权限、审核、活动、规则、推送、短码、别名、个人资料…）
│   └── commands/ 指令层子模块（本文件重点）
├── runtime.ts    依赖装配 + 回调 renderer 注册
├── gatewayRunner.ts / eventRouter.ts  事件 → 指令 → 回复
└── main.ts       进程入口

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
5. **别把「只在本文件用」的东西顺手 export**：跨模块 import 会把模块表面撑大；搬完可以反向检查一遍。
6. **判断「某名字是否被用到」要先把展开运算符抹平**：`...formatRules(x)` / `[...PROFILE_ENTRY_YEARS]` 里的
   `...` 会让「前面是 `.` 就当成属性访问」的负向前瞻失效，于是漏 import、漏报；
   先 `text.replace(/\.\.\./g, " ")` 再匹配（这个坑在死代码清理与拆服务时各踩过一次）。
7. **一次只搬一个领域**，搬完立刻 `tsc --noEmit`；任何异常直接 `git checkout -- <文件>` 回滚，
   **绝不提交半成品**（顺序：先 tsc → 再跑全量测试 → 最后提交）。

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
| [ROADMAP.md](./ROADMAP.md) / [TODO.md](../TODO.md) | 计划与已知限制变化 |
