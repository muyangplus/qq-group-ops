"""多群配置：统一默认 + 单群覆盖。"""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True, slots=True)
class GroupConfig:
    """某个群的完整生效配置。"""

    group_id: str
    enabled: bool = True
    join_audit_enabled: bool = True
    auto_approve_join: bool = False
    keywords: tuple[str, ...] = ()
    word_filter_enabled: bool = True
    export_enabled: bool = False
    raw_message_retention_days: int = 0


@dataclass(frozen=True, slots=True)
class GroupConfigOverride:
    """单群覆盖项；None 表示继承全局默认值。"""

    group_id: str
    enabled: bool | None = None
    join_audit_enabled: bool | None = None
    auto_approve_join: bool | None = None
    keywords: tuple[str, ...] | None = None
    word_filter_enabled: bool | None = None
    export_enabled: bool | None = None
    raw_message_retention_days: int | None = None


class GroupConfigStore:
    """内存配置仓库；Phase 1 后接入 PostgreSQL。"""

    def __init__(self, default: GroupConfig | None = None) -> None:
        self._default = default or GroupConfig(group_id="__default__")
        self._overrides: dict[str, GroupConfigOverride] = {}

    @property
    def default(self) -> GroupConfig:
        return self._default

    def get(self, group_id: str) -> GroupConfig:
        override = self._overrides.get(group_id)
        if override is None:
            return replace(self._default, group_id=group_id)
        return GroupConfig(
            group_id=group_id,
            enabled=self._pick(override.enabled, self._default.enabled),
            join_audit_enabled=self._pick(
                override.join_audit_enabled,
                self._default.join_audit_enabled,
            ),
            auto_approve_join=self._pick(
                override.auto_approve_join,
                self._default.auto_approve_join,
            ),
            keywords=self._pick(override.keywords, self._default.keywords),
            word_filter_enabled=self._pick(
                override.word_filter_enabled,
                self._default.word_filter_enabled,
            ),
            export_enabled=self._pick(override.export_enabled, self._default.export_enabled),
            raw_message_retention_days=self._pick(
                override.raw_message_retention_days,
                self._default.raw_message_retention_days,
            ),
        )

    def set_override(self, override: GroupConfigOverride) -> None:
        if override.group_id == "__default__":
            raise ValueError("cannot override the default group id")
        self._overrides[override.group_id] = override

    def remove_override(self, group_id: str) -> None:
        self._overrides.pop(group_id, None)

    def list_overrides(self) -> tuple[GroupConfigOverride, ...]:
        return tuple(self._overrides.values())

    @staticmethod
    def _pick(value: object, fallback: object) -> object:
        return fallback if value is None else value
