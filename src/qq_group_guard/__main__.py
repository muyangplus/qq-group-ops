"""本地骨架入口。

Phase 0 阶段只验证配置加载；Phase 1 会替换为 NoneBot2 + FastAPI 启动入口。
"""

from __future__ import annotations

from qq_group_guard.config import load_settings


def main() -> None:
    """打印当前配置状态，不输出任何密钥内容。"""

    settings = load_settings()
    print("qq-group-guard skeleton")
    print(f"qq credentials configured: {settings.has_qq_credentials}")
    print(f"database url configured: {bool(settings.database_url)}")
    print(f"raw message retention days: {settings.raw_message_retention_days}")
    print(f"audit log retention days: {settings.audit_log_retention_days}")
    print("TODO Phase 1: start NoneBot2 runtime and FastAPI admin app.")


if __name__ == "__main__":
    main()
