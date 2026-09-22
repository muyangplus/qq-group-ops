"""配置加载。

Phase 0/1 先用标准库实现，避免本地测试依赖第三方包。
Phase 1 稳定后可迁移到 pydantic-settings。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _split_csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _as_int(value: str | None, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"invalid integer value: {value!r}") from exc


@dataclass(frozen=True, slots=True)
class Settings:
    """运行时配置。"""

    qq_bot_app_id: str = ""
    qq_bot_client_secret: str = ""
    qq_bot_token: str = ""
    qq_bot_sandbox: bool = False
    database_url: str = "postgresql+asyncpg://qqbot:change-me@localhost:5432/qq_group_guard"
    admin_qq_ids: tuple[str, ...] = ()
    log_level: str = "INFO"
    raw_message_retention_days: int = 0
    audit_log_retention_days: int = 180

    @property
    def has_qq_credentials(self) -> bool:
        return bool(self.qq_bot_app_id and self.qq_bot_client_secret)


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """从环境变量加载配置。"""

    source = env if env is not None else os.environ
    return Settings(
        qq_bot_app_id=source.get("QQ_BOT_APP_ID", ""),
        qq_bot_client_secret=source.get("QQ_BOT_CLIENT_SECRET", ""),
        qq_bot_token=source.get("QQ_BOT_TOKEN", ""),
        qq_bot_sandbox=_as_bool(source.get("QQ_BOT_SANDBOX"), default=False),
        database_url=source.get(
            "DATABASE_URL",
            "postgresql+asyncpg://qqbot:change-me@localhost:5432/qq_group_guard",
        ),
        admin_qq_ids=_split_csv(source.get("ADMIN_QQ_IDS")),
        log_level=source.get("LOG_LEVEL", "INFO").upper(),
        raw_message_retention_days=_as_int(
            source.get("RAW_MESSAGE_RETENTION_DAYS"),
            default=0,
        ),
        audit_log_retention_days=_as_int(
            source.get("AUDIT_LOG_RETENTION_DAYS"),
            default=180,
        ),
    )
