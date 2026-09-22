"""审计日志服务。

Phase 1 会接入 PostgreSQL；当前提供内存实现用于测试和本地开发。
"""

from __future__ import annotations

from qq_group_guard.core.models import AuditRecord


class AuditLog:
    """审计日志抽象。"""

    def append(self, record: AuditRecord) -> None:
        raise NotImplementedError

    def find_by_group(self, group_id: str) -> tuple[AuditRecord, ...]:
        raise NotImplementedError


class InMemoryAuditLog(AuditLog):
    """内存审计日志，仅用于测试和本地开发。"""

    def __init__(self) -> None:
        self._records: list[AuditRecord] = []

    def append(self, record: AuditRecord) -> None:
        self._records.append(record)

    def find_by_group(self, group_id: str) -> tuple[AuditRecord, ...]:
        return tuple(record for record in self._records if record.group_id == group_id)

    def all(self) -> tuple[AuditRecord, ...]:
        return tuple(self._records)
