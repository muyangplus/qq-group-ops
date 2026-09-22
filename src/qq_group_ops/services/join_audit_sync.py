"""入群申请同步服务。

从官方 API 拉取入群申请，写入 JoinAuditService，供管理员审批。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from qq_group_ops.adapters.qq_official import QQOfficialAPI
from qq_group_ops.services.join_audit import JoinAuditService, JoinRequest


class JoinRequestSyncService:
    """同步官方入群申请到本地审核队列。"""

    def __init__(self, api: QQOfficialAPI, join_audit: JoinAuditService) -> None:
        self._api = api
        self._join_audit = join_audit

    async def sync_group(self, group_id: str) -> tuple[JoinRequest, ...]:
        raw_requests = await self._api.get_join_requests(group_id)
        for item in raw_requests:
            request_id = self._first_string(item, "request_id", "id", "flag")
            user_id = self._first_string(item, "user_id", "member_openid", "user_openid")
            reason = self._first_string(item, "reason", "comment") or ""
            if request_id is None or user_id is None:
                continue
            try:
                self._join_audit.submit(
                    group_id,
                    user_id,
                    reason,
                    request_id=request_id,
                )
            except ValueError:
                # 已同步过的申请不重复写入。
                continue
        return self._join_audit.pending(group_id)

    @staticmethod
    def _first_string(item: Mapping[str, Any], *keys: str) -> str | None:
        for key in keys:
            value = item.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        return None
