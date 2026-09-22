"""QQ 官方开放平台 API 客户端。

`nonebot-adapter-qq` 负责事件接入；本模块负责群管理 REST 调用。
Phase 0 必须先核实官方鉴权、端点和权限，再实现具体请求。
"""

from __future__ import annotations

from typing import Any, Protocol

JsonDict = dict[str, Any]


class QQOfficialAPI(Protocol):
    """官方群管理 API 的最小接口。"""

    async def send_group_message(
        self,
        group_id: str,
        content: str,
        *,
        msg_id: str | None = None,
    ) -> JsonDict:
        """发送群聊消息。"""

    async def recall_group_message(self, group_id: str, message_id: str) -> None:
        """撤回群聊消息。"""

    async def mute_group_member(
        self,
        group_id: str,
        user_id: str,
        duration_seconds: int,
    ) -> None:
        """禁言群成员。"""

    async def approve_join_request(
        self,
        group_id: str,
        member_openid: str,
        *,
        approve: bool,
        reason: str = "",
    ) -> None:
        """通过或拒绝入群申请。"""

    async def get_join_requests(self, group_id: str) -> list[JsonDict]:
        """拉取入群申请列表。"""


class QQOfficialClient:
    """官方 API 客户端骨架。

    具体实现前必须完成 Phase 0 验证：
    - 鉴权方式与 token 获取；
    - OpenAPI 基础地址；
    - 群管理接口权限；
    - 频率限制与错误码。
    """

    # Phase 0 核实后再启用：
    # BASE_URL = "https://api.sgroup.qq.com"
    # TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

    def __init__(
        self,
        app_id: str,
        client_secret: str,
        *,
        token: str = "",
        sandbox: bool = False,
    ) -> None:
        if not app_id or not client_secret:
            raise ValueError("QQ_BOT_APP_ID and QQ_BOT_CLIENT_SECRET are required")
        self.app_id = app_id
        self.client_secret = client_secret
        self._token = token
        self.sandbox = sandbox

    async def __aenter__(self) -> QQOfficialClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        """关闭底层 HTTP 连接。Phase 1 使用 httpx.AsyncClient 实现。"""

    async def send_group_message(
        self,
        group_id: str,
        content: str,
        *,
        msg_id: str | None = None,
    ) -> JsonDict:
        raise NotImplementedError("Phase 1: implement after Phase 0 verification")

    async def recall_group_message(self, group_id: str, message_id: str) -> None:
        raise NotImplementedError("Phase 1: implement after Phase 0 verification")

    async def mute_group_member(
        self,
        group_id: str,
        user_id: str,
        duration_seconds: int,
    ) -> None:
        raise NotImplementedError("Phase 1: implement after Phase 0 verification")

    async def approve_join_request(
        self,
        group_id: str,
        member_openid: str,
        *,
        approve: bool,
        reason: str = "",
    ) -> None:
        raise NotImplementedError("Phase 1: implement after Phase 0 verification")

    async def get_join_requests(self, group_id: str) -> list[JsonDict]:
        raise NotImplementedError("Phase 1: implement after Phase 0 verification")
