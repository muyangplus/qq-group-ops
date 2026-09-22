"""QQ 官方 API 客户端测试。"""

from __future__ import annotations

import unittest
from collections.abc import Mapping

from qq_group_ops.adapters.qq_official import (
    HttpResponse,
    JsonValue,
    QQOfficialAPIError,
    QQOfficialClient,
    QQOfficialEndpoints,
)


class FakeTransport:
    """记录请求并返回预设响应。"""

    def __init__(self, responses: list[HttpResponse] | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self._responses = list(responses or [])

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        json: JsonValue = None,
    ) -> HttpResponse:
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "json": json,
            }
        )
        if self._responses:
            return self._responses.pop(0)
        return HttpResponse(status_code=200, json_data={})

    async def aclose(self) -> None:
        return None


class QQOfficialClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_token_then_send_group_message(self) -> None:
        transport = FakeTransport(
            [
                HttpResponse(status_code=200, json_data={"access_token": "tok"}),
                HttpResponse(status_code=200, json_data={"id": "mid"}),
            ]
        )
        client = QQOfficialClient("app", "secret", transport=transport)

        result = await client.send_group_message("g1", "hello", msg_id="m1")

        self.assertEqual(result, {"id": "mid"})
        self.assertEqual(transport.calls[0]["method"], "POST")
        self.assertEqual(
            transport.calls[0]["url"],
            "https://bots.qq.com/app/getAppAccessToken",
        )
        self.assertEqual(
            transport.calls[0]["json"],
            {"appId": "app", "clientSecret": "secret"},
        )
        self.assertEqual(transport.calls[1]["method"], "POST")
        self.assertTrue(str(transport.calls[1]["url"]).endswith("/v2/groups/g1/messages"))
        self.assertEqual(
            transport.calls[1]["headers"]["Authorization"],  # type: ignore[index]
            "QQBot tok",
        )
        self.assertEqual(
            transport.calls[1]["json"],
            {"content": "hello", "msg_id": "m1"},
        )

    async def test_existing_token_skips_token_request(self) -> None:
        transport = FakeTransport([HttpResponse(status_code=200, json_data={})])
        client = QQOfficialClient("app", "secret", token="tok", transport=transport)
        await client.recall_group_message("g1", "m1")
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0]["method"], "DELETE")
        self.assertTrue(str(transport.calls[0]["url"]).endswith("/v2/groups/g1/messages/m1"))

    async def test_approve_join_request(self) -> None:
        transport = FakeTransport([HttpResponse(status_code=200, json_data={})])
        client = QQOfficialClient("app", "secret", token="tok", transport=transport)
        await client.approve_join_request("g1", "u1", approve=True, reason="ok")
        self.assertEqual(transport.calls[0]["method"], "POST")
        self.assertTrue(
            str(transport.calls[0]["url"]).endswith(
                "/v2/groups/g1/approval_join_request/u1"
            )
        )
        self.assertEqual(
            transport.calls[0]["json"],
            {"approve": True, "reason": "ok"},
        )

    async def test_get_join_requests(self) -> None:
        transport = FakeTransport(
            [
                HttpResponse(
                    status_code=200,
                    json_data={"data": [{"request_id": "r1"}]},
                )
            ]
        )
        client = QQOfficialClient("app", "secret", token="tok", transport=transport)
        requests = await client.get_join_requests("g1")
        self.assertEqual(requests, [{"request_id": "r1"}])

    async def test_api_error_is_raised(self) -> None:
        transport = FakeTransport(
            [
                HttpResponse(
                    status_code=403,
                    json_data={"message": "forbidden"},
                )
            ]
        )
        client = QQOfficialClient("app", "secret", token="tok", transport=transport)
        with self.assertRaises(QQOfficialAPIError) as context:
            await client.get_join_requests("g1")
        self.assertEqual(context.exception.status_code, 403)

    async def test_custom_endpoints(self) -> None:
        transport = FakeTransport([HttpResponse(status_code=200, json_data={})])
        endpoints = QQOfficialEndpoints(
            base_url="https://example.test",
            send_group_message="/custom/{group_id}/send",
        )
        client = QQOfficialClient(
            "app",
            "secret",
            token="tok",
            transport=transport,
            endpoints=endpoints,
        )
        await client.send_group_message("g1", "hello")
        self.assertEqual(
            transport.calls[0]["url"],
            "https://example.test/custom/g1/send",
        )


if __name__ == "__main__":
    unittest.main()
