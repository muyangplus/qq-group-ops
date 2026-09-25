# Contributing

感谢参与 QQ Group Ops。

## 开发环境

- Node.js 24+（默认数据库使用内置 `node:sqlite`）
- pnpm
- Git
- Docker / Docker Compose（可选，仅切换 PostgreSQL 时需要）

```bash
corepack enable
pnpm install
```

如果默认 npm 源不可用：

```bash
pnpm install --registry=https://registry.npmmirror.com
```

## 测试与检查

```bash
pnpm test        # Vitest
pnpm typecheck   # TypeScript 类型检查
pnpm build       # 编译到 dist/
```

## 代码风格

- 使用 TypeScript。
- 缩进 2 空格。
- 优先纯函数和可测试服务，不把业务逻辑写进入口文件。
- 平台适配层与业务服务层保持分离。
- 官方接口能力必须先按 [官方文档](https://bot.q.qq.com/wiki/develop/api-v2/) 核对请求体与返回结构，再写实现。
- 提交前至少运行 `pnpm typecheck && pnpm test`。

## 文档约定

- 关键设计取舍写入 [docs/DECISIONS.md](docs/DECISIONS.md)（ADR 格式）。
- 新增/变更环境变量同步更新 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。
- 用户可见变更记入 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased`。
- 真实环境行为变更请同步 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) 的验收步骤。

## 分支与提交

- 主分支：`main`
- 功能分支：`feat/<name>`
- 修复分支：`fix/<name>`
- 文档分支：`docs/<name>`
- 提交信息尽量遵循 Conventional Commits，例如：
  - `feat(audit): add join request approval flow`
  - `fix(rules): handle empty keyword list`
  - `docs(config): update configuration guide`

## Pull Request

- 描述改动背景、方案和验证方式。
- 关联 Issue。
- 确保测试、类型检查和构建通过。
- 不要提交密钥、真实群号、用户隐私数据或聊天原文。

## 安全

安全问题请参考 [SECURITY.md](SECURITY.md)。

## 许可证

贡献代码即表示同意以 Apache-2.0 发布。
