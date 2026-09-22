"""QQ 官方开放平台 API 客户端。

`nonebot-adapter-qq` 负责事件接入；本模块负责群管理 REST 调用。
Phase 0 必须核实官方鉴权、端点和请求体；当前实现提供可测试的传输层框架。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

JsonDict = dict[str, Any]
JsonValue = dict[str, Any] | list[Any] | str | None


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

    async def remove_group_member(self, group_id: str, user_id: str) -> None:
        """移除群成员。"""

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


@dataclass(frozen=True, slots=True)
class HttpResponse:
    """传输层响应。"""

    status_code: int
    json_data: Any = None
    text: str = ""


class AsyncTransport(Protocol):
    """异步 HTTP 传输抽象。"""

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        json: JsonValue = None,
    ) -> HttpResponse:
        """执行 HTTP 请求。"""

    async def aclose(self) -> None:
        """关闭连接。"""


@dataclass(frozen=True, slots=True)
class QQOfficialEndpoints:
    """官方 API 端点。

    默认值来自公开文档路径线索，Phase 0 必须在开放平台文档中逐项核实。
    """

    base_url: str = "https://api.sgroup.qq.com"
    token_url: str = "https://bots.qq.com/app/getAppAccessToken"
    send_group_message: str = "/v2/groups/{group_id}/messages"
    recall_group_message: str = "/v2/groups/{group_id}/messages/{message_id}"
    mute_group_member: str = "/v2/groups/{group_id}/restrict_chat_setting"
    remove_group_member: str = "/v2/groups/{group_id}/batch_remove_members"
    approve_join_request: str = "/v2/groups/{group_id}/approval_join_request/{member_openid}"
    join_request_list: str = "/v2/groups/{group_id}/join_request_list"


class QQOfficialAPIError(RuntimeError):
    """官方 API 返回错误。"""

    def __init__(self, status_code: int, message: str, payload: Any = None) -> None:
        super().__init__(f"QQ official API error {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.payload = payload


class QQOfficialClient:
    """基于可替换 transport 的官方 API 客户端。"""

    def __init__(
        self,
        app_id: str,
        client_secret: str,
        *,
        token: str = "",
        transport: AsyncTransport | None = None,
        endpoints: QQOfficialEndpoints | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        if not app_id or not client_secret:
            raise ValueError("QQ_BOT_APP_ID and QQ_BOT_CLIENT_SECRET are required")
        self.app_id = app_id
        self.client_secret = client_secret
        self._token = token
        self._transport = transport
        self._endpoints = endpoints or QQOfficialEndpoints()
        self._extra_headers = dict(headers or {})

    @property
    def token(self) -> str:
        return self._token

    async def __aenter__(self) -> QQOfficialClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._transport is not None:
            await self._transport.aclose()

    async def ensure_token(self) -> str:
        """获取 access token；已配置 token 时直接返回。"""

        if self._token:
            return self._token
        if self._transport is None:
            raise RuntimeError("transport is required to fetch access token")
        response = await self._transport.request(
            "POST",
            self._endpoints.token_url,
            headers={"Content-Type": "application/json", **self._extra_headers},
            json={"appId": self.app_id, "clientSecret": self.client_secret},
        )
        self._raise_for_status(response)
        data = response.json_data if isinstance(response.json_data, dict) else {}
        token = data.get("access_token") or data.get("accessToken")
        if not token:
            raise QQOfficialAPIError(response.status_code, "access_token missing", data)
        self._token = str(token)
        return self._token

    async def send_group_message(
        self,
        group_id: str,
        content: str,
        *,
        msg_id: str | None = None,
    ) -> JsonDict:
        payload: JsonDict = {"content": content}
        if msg_id:
            payload["msg_id"] = msg_id
        response = await self._request(
            "POST",
            self._endpoints.send_group_message.format(group_id=group_id),
            json=payload,
        )
        return response.json_data if isinstance(response.json_data, dict) else {}

    async def recall_group_message(self, group_id: str, message_id: str) -> None:
        await self._request(
            "DELETE",
            self._endpoints.recall_group_message.format(
                group_id=group_id,
                message_id=message_id,
            ),
        )

    async def mute_group_member(
        self,
        group_id: str,
        user_id: str,
        duration_seconds: int,
    ) -> None:
        raise NotImplementedError(
            "Phase 0: verify restrict_chat_setting request body before enabling"
        )

    async def remove_group_member(self, group_id: str, user_id: str) -> None:
        raise NotImplementedError(
            "Phase 0: verify batch_remove_members request body before enabling"
        )

    async def approve_join_request(
        self,
        group_id: str,
        member_openid: str,
        *,
        approve: bool,
        reason: str = "",
    ) -> None:
        await self._request(
            "POST",
            self._endpoints.approve_join_request.format(
                group_id=group_id,
                member_openid=member_openid,
            ),
            json={"approve": approve, "reason": reason},
        )

    async def get_join_requests(self, group_id: str) -> list[JsonDict]:
        response = await self._request(
            "GET",
            self._endpoints.join_request_list.format(group_id=group_id),
        )
        if isinstance(response.json_data, list):
            return [item for item in response.json_data if isinstance(item, dict)]
        if isinstance(response.json_data, dict):
            data = response.json_data.get("data")
            if isinstance(data, list):
                return [item for item in data if isinstance(item, dict)]
        return []

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: JsonValue = None,
    ) -> HttpResponse:
        await self.ensure_token()
        if self._transport is None:
            raise RuntimeError("transport is required")
        url = self._endpoints.base_url.rstrip("/") + path
        response = await self._transport.request(
            method,
            url,
            headers=self._headers(),
            json=json,
        )
        self._raise_for_status(response)
        return response

    def _headers(self) -> dict[str, str]:
        # Phase 0: 核实 Authorization 与 X-Union-Appid 的实际要求。
        return {
            "Authorization": f"QQBot {self._token}",
            "Content-Type": "application/json",
            "X-Union-Appid": self.app_id,
            **self._extra_headers,
        }

    @staticmethod
    def _raise_for_status(response: HttpResponse) -> None:
        if response.status_code < 400:
            return
        payload = response.json_data if response.json_data is not None else response.text
        if isinstance(payload, dict):
            message = str(payload.get("message") or payload.get("msg") or payload)
        else:
            message = str(payload)
        raise QQOfficialAPIError(response.status_code, message, payload)
