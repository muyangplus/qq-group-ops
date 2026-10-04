# CD：打 tag 发 Release 自动发布到 FTP

> 工作流文件：[`.github/workflows/cd-ftp.yml`](../.github/workflows/cd-ftp.yml)、
> [`ci.yml`](../.github/workflows/ci.yml)、[`docs-guard.yml`](../.github/workflows/docs-guard.yml)、
> [`security-audit.yml`](../.github/workflows/security-audit.yml)
> 相关：[`docs/OPERATIONS.md`](./OPERATIONS.md)（部署与运行）、
> [`.github/dependabot.yml`](../.github/dependabot.yml)（依赖与 Action 的安全更新）

## 1. 它什么时候跑

| 触发 | 说明 |
|---|---|
| **Release published** | 在 GitHub 上把 tag 发布成 Release 时自动跑（`release: types: [published]`）——注意**只推 tag 不建 Release 不会触发** |
| **手动触发** | Actions → `CD · FTP 发布` → Run workflow，可填 `ref`（tag / commit），用于回滚或补发 |

部署来源解析顺序：`Release 的 tag` → 手动输入的 `ref` → 当前分支。
同一次发布**同时只允许一个部署**（`concurrency` 按 ref 排队），避免并发写坏服务器目录。
部署门禁默认**复用同一 commit 的 CI 结论**（详见 **§8**）。

> 想改成「推 tag 就部署」：把 `release:` 那段换成
> `push: { tags: ["v*"] }`。**不要两者都开**，否则同一次发布会跑两遍。

## 2. 需要在 GitHub 配置什么

仓库 Settings → **Secrets and variables → Actions**。

### 2.1 Secrets（必须，敏感）

| Name | 说明 |
|---|---|
| `FTP_SERVER` | FTP/FTPS 主机名或 IP（例：`ftp.example.com`） |
| `FTP_USERNAME` | FTP 账号（**建议专号专用**，只允许写目标目录） |
| `FTP_PASSWORD` | 该账号的密码；**不要**用主账号密码，泄漏了只影响这个目录 |

### 2.2 Variables（必须/可选，非敏感）

| Name | 必须 | 说明 |
|---|---|---|
| `FTP_SERVER_DIR` | ✅ | 服务器目标目录，**以 `/` 开头并结尾**（例：`/apps/qq-group-ops/`）。工作流会在缺失时报错退出 |
| `FTP_PROTOCOL` | 可选 | `ftps`（默认，显式 TLS）/ `ftp`（明文，不推荐）/ 服务器支持隐式 TLS 时按需 |
| `FTP_PORT` | 可选 | 默认 `21`；FTPS 显式模式通常仍是 21 |

### 2.3 Environment（强烈建议）

工作流里的部署任务挂在 **`production-ftp`** 这个 Environment 上。在
Settings → **Environments** → 新建 `production-ftp` 后可以：

- 打开 **Required reviewers**，指定 1–2 个人 → 部署前必须人工点 Approve（等于给发布加了二次确认）；
- 配置 **Wait timer**（例如 5 分钟）做冷静期；
- 限制 **Deployment branches and tags**（例如只允许 `v*` tag）；
- **把上面 3 个 Secrets 配在 Environment 作用域**（而不是仓库作用域）：这样只有审批通过后的部署任务才拿得到凭据，构建/测试任务完全看不到。

## 3. 上传了什么 / 没上传什么

部署的是**运行产物**，不是仓库快照。工作流在部署前显式白名单组包，**分两段上传 2 个文件**
（ADR-0065；两段式与「标记最后落地」的结构沿用 ADR-0057）：

第一段（`incoming/deploy-<版本>.tgz`，一个包）：

```
dist/                 # 编译产物；`node dist/main.js` 自包含（不引 ../src）
dist/build-info.json  # 构建自证：版本 + commit + 构建时间 + dist 指纹（门禁里生成，见下）
web/dist/             # 管理前台静态资源（Vite 产物，由服务器上的 nginx 托管；门禁里先 vue-tsc 再 vite build）
scripts/              # build-class-index.mjs / classIndex.mjs（`pnpm class:index`，纯 node 内置模块）
pnpm-lock.yaml        # 锁定依赖版本，服务器上 pnpm install --prod
.env.example          # 配置对照模板（不含真实值）
```

第二段（`incoming/deploy-<版本>.json`，**只有一个文件**）：

```
deploy-<版本>.json    # 投递标记：版本 / commit / sha256 / dist 指纹 / builtAt —— 最后落地（见下）
```

**为什么投递标记要单独放最后一段**：机器人侧 `DeployInstaller` 扫到它才动手 ——
先按 `sha256` 校验包（防半传），再解包、用 `distFingerprint()` 与包内 `build-info.json` 自证，
最后整目录替换 `dist/` / `web/dist/` / `scripts/` 并重启。标记没落地 = 「还没传完」，
机器人什么都不会做（旧进程继续服务）；标记一落地，包一定已经完整在服务器上了。

**为什么生成 `dist/build-info.json`**：版本号只是「CD 跑过」的标记，可能骗人
（0.27.3 真机：`package.json` 是新的，`dist/adminApi/backend.js` 却是旧的）。把
**版本 + commit + 构建时间 + dist 指纹**钉进产物，机器人在**替换之前**就能用
`distFingerprint()` 对一遍 —— 半传 / 混装 / 坏包全被拦在替换之前。
关键实现细节：指纹**不含 `build-info.json` 自己**，且 CD 里「删 `.map`」这一步必须在
**算指纹之前**（否则指纹按带 map 的 dist 算、传上去的是不带 map 的，自证永远不过）。

> **不再需要同步状态**（这是相对老方案最大的变化）：老方案是逐文件同步，
> 必须靠 `ftp-sync-state-*.json` 记住「上次传过什么」才能只传差异 —— 代价是
> 「服务器上的文件被别的路径改过（回滚 / 机器人自解包）时，下一轮上传会被静默跳过」，
> 真机因此出现过「版本号是新的、代码是旧的」。现在每轮只传 2 个文件（耗时不再由文件数决定），
> **每次都是全量**，不存在「同步状态与服务器实况不一致」这种失败模式；
> 机器人自己动过 `dist/` 之后还会主动删掉旧的 `ftp-sync-state-*.json`（那份状态对它已无意义，
> 保留只为兼容）。两段仍各用**不同**的 `state-name`（`ftp-sync-state-package.json` /
> `ftp-sync-state-marker.json`）并保持 `dangerous-clean-slate: false` ——
> 这个 Action 是双向同步，共用一份状态时会把对方的文件判成「本地没有 → 从服务器删掉」，
> 2026-10-02 的 v0.24.0 发布就这么删过服务器上的 `dist/` / `scripts/` / `web/` /
> `pnpm-lock.yaml`（ADR-0057 的事故与修正）。`test/workflows.test.ts` 已把
> 「所有 FTP 步骤必须显式声明 `state-name` 且互不相同」钉成断言。
>
> **应急开关**：`workflow_dispatch` 的 `mode=files` 会退回老的逐文件上传
> （`dist-deploy/` + `dist-marker/package.json` 两段，同样两个 state-name）。
> 它与包模式**共用同一个构建产物**（也带 `build-info.json`），只是不走 `incoming/` 那套
> 「sha256 + 自证 + 整目录替换」，而是退回「部署监测按版本 + 指纹判据」的老路径 ——
> 是「包化路径出问题时别把机器人堵死」的最小兜底，别长期用。
> ⚠️ **它同时是「首跳」的正规做法**：服务器上还是 0.27.x（没有 `DeployInstaller`）时，
> 包模式的产物只有新代码解得开、而新代码又得先上服务器 —— 所以带包化的那个版本要用
> `mode=files` 交付，之后才走包模式。首跳的完整步骤（含「Release 触发的那次包模式 CD 已经在
> `incoming/` 留了一个包、新进程起来后会被再应用一次」怎么处理）见
> [OPERATIONS.md](./OPERATIONS.md) 的「手工救急：包化部署」。

**不上服务器**：

- `src/`、`tsconfig.json`：生产运行不需要（`dist` 自包含）；服务器上要改代码请改仓库再走一次发布；
- `docs/`、`README.md`、`CHANGELOG.md`、`Dockerfile`、`docker-compose.yml`：仓库侧资料，运行不需要；
- `*.map`：没有 `src` 时 sourcemap 无法对照，**构建阶段就删除**（体积少一半，且必须在算指纹之前）；
  若你希望在服务器上看可读堆栈，把 `src/` 加进白名单并去掉删 `.map` 那行即可；
- 敏感与噪音：`.env` / `.env.*`、`data/`、`logs/`、`test/`、`.git*`、`.github/`、`node_modules/`、`coverage/`、`*.log`
  —— 组包不拷贝 + Action `exclude` 双层兜底。

`dangerous-clean-slate` 保持默认关闭：**不会删除服务器上多余的文件**（不会误删服务器自己的 `.env`、`data/`）。

服务器端准备：

```bash
# 目标目录（FTP_SERVER_DIR）里首次准备
cd /apps/qq-group-ops
pnpm install --prod      # 只装运行依赖（本项目：pg、fastify）
# 自己放一份 .env（从 .env.example 抄），并确保 data/ 与 logs/ 目录存在且可写
mkdir -p data logs
pnpm start               # = node dist/main.js；需要班级索引时先 pnpm class:index
```

> 每次发布只同步变化文件（Action 会在服务器上留一份 `.ftp-deploy-sync-state.json`），
> 所以"只发运行产物"的另一个好处是：同步快、不易把仓库侧的临时文件带上生产。

## 4. 安全审计清单

### 4.0 Dependabot PR 怎么审（对应 TODO D6）

Dependabot 每周会给 npm 依赖与 GitHub Actions 开分组 PR（`.github/dependabot.yml`）。判定规则：

| PR 类型 | 怎么处理 |
|---|---|
| **devDependencies**（vitest / yaml / tsx / typescript 等） | CI（typecheck + 全量测试）全绿即可合并；major 也可合，但要看 CHANGELOG 有无行为变更 |
| **`@types/node`** | **大版本必须与运行时 Node 一致**（`engines.node` 与 CI matrix 都是 24）→ major 已在配置里 `ignore`；小版本可以合。理由：类型升到 26 后，类型检查会放行 Node 24 不存在的 API，属于"过了 CI、线上炸" |
| **生产依赖**（`pg`、`fastify`） | 合并前看上游 CHANGELOG（尤其 fastify 的 major：插件/路由 API 变更），合并后必须真机跑一遍（机器人能起来 + 收得到事件） |
| **GitHub Actions：`ci.yml` 里用到的**（checkout / setup-node / pnpm-action-setup） | 由 CI 自动验证 —— PR 上 CI 绿即可合并 |
| **GitHub Actions：只在 `cd-ftp.yml` 里用到的**（upload/download-artifact、FTP-Deploy-Action） | CI 覆盖不到（CD 只在 Release/手动触发时跑）→ 合并后**手动 `Run workflow` 跑一次**确认能上传；不放心就先不动，需要时再单独升 |

> 想要更严的供应链策略：把 `.github` 里的 `uses:` 钉到 commit SHA（`owner/repo@<40 位 SHA> # vX.Y.Z`），
> Dependabot 会继续为这些 pin 开 PR；`test/workflows.test.ts` 只要求"钉在版本标签上"，
> 换成 SHA + 注释同样能通过。

### 4.1 本仓库已落实（`test/workflows.test.ts` 会守住这些不变量）

- **最小权限**：工作流为 `permissions: contents: read`，不使用 `GITHUB_TOKEN` 的写权限；
- **checkout 不落凭据**：所有 checkout 都带 `persist-credentials: false`；
- **凭据只走 secrets**：FTP 服务器 / 账号 / 密码三项必须来自 `secrets.*`（测试会断言不是字面量）；
- **默认加密传输**：协议默认 `ftps`（显式 TLS），只有显式配置变量才退回明文 `ftp`；
- **人工放行**：部署任务挂在 `production-ftp` Environment 上，可配 required reviewers；
- **部署前门禁**：`pnpm typecheck` + `pnpm test` + `pnpm build` 全过才碰服务器；
- **并发保护**：同一 ref 的部署排队执行，避免并发写坏目录；
- **白名单组包 + 排除兜底**：只上传运行产物（`dist` / `scripts` / 依赖清单 / `.env.example`），
  敏感文件（`.env` / `data/` / `logs/`）、测试与 sourcemap 都不会上传；
- **审计线索**：每次运行在 Summary 里写清 `ref` / `commit` / 触发方式 / 执行者 / 目标目录；
- **Action 钉版本**：所有 `uses:` 都钉在版本标签上（`@v4`、`@v4.3.5`），禁止 `@main`；
- **禁用 `pull_request_target`**：避免典型的提权 + secrets 泄露入口；
- **依赖与 Action 持续更新**：`.github/dependabot.yml` 每周给 npm 依赖与 GitHub Actions 开 PR（走 CI 审核）。

### 4.2 建议你在服务器/平台侧再做这些

1. **别用明文 FTP**：`FTP_PROTOCOL` 保持 `ftps`；服务器若不支持 FTPS，优先换 **SFTP/SSH**（可用 `wlixcc/SFTP-Deploy-Action` + SSH 私钥 secret，安全模型更好）；
2. **专用账号 + 目录限制**：FTP 账号只允许访问目标目录，禁用 shell，禁用匿名登录；
3. **IP 白名单**：如果 FTP 服务端能限制来源，把 GitHub Actions 出口 IP 加白（Actions 出口 IP 会变，必要时走自建 runner）；
4. **轮换密钥**：FTP 密码与 `WEBHOOK_SECRET` / `QQ_BOT_CLIENT_SECRET` 定期轮换；离职交接时立即换；
5. **保护 tag**：Settings → Rules → 给 `v*` 加保护，只有维护者能推 tag（tag = 生产发布入口）；
6. **Action 钉到 commit SHA**（进阶）：`@v4` 这类标签理论上可被上游重指，追求供应链安全就把 `uses:` 改成
   `owner/repo@<40 位 SHA> # vX.Y.Z`；Dependabot 会持续给这些 pin 开升级 PR；
7. **服务器端备份**：部署前对目标目录做一次快照（tar/rsync 快照或数据库文件备份），回滚更快；
8. **单实例**：Webhook 模式下只能单实例（见 OPERATIONS），部署时先停服务再同步更稳。

## 5. 回滚

**首选：机器人自己回滚**（ADR-0065）—— `data/packages/` 里保留着最近 **3 个**应用成功的包，
回滚 = **重新应用上一个包**（同一安装器、同一套 sha / 指纹自证、同一套整目录替换与重启）：

1. 机器人里 `/status proc`（平台超管）→ 点「回滚上一版」；或管理后台「状态」页 → 点「回滚到 vX」；
2. 也可以走 API：`POST /api/deploy/rollback`（平台超管 240，scope `write:deploy`），
   回执写 `vX → vY`；
3. 回滚会作废 `ftp-sync-state-*.json`，所以**下一轮 CD 自动全量**（一次性，不是每次都全量）。

**备选：重新发布一个旧 tag**（包化流程同样适用）：

1. Actions → `CD · FTP 发布` → **Run workflow**，`ref` 填要回滚到的 tag（例如 `v0.16.0`）；
2. 走完门禁 + 审批后，旧版本的产物包会重新上传，机器人自解并重启；
3. 注意：整目录替换只覆盖 `dist/` / `web/dist/` / `scripts/` 这三个面，
   服务器上多出来的**其它**文件不会被删 —— 改动文件清单时手工清理遗留文件；
4. 如果改动涉及数据库结构（例如 0.16.0 的 `punishActions` 是键值表，无迁移风险），优先用备份恢复。

手工救急（手动放包 / 手动回滚 / 清同步状态 / `grep -c` 三连）见
[OPERATIONS.md](./OPERATIONS.md) 的「手工救急：包化部署」一节。

## 6. 排障速查

| 现象 | 先看 |
|---|---|
| Release 发布了但工作流没跑 | 触发的是 **Release published** 而不是 tag push；检查是否建了 Release（draft 不算） |
| `Timeout when trying to open data connection to ***:<端口>` | **被动模式**问题，见 §7 逐条检查（端口范围 / 防火墙 / 云安全组 / NAT 的 `ForcePassiveIP`） |
| `缺少配置：FTP_SERVER_DIR(variable)` | 忘了配 Variable（不是 Secret），见 §2.2 |
| 连接失败 / TLS 报错 | `FTP_PROTOCOL` 与服务端是否匹配（显式 FTPS 通常是 21 端口 + `AUTH TLS`）；服务器证书是否有效 |
| 上传成功但服务器跑不起来 | `dist/` 是否上传（门禁里 `pnpm build` 成功才有）、服务器是否 `pnpm install --prod`、`.env` 是否自己放好 |
| 堆栈全是 `dist/xxx.js` 看不出源码行 | 只发运行产物时 `.map` 已删除；需要可读堆栈就把 `src/` 加进白名单并去掉删 `.map` 那步，运行时加 `NODE_OPTIONS=--enable-source-maps` |
| 服务器上残留旧文件 | 部署不会删除多余文件（`dangerous-clean-slate` 关闭）；改过文件清单后手动清理一次 |
| 部署到一半失败 | 组包是白名单、`dangerous-clean-slate` 关闭，所以不会删服务器文件；修好配置重跑即可 |
| 想只部署某个分支 | 手动 dispatch 时 `ref` 填分支名（Environment 的 branch 限制要放行） |
| 日志里看不到逐个文件的传输细节 | `log-level` 已从 `verbose` 收到 `standard`（打包后只有 2 个文件）；排查 FTP 时临时改回 `verbose` |

## 7. FTP 被动模式排障（首次联调必看）

失败长这样：

```
Making changes to N files/folders to sync server state     ← 登录、列目录、建目录都成功
Error: None of the available transfer strategies work.
       Last error response was 'Error: Timeout when trying to open data connection to ***:39575'
```

**含义**：FTP 的控制连接（21）通、账号有写权限，但**传文件要另开一条数据连接**（被动模式 PASV/EPSV），
服务器回了端口（示例里的 `39575`）而客户端连不上 → 超时。Actions 里的 `uses:` 也改不了这一点，
**必须在服务端/网络层修**。（GitHub runner 无法用主动模式 PORT —— runner 不接受入站连接。）

按顺序检查：

1. **服务端被动端口范围已配置**（pure-ftpd 示例）：
   ```ini
   PassivePortRange          39000 40000
   # 服务器在 NAT/路由器后面时**必须**打开下面这行，否则 PASV 回内网地址，客户端连不上
   # ForcePassiveIP          <服务器公网 IP>
   ```
   改完 `systemctl restart pure-ftpd`（宝塔面板改完记得点保存并重启服务）。

2. **防火墙 / 云安全组放行这段 TCP 端口**（只有 21 通是不够的）：
   ```bash
   # firewalld
   firewall-cmd --permanent --add-port=39000-40000/tcp && firewall-cmd --reload
   # ufw
   ufw allow 39000:40000/tcp
   # iptables
   iptables -I INPUT -p tcp --dport 39000:40000 -j ACCEPT
   ```
   **云安全组**（阿里云/腾讯云/宝塔的「安全」页）同样要放行 `39000-40000/tcp`；
   来源可以先限自己 IP + GitHub Actions 出网 IP（Actions 出口 IP 不固定，最省事是 `0.0.0.0/0` 后按日志再收紧）。

3. **从外部验证数据端口真的通**（在国内机器上执行，或让同事在别的网络试）：
   ```bash
   # 先看服务器回哪个 IP/端口（登录后发 PASV）
   ftp -p <host> 21     # 登录后执行：quote PASV
   # 再直接连那个端口，能建立 TCP 就算通了
   nc -vz <host> <PASV 返回的端口>
   ```

4. **在 Actions 里空跑验证**（不写服务器文件）：
   Actions → `CD · FTP 发布` → Run workflow → 勾 **`dry_run`** → 观察是否还报数据连接超时。
   工作流带 `timeout: 120000`，`dry_run` 会走完 PASV 数据连接与差异比对。
   `log-level` 平时是 `standard`（打包成 2 个文件后日志量没必要那么大，也少占排队时间）；
   要连 PASV/EPSV 交互细节一起看，临时把它改回 `verbose`。

> 如果这段端口**实在没法开**（例如服务器在严格的内网策略后面），换 **SFTP/SSH** 是更省心的路：
> 单条连接、无被动端口、无 NAT 伪装问题；代价是要在服务器上放一把部署专用 SSH 公钥，
> 并给仓库加 `SSH_PRIVATE_KEY` 等 Secrets（见 §4.2 第 1 条）。

## 8. CI/CD 触发策略：什么会触发、什么只跑守卫

> 口径见 [ADR-0067](./DECISIONS.md)。标题里的「省」不是靠少测，而是靠**不重复测**：
> 近 200 次 run 里 CI 171 次、push 触发 167 次，一半以上来自「纯文档 push 也跑全量门禁」
> 与「一次改动分两次 push」。

### 8.1 一张表

| 你改了什么 | 跑什么 | 为什么 |
|---|---|---|
| `src/**`、`test/**`、`web/**`、`.github/**`、`package.json`、`pnpm-lock.yaml`、`.env.example`… | **CI：全量门禁**（typecheck + 全量 vitest + build + 前端三项） | 代码路径必须全量验；`.env.example` 也在部署白名单里 |
| **只有** `docs/**` 与 `*.md`（README / CHANGELOG / TODO / ADR…） | **文档守卫：秒级**（`test/privacyGuard.test.ts` + `test/workflows.test.ts`） | 纯文档不该白等 2–3 分钟，但「CHANGELOG 里写了真实群号」必须有人拦 |
| 两者都改 | 两个都跑 | 门禁不削弱 |
| 连续 push 同一分支 | 只跑**最后一次**（`concurrency.cancel-in-progress`） | 中间那次的结果已经过时 |
| 建 Release（published）或手动 dispatch CD | **CD**：默认**复用同一 commit 的 CI 结论**（只装依赖 + 构建 + 自证），查不到绿 CI 就回落全套门禁；`full_gate=true` 强制全套 | 内容是同一份，重复跑只是等 2–3 分钟 |
| 只推 tag、不建 Release | 什么也不跑 | 触发面是 `release: published`（ADR-0057 起） |

**边界（不许动的）**：代码 push 必须跑全量门禁；**发布前门禁不削弱**；文档路径只跳过**全量**、
**不跳过守卫**（`test/privacyGuard.test.ts` 扫 README / CHANGELOG / `.env.example`，并对全仓库做
形状规则检查）。

### 8.2 流程侧：本地提交不推送（省得最多）

0.29.0 起按用户口径执行：**本地提交之后不推送**；代码与文档照样分开提交，但都留在本地，
**发版时把该版本的全部提交一次性 push** —— 于是一次发版只产生 **1 次 CI（main push）+
1 次 CD（Release published）**。

代价与纪律（必须一起遵守）：

- 未推送的提交**没有远端备份**（发版前别只留在一台机器上）；
- CI 只会跑最后一次 → **发版前本地必须自己跑过** `pnpm typecheck` + `pnpm test`
  （有前端改动再加 `pnpm web:typecheck` / `web:test` / `web:build`）—— 不能指望 CI 替我们提前发现；
- 如果分支保护要求「CI / test」这个 check，**纯文档 PR 会等不到它**（`ci.yml` 被 `paths-ignore` 跳过）：
  要么给文档守卫也加一条 required check，要么把文档改动并进代码 PR。

### 8.3 紧急开关与非默认路径

- 手动 dispatch CD 时可指定：`ref`（补发 / 回滚旧 tag）、`dry_run`（只试连比对，不写文件）、
  `mode=files`（退回逐文件上传）、`full_gate=true`（不复用 CI）；
- 查 CI 结论失败（API / 权限 / 网络）时**按「没有绿 CI」处理**：宁可多跑一遍门禁，不可少跑；
- 安全审计（`security-audit.yml`）与 Dependabot 都是**每周**一次 + 手动 dispatch，不天天开 run / PR；
- 本地复现守卫（不用等 CI）：

  ```bash
  node node_modules/vitest/vitest.mjs run --configLoader runner test/privacyGuard.test.ts test/workflows.test.ts
  ```

