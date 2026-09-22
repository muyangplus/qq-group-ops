# Contributing

感谢参与 QQ Group Ops。

## 开发环境

- Python 3.11+（推荐 3.11 或 3.12）
- Git
- Docker / Docker Compose（可选）

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux / macOS
source .venv/bin/activate

pip install -e ".[dev]"
```

## 测试

当前测试使用标准库 `unittest`，不依赖第三方测试框架：

```bash
# Windows PowerShell
$env:PYTHONPATH="src"; python -m unittest discover -s tests -v

# Linux / macOS
PYTHONPATH=src python -m unittest discover -s tests -v
```

## 代码风格

- 行宽 100。
- 使用类型标注。
- 优先纯函数和可测试服务，不把业务逻辑写进插件入口。
- 提交前运行：

```bash
ruff check .
mypy src
```

## 分支与提交

- 主分支：`main`
- 功能分支：`feat/<name>`
- 修复分支：`fix/<name>`
- 文档分支：`docs/<name>`
- 提交信息尽量遵循 Conventional Commits，例如：
  - `feat(audit): add join request approval flow`
  - `fix(rules): handle empty keyword list`
  - `docs(phase0): record official API verification`

## Pull Request

- 描述改动背景、方案和验证方式。
- 关联 Issue。
- 确保测试通过。
- 不要提交密钥、真实群号、用户隐私数据或聊天原文。

## 安全

安全问题请参考 [SECURITY.md](../SECURITY.md)。

## 许可证

贡献代码即表示同意以 Apache-2.0 发布。
