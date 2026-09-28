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

## 行文：不写自证式声明

自证式声明 = 对「这个产物自己」的冗余解释，读者已经知道的事不要再说。一律去掉，代码注释 / 卡片文案 / 文档 / 提交信息都适用。

| 反例 | 为什么删 | 正确写法 |
|---|---|---|
| 只有全局超管可见的卡上写「该命令仅全局超管可用」 | 能看到的只有超管，这句话没有信息量 | 直接写功能本身 |
| Release / CHANGELOG 里写「本次 Release 会触发 CD 部署」 | 读者看的是这个版本改了什么 | 只写变更；部署机制写在 `docs/CD.md` |
| 「已连续 3 次检测到，说明上传完成」 | 内部判定过程不是用户信息 | 「（已就绪）」 |
| 注释里复述代码（`// 返回 true`）、文档里复述文件名（`（本文件）`） | 同义反复 | 删掉 |

提交信息同理：只写「改了什么、为什么」，不写「这个提交不会影响 X」这类自证。
