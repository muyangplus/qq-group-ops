# CD：打 tag 发 Release 自动发布到 FTP

> 工作流文件：[`.github/workflows/cd-ftp.yml`](../.github/workflows/cd-ftp.yml)
> 相关：[`docs/OPERATIONS.md`](./OPERATIONS.md)（部署与运行）、[`docs/CD.md`](./CD.md)（本文件）、
> [`.github/dependabot.yml`](../.github/dependabot.yml)（依赖与 Action 的安全更新）

## 1. 它什么时候跑

| 触发 | 说明 |
|---|---|
| **Release published** | 在 GitHub 上把 tag 发布成 Release 时自动跑（`release: types: [published]`）——注意**只推 tag 不建 Release 不会触发** |
| **手动触发** | Actions → `CD · FTP 发布` → Run workflow，可填 `ref`（tag / commit），用于回滚或补发 |

部署来源解析顺序：`Release 的 tag` → 手动输入的 `ref` → 当前分支。
同一次发布**同时只允许一个部署**（`concurrency` 按 ref 排队），避免并发写坏服务器目录。

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

工作流在部署前显式**白名单组包**（`dist-deploy/`）：

```
dist/  src/  scripts/  docs/
package.json  pnpm-lock.yaml  tsconfig.json  .env.example
README.md  CHANGELOG.md  Dockerfile  docker-compose.yml
```

**绝不带上服务器**（组包不拷贝 + Action `exclude` 双层兜底）：
`.env` / `.env.*`、`data/`、`logs/`、`test/`、`.git*`、`.github/`、`node_modules/`、`coverage/`、`*.log`。

`dangerous-clean-slate` 保持默认关闭：**不会删除服务器上多余的文件**（不会误删服务器自己的 `.env`、`data/`）。

服务器端准备：

```bash
# 目标目录（FTP_SERVER_DIR）里首次准备
cd /apps/qq-group-ops
pnpm install --prod      # 只装运行依赖（本项目运行时依赖 pg；fastify 也在这里）
# 自己放一份 .env（从 .env.example 抄），并确保 data/ 与 logs/ 目录存在且可写
mkdir -p data logs
```

## 4. 安全审计清单

### 4.1 本仓库已落实（`test/workflows.test.ts` 会守住这些不变量）

- **最小权限**：工作流为 `permissions: contents: read`，不使用 `GITHUB_TOKEN` 的写权限；
- **checkout 不落凭据**：所有 checkout 都带 `persist-credentials: false`；
- **凭据只走 secrets**：FTP 服务器 / 账号 / 密码三项必须来自 `secrets.*`（测试会断言不是字面量）；
- **默认加密传输**：协议默认 `ftps`（显式 TLS），只有显式配置变量才退回明文 `ftp`；
- **人工放行**：部署任务挂在 `production-ftp` Environment 上，可配 required reviewers；
- **部署前门禁**：`pnpm typecheck` + `pnpm test` + `pnpm build` 全过才碰服务器；
- **并发保护**：同一 ref 的部署排队执行，避免并发写坏目录；
- **白名单组包 + 排除兜底**：敏感文件（`.env` / `data/` / `logs/`）不会被上传；
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

1. Actions → `CD · FTP 发布` → **Run workflow**，`ref` 填要回滚到的 tag（例如 `v0.16.0`）；
2. 走完门禁 + 审批后，旧版本文件会被重新上传（注意：**不会自动删除**新版带来的文件，必要时手动清理）；
3. 服务器上 `pnpm install --prod` → 重启进程；
4. 如果改动涉及数据库结构（例如 0.16.0 的 `punishActions` 是键值表，无迁移风险），优先用备份恢复。

## 6. 排障

| 现象 | 先看 |
|---|---|
| Release 发布了但工作流没跑 | 触发的是 **Release published** 而不是 tag push；检查是否建了 Release（draft 不算） |
| `缺少配置：FTP_SERVER_DIR(variable)` | 忘了配 Variable（不是 Secret），见 §2.2 |
| 连接失败 / TLS 报错 | `FTP_PROTOCOL` 与服务端是否匹配（显式 FTPS 通常是 21 端口 + `AUTH TLS`）；服务器证书是否有效 |
| 上传成功但服务器跑不起来 | `dist/` 是否上传（门禁里 `pnpm build` 成功才有）、服务器是否 `pnpm install --prod`、`.env` 是否自己放好 |
| 部署到一半失败 | 组包是白名单、`dangerous-clean-slate` 关闭，所以不会删服务器文件；修好配置重跑即可 |
| 想只部署某个分支 | 手动 dispatch 时 `ref` 填分支名（Environment 的 branch 限制要放行） |
