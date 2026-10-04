# 安全与依赖审计（Security）

> 面向**工程实现**：漏洞审计多久做一次、发现了怎么处置、依赖怎么升级、凭据放哪。
> 数据层面的合规口径（保留期、删除与导出、PIPIA）见 [DATA-COMPLIANCE.md](./DATA-COMPLIANCE.md)；
> 部署、备份与恢复见 [OPERATIONS.md](./OPERATIONS.md)；开发命令见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 1. 审计频率与入口

| 方式 | 频率 | 入口 | 结果落点 |
|---|---|---|---|
| 自动 | 每周一 03:17 UTC | GitHub Actions **安全审计**（`.github/workflows/security-audit.yml`） | 失败自动开 / 更新 issue（标题含「依赖审计失败」），完整报告存 artifact |
| 手动 | 发版前、升级依赖后、收到漏洞通告时 | `pnpm check:audit` | 本地终端输出 |
| 人工 | 每季度 | 第 5 节的检查清单 | 勾选结果记进 issue / PR 描述 |

`pnpm check:audit` = `pnpm audit --audit-level=high`：**只有 high / critical 算失败**；
`moderate` 及以下不阻塞，但要记进当次 issue，攒到批量升级一起处理。

## 2. 处置流程（发现漏洞后）

1. **判定可达性**：这个包进不进运行时？`dependencies` 与 `devDependencies` 分开看
   —— 本项目运行时只有 `fastify` / `pg`，devDependencies 只影响开发机与 CI；
2. **能升级就升级**：`pnpm up <包>@<安全版本>`（只动这一个包，避免顺手带上一堆无关改动）；
3. **跑回归**：`pnpm typecheck` → `pnpm test` → `pnpm build`（与 CI 同一套命令）；
4. **升不动就记例外**：主版本破坏性变更、或上游没修时，在第 6 节写清
   「包名 / 版本范围 / 为什么不升 / 补偿措施 / 复查日期」；
5. **留痕**：issue 记录动作，提交信息用 `fix(安全): …` / `chore(依赖): …`。

时间口径（尽力而为的目标，不是 SLA）：critical 24 小时内评估、72 小时内处置或记例外；
high 一周内处置或记例外。

## 3. 依赖升级流程（常规）

- **安全修复**：小步升级，一次一个包，`pnpm typecheck && pnpm test && pnpm build` 全绿再提交；
- **批量升级**：先读 changelog，再按「devDependencies → dependencies」顺序升，进同一个提交，全量回归；
- **主版本升级**（Node、Fastify、TypeScript、vitest）单独一个提交，提交信息里写清破坏性变更点；
- **锁文件必须一起提交**：CD 是按 `pnpm-lock.yaml` 安装的，锁文件不同步会出现「本地能跑、线上装出来不一样」；
- **升级后必须实跑一次**：`pnpm build && node dist/main.js --check`（CI 绿 ≠ 能启动；`--check` 是启动前自检）；
- **不必追最新**：`pnpm outdated` 出来的次要版本可以攒着，安全相关和 EOL 相关的优先。

## 4. 密钥与凭据

- 所有密钥只从**环境变量 / Docker secrets** 注入；`.env` 与 `data/` 已在 `.gitignore`；
  仓库里不出现任何 token / openid / 群号明文（有自动测试守着这条，见 `test/privacyGuard.test.ts`）；
- 平台凭据（`APP_ID` / `APP_SECRET` / `TOKEN`）与数据库口令都**只在启动时读**，轮换后重启生效；
  能热改的只有系统配置里那些**非核心项**（保留期 / 周期 / 定时发言开关 / 管理后台会话与令牌 TTL /
  限流等，共 19 项，见 [CONFIGURATION.md](./CONFIGURATION.md)「系统配置（热改项）」）——
  **不含任何凭据**，改它们不需要也不能暴露密钥（ADR-0066）；
- 本地凭据放进系统凭据管理器（Windows Credential Manager / `git credential`），不要落进脚本或提交；
- **疑似泄露**：① 平台后台重置 → ② 改宿主机环境变量并重启 → ③ 翻 `audit_log` 与启动日志
  确认没有异常调用 / 异常绑定 → ④ 需要时按第 2 节记一条复盘。

## 5. 检查清单

| 检查项 | 频率 | 怎么做 | 通过判据 |
|---|---|---|---|
| 依赖漏洞 | 每周 + 发版前 | `pnpm check:audit` | 无 high / critical，或已在第 6 节记例外 |
| 仓库无凭证泄漏 | 每次提交 | `test/privacyGuard.test.ts` + 人工扫 `git diff` | 无 token、无真实标识（openid / 群号 / QQ号 / 学号） |
| 外部输入校验 | 涉及外部输入的改动 | 单测覆盖非法值分支 | 非法值被拒绝且**不改库**（例如规则字段解析） |
| 权限校验 | 新增指令 / 回调 | 单测 + 真机 | 服务端校验（客户端限制不算），越权返回「权限不足」 |
| 不可逆动作留痕 | 新增不可逆动作 | 单测断言审计行 | 写 `audit_log`；平台级动作 `groupId=""` |
| 日志不含敏感信息 | 改动日志时 | 人工审 + 抽查日志文件 | 不打 token、不打消息原文/答案、不打完整学号 |
| 数据保留与删除 | 每季度 | 对照 [DATA-COMPLIANCE.md](./DATA-COMPLIANCE.md) 的保留期表 | 实现与文档一致（不一致就改文档或改代码） |
| 备份可恢复 | 每季度 | [OPERATIONS.md](./OPERATIONS.md) 的备份恢复演练 | 能从备份恢复并 `--check` 通过 |
| 锁文件同步 | 每次改动依赖 | CI `pnpm install --frozen-lockfile` | CI 通过 |
| 部署产物一致 | 每次发版 | CD 产物 = 本地 `pnpm build` | `/status proc` 的版本号与发布版本一致 |
| 依赖供应链策略 | 每次安装 | pnpm 安装时的 lockfile 策略校验输出 | 安装时无 supply-chain 告警 |

## 6. 已知例外

> 记录「知道有风险但暂时不修」的项，一行一条；复查日期到了要重新评估。
> 新增格式：`包名 / 版本范围 / 原因 / 补偿措施 / 复查日期`。

- （当前无）
