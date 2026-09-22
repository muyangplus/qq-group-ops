"""核心领域模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from qq_group_guard.core.enums import AuditStatus, ModerationAction, RiskLevel


def utc_now() -> datetime:
    """返回带时区的当前 UTC 时间。"""

    return datetime.now(timezone.utc)


@dataclass(frozen=True, slots=True)
class IncomingMessage:
    """一条待处理的群消息。"""

    group_id: str
    user_id: str
    message_id: str
    content: str
    received_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True, slots=True)
class RuleMatch:
    """规则命中结果。"""

    rule_id: str
    pattern: str
    action: ModerationAction
    reason: str
    risk: RiskLevel


@dataclass(frozen=True, slots=True)
class AuditRecord:
    """审核或管理操作记录。"""

    record_id: str
    group_id: str
    actor_id: str
    action: str
    status: AuditStatus
    reason: str = ""
    target_user_id: str | None = None
    created_at: datetime = field(default_factory=utc_now)
