"""领域枚举。"""

from __future__ import annotations

from enum import StrEnum


class RiskLevel(StrEnum):
    """风险等级。"""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ModerationAction(StrEnum):
    """审核动作。"""

    ALLOW = "allow"
    WARN = "warn"
    REVIEW = "review"
    RECALL = "recall"
    MUTE = "mute"
    KICK = "kick"


class AuditStatus(StrEnum):
    """审核状态。"""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    AUTO_APPROVED = "auto_approved"
    AUTO_REJECTED = "auto_rejected"
