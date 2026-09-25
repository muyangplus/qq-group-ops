# 开发指南

面向要改这个仓库的人：怎么跑、代码怎么分层、新指令加在哪、提交前要过什么。

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
├── core/         领域无关的基础设施：日志、模型、枚举、instrumentation
├── db/           schema 与仓储（同一套 SQL 通过 Queryable 适配 SQLite / PostgreSQL）
├── services/     业务服务（权限、审核、活动、规则、推送、短码、别名、个人资料…）
│   ├── commands/ 指令层子模块（本文件重点）
│   └── ...
├── runtime.ts    依赖装配 + 回调 renderer 注册
├── gatewayRunner.ts / eventRouter.ts  事件 → 指令 → 回复
└── main.ts       进程入口
```

## 3. 指令层：门面 + 领域子模块

`AdminCommandService`（`src/services/adminCommands.ts`）是**门面**：它保留全部对外 API（`handle()`、各 `xxxCard()`），
把「路由、装依赖、`ensureCard` 兜底」留给自己，把具体领域逻辑放在 `src/services/commands/*`：

| 文件 | 职责 |
|---|---|
| `commands/support.ts` | 纯工具与常量：按钮构造、解析/格式化、用法文案、字段标签、`CommandResult`/`CardResult` 类型 |
| `commands/context.ts` | `AdminCommandContext`（各服务的只读依赖）+ `CommandHelpers`（门面暴露的小工具：`cardify`、`mention`、展示名、目标解析、`renderNotice`） |
| `commands/<domain>Commands.ts` | 领域逻辑，导出 `fn(ctx, …)` 形式；不直接依赖门面类，避免循环引用 |

已拆出的领域：`alias`、`whois`、`notify`、`profile`、`testmenu`/`testat`。

### 新增一个领域模块的步骤

1. 在 `src/services/commands/<domain>Commands.ts` 里写 `export function xxxCard(ctx: AdminCommandContext, …): CommandResult`；
2. 需要新依赖就往 `AdminCommandContext` 加字段，需要新工具就往 `CommandHelpers` 加签名并在门面 `context()` 里实现；
3. 门面对外的方法保留成**一行包装**：`public xxxCard(...) { return xxxCard(this.context(), ...); }`
   —— 这样 `runtime.ts` 的回调 renderer 与测试都不用改；
4. `dispatchCommand` 里的 `case` 直接调模块函数；
5. 纯搬迁：**不改文案、按钮 id、回调 data、权限与行为**；测试只允许「搬家」不允许改弱。

## 4. 卡片与交互规范

- 所有指令输出（含错误、用法提示）都必须是卡片：见 [CARD-STANDARD.md](./CARD-STANDARD.md)；
- 导航 / 查看 / 翻页 / 开关 / 枚举用**回调按钮**（`cb:<namespace>:<action>[:args]`），
  需要参数或不可逆的动作用**指令按钮**；回调 renderer 必须自己再校验一次权限；
- 排版硬约束：一行按钮文字合计 ≤12 字、单个 ≤10 字、整盘 ≤5 行；
- 平台**没有**「更新原卡片」接口：回调后只能主动发新卡，旧卡留在聊天记录；
- 群里要 @ 到人用 Markdown 卡片里的 `<@!openid>`（真机验证有效）；`@全体成员` 官方不支持。

## 5. 测试与提交

- 改动必须带测试：服务层放 `test/<模块>.test.ts`，指令层放 `test/commands/*`（或现有 `test/adminCommands.test.ts`）；
- 提交前跑：`tsc --noEmit` + 全量 `vitest` + `test/privacyGuard.test.ts`（禁止真实 QQ号/群号/openid，
  示例只用 `10001` / `654321` / `0123456789ABCDEF0123456789ABCDEF` 这类占位值）；
- 提交信息用中文 Conventional Commits（`feat(...)`、`fix(...)`、`refactor(...)`、`docs:`），**代码与文档分开提交**；
- 版本与变更记录见 [CHANGELOG.md](../CHANGELOG.md)（Keep a Changelog + SemVer），待办见 [TODO.md](../TODO.md)。
