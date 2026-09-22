"""权限模型。

当前实现为纯标准库，便于在没有 QQ 平台和第三方依赖时测试。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from qq_group_ops.core.enums import PermissionLevel

_LEVEL_RANK: dict[PermissionLevel, int] = {
    PermissionLevel.GUEST: 0,
    PermissionLevel.MEMBER: 1,
    PermissionLevel.MODERATOR: 2,
    PermissionLevel.GROUP_ADMIN: 3,
    PermissionLevel.SUPER_ADMIN: 4,
}


class PermissionDeniedError(PermissionError):
    """权限不足。"""


@dataclass(frozen=True, slots=True)
class PermissionPolicy:
    """权限策略配置。"""

    super_admin_ids: frozenset[str] = frozenset()
    group_admin_ids: Mapping[str, frozenset[str]] = field(default_factory=dict)
    moderator_ids: Mapping[str, frozenset[str]] = field(default_factory=dict)


class PermissionService:
    """根据用户、群和策略计算权限。"""

    def __init__(self, policy: PermissionPolicy | None = None) -> None:
        self._policy = policy or PermissionPolicy()

    def level_for(self, user_id: str, group_id: str | None = None) -> PermissionLevel:
        if user_id in self._policy.super_admin_ids:
            return PermissionLevel.SUPER_ADMIN
        if group_id is None:
            return PermissionLevel.GUEST
        if user_id in self._policy.group_admin_ids.get(group_id, frozenset()):
            return PermissionLevel.GROUP_ADMIN
        if user_id in self._policy.moderator_ids.get(group_id, frozenset()):
            return PermissionLevel.MODERATOR
        return PermissionLevel.MEMBER

    def has_at_least(
        self,
        user_id: str,
        group_id: str | None,
        required: PermissionLevel,
    ) -> bool:
        return _LEVEL_RANK[self.level_for(user_id, group_id)] >= _LEVEL_RANK[required]

    def can_approve_join(self, user_id: str, group_id: str) -> bool:
        return self.has_at_least(user_id, group_id, PermissionLevel.GROUP_ADMIN)

    def can_manage_rules(self, user_id: str, group_id: str) -> bool:
        return self.has_at_least(user_id, group_id, PermissionLevel.GROUP_ADMIN)

    def can_review_content(self, user_id: str, group_id: str) -> bool:
        return self.has_at_least(user_id, group_id, PermissionLevel.MODERATOR)

    def can_export_data(self, user_id: str, group_id: str) -> bool:
        return self.has_at_least(user_id, group_id, PermissionLevel.GROUP_ADMIN)

    def ensure(self, allowed: bool, message: str = "permission denied") -> None:
        if not allowed:
            raise PermissionDeniedError(message)
