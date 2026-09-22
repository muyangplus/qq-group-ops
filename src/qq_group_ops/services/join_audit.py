"""入群申请审核服务。

当前使用内存存储，Phase 1 后接入 PostgreSQL。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from uuid import uuid4

from qq_group_ops.core.enums import AuditStatus, JoinRequestStatus
from qq_group_ops.core.models import AuditRecord, utc_now
from qq_group_ops.services.audit import AuditLog, InMemoryAuditLog


@dataclass(frozen=True, slots=True)
class JoinRequest:
    """一条入群申请。"""

    request_id: str
    group_id: str
    user_id: str
    reason: str = ""
    status: JoinRequestStatus = JoinRequestStatus.PENDING
    created_at: datetime = field(default_factory=utc_now)
    reviewed_at: datetime | None = None
    reviewer_id: str | None = None


class JoinAuditService:
    """入群申请的状态流转与审计。"""

    def __init__(self, audit_log: AuditLog | None = None) -> None:
        self._requests: dict[str, JoinRequest] = {}
        self._audit_log = audit_log or InMemoryAuditLog()

    def submit(
        self,
        group_id: str,
        user_id: str,
        reason: str = "",
        *,
        request_id: str | None = None,
    ) -> JoinRequest:
        resolved_id = request_id or uuid4().hex
        if resolved_id in self._requests:
            raise ValueError(f"duplicate join request id: {resolved_id}")
        request = JoinRequest(
            request_id=resolved_id,
            group_id=group_id,
            user_id=user_id,
            reason=reason,
        )
        self._requests[resolved_id] = request
        return request

    def get(self, request_id: str) -> JoinRequest:
        try:
            return self._requests[request_id]
        except KeyError as exc:
            raise KeyError(f"join request not found: {request_id}") from exc

    def pending(self, group_id: str) -> tuple[JoinRequest, ...]:
        return tuple(
            request
            for request in self._requests.values()
            if request.group_id == group_id and request.status == JoinRequestStatus.PENDING
        )

    def approve(self, request_id: str, reviewer_id: str) -> JoinRequest:
        return self._review(
            request_id=request_id,
            reviewer_id=reviewer_id,
            status=JoinRequestStatus.APPROVED,
            audit_status=AuditStatus.APPROVED,
            reason="",
        )

    def reject(self, request_id: str, reviewer_id: str, reason: str = "") -> JoinRequest:
        return self._review(
            request_id=request_id,
            reviewer_id=reviewer_id,
            status=JoinRequestStatus.REJECTED,
            audit_status=AuditStatus.REJECTED,
            reason=reason,
        )

    def _review(
        self,
        *,
        request_id: str,
        reviewer_id: str,
        status: JoinRequestStatus,
        audit_status: AuditStatus,
        reason: str,
    ) -> JoinRequest:
        request = self.get(request_id)
        if request.status != JoinRequestStatus.PENDING:
            raise ValueError(f"join request already reviewed: {request_id}")
        updated = replace(
            request,
            status=status,
            reviewer_id=reviewer_id,
            reviewed_at=utc_now(),
        )
        self._requests[request_id] = updated
        self._audit_log.append(
            AuditRecord(
                record_id=uuid4().hex,
                group_id=request.group_id,
                actor_id=reviewer_id,
                target_user_id=request.user_id,
                action=(
                    "approve_join_request"
                    if status == JoinRequestStatus.APPROVED
                    else "reject_join_request"
                ),
                status=audit_status,
                reason=reason,
            )
        )
        return updated
