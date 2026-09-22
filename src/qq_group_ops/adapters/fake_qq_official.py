"""QQ 官方 API 测试替身。

用于本地开发、单元测试和 Phase 0 模拟，不发起任何网络请求。
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

JsonDict = dict[str, Any]


class FakeQQOfficialAPI:
    """内存版本的官方 API 实现。

    仅用于测试和本地开发，不代表真实官方 API 行为。
    """

    def __init__(self) -> None:
        self.sent_messages: list[JsonDict] = []
        self.recalled_messages: list[tuple[str, str]] = []
        self.muted_members: list[tuple[str, str, int]] = []
        self.join_requests: dict[str, JsonDict] = {}
        self.join_request_reviews: list[tuple[str, str, bool, str]] = []

    async def send_group_message(
        self,
        group_id: str,
        content: str,
        *,
        msg_id: str | None = None,
    ) -> JsonDict:
        message_id = uuid4().hex
        record = {
            "group_id": group_id,
            "content": content,
            "msg_id": msg_id,
            "message_id": message_id,
        }
        self.sent_messages.append(record)
        return {"id": message_id}

    async def recall_group_message(self, group_id: str, message_id: str) -> None:
        self.recalled_messages.append((group_id, message_id))

    async def mute_group_member(
        self,
        group_id: str,
        user_id: str,
        duration_seconds: int,
    ) -> None:
        self.muted_members.append((group_id, user_id, duration_seconds))

    async def approve_join_request(
        self,
        group_id: str,
        member_openid: str,
        *,
        approve: bool,
        reason: str = "",
    ) -> None:
        self.join_request_reviews.append((group_id, member_openid, approve, reason))

    async def get_join_requests(self, group_id: str) -> list[JsonDict]:
        return [
            request
            for request in self.join_requests.values()
            if request["group_id"] == group_id
        ]

    def add_join_request(
        self,
        group_id: str,
        user_id: str,
        reason: str = "",
        *,
        request_id: str | None = None,
    ) -> JsonDict:
        resolved_id = request_id or uuid4().hex
        request = {
            "request_id": resolved_id,
            "group_id": group_id,
            "user_id": user_id,
            "reason": reason,
        }
        self.join_requests[resolved_id] = request
        return request
