"""基于 httpx 的异步传输实现。

该模块在导入时不依赖 httpx；只有实例化 HttpxTransport 时才检查依赖。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from qq_group_ops.adapters.qq_official import HttpResponse, JsonValue


class HttpxTransport:
    """使用 httpx.AsyncClient 的生产传输。"""

    def __init__(self, timeout: float = 10.0) -> None:
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError("httpx is required for HttpxTransport") from exc
        self._client = httpx.AsyncClient(timeout=timeout)

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        json: JsonValue = None,
    ) -> HttpResponse:
        response = await self._client.request(
            method=method,
            url=url,
            headers=dict(headers),
            json=json,
        )
        try:
            data: Any = response.json()
        except ValueError:
            data = None
        return HttpResponse(
            status_code=response.status_code,
            json_data=data,
            text=response.text,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
