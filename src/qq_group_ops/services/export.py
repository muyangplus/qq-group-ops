"""信息导出服务。

导出属于高风险操作，必须做权限校验、脱敏和审计。
"""

from __future__ import annotations

import csv
from collections.abc import Iterable
from io import StringIO
from uuid import uuid4

from qq_group_ops.core.enums import AuditStatus
from qq_group_ops.core.models import AuditRecord
from qq_group_ops.services.activity import Activity, ActivityRegistration
from qq_group_ops.services.audit import AuditLog, InMemoryAuditLog
from qq_group_ops.services.permissions import PermissionService


def mask_identifier(value: str | None, *, keep: int = 1) -> str:
    """对 ID 做简单脱敏。"""

    if not value:
        return ""
    if len(value) <= keep * 2:
        return "*" * len(value)
    return f"{value[:keep]}***{value[-keep:]}"


class ExportService:
    """活动报名和审计日志导出。"""

    def __init__(
        self,
        permissions: PermissionService,
        audit_log: AuditLog | None = None,
    ) -> None:
        self._permissions = permissions
        self._audit_log = audit_log or InMemoryAuditLog()

    def export_activity_registrations_csv(
        self,
        *,
        actor_id: str,
        activity: Activity,
        registrations: Iterable[ActivityRegistration],
        mask_user_ids: bool = True,
    ) -> str:
        self._permissions.ensure(
            self._permissions.can_export_data(actor_id, activity.group_id),
            "permission denied: export activity registrations",
        )
        headers = [
            "registration_id",
            "activity_id",
            "group_id",
            "user_id",
            "display_name",
            "note",
            "created_at",
        ]
        rows: list[list[str]] = []
        count = 0
        for registration in registrations:
            count += 1
            rows.append(
                [
                    registration.registration_id,
                    registration.activity_id,
                    registration.group_id,
                    mask_identifier(registration.user_id) if mask_user_ids else registration.user_id,
                    registration.display_name,
                    registration.note,
                    registration.created_at.isoformat(),
                ]
            )
        content = self._render_csv(headers, rows)
        self._write_audit(
            actor_id=actor_id,
            group_id=activity.group_id,
            action="export_activity_registrations",
            count=count,
        )
        return content

    def export_audit_records_csv(
        self,
        *,
        actor_id: str,
        group_id: str,
        records: Iterable[AuditRecord],
        mask_user_ids: bool = True,
    ) -> str:
        self._permissions.ensure(
            self._permissions.can_export_data(actor_id, group_id),
            "permission denied: export audit records",
        )
        headers = [
            "record_id",
            "group_id",
            "actor_id",
            "target_user_id",
            "action",
            "status",
            "reason",
            "created_at",
        ]
        rows: list[list[str]] = []
        count = 0
        for record in records:
            count += 1
            rows.append(
                [
                    record.record_id,
                    record.group_id,
                    mask_identifier(record.actor_id) if mask_user_ids else record.actor_id,
                    mask_identifier(record.target_user_id) if mask_user_ids else (record.target_user_id or ""),
                    record.action,
                    record.status.value,
                    record.reason,
                    record.created_at.isoformat(),
                ]
            )
        content = self._render_csv(headers, rows)
        self._write_audit(
            actor_id=actor_id,
            group_id=group_id,
            action="export_audit_records",
            count=count,
        )
        return content

    @staticmethod
    def _render_csv(headers: list[str], rows: list[list[str]]) -> str:
        buffer = StringIO()
        writer = csv.writer(buffer)
        writer.writerow(headers)
        writer.writerows(rows)
        return buffer.getvalue()

    def _write_audit(self, *, actor_id: str, group_id: str, action: str, count: int) -> None:
        self._audit_log.append(
            AuditRecord(
                record_id=uuid4().hex,
                group_id=group_id,
                actor_id=actor_id,
                action=action,
                status=AuditStatus.EXECUTED,
                reason=f"rows={count}",
            )
        )
