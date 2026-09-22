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
    EXECUTED = "executed"


class ActivityStatus(StrEnum):
    """活动状态。"""

    DRAFT = "draft"
    OPEN = "open"
    CLOSED = "closed"
    CANCELLED = "cancelled"


class JoinRequestStatus(StrEnum):
    """入群申请状态。"""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


class PermissionLevel(StrEnum):
    """群管理权限级别。"""

    GUEST = "guest"
    MEMBER = "member"
    MODERATOR = "moderator"
    GROUP_ADMIN = "group_admin"
    SUPER_ADMIN = "super_admin"
