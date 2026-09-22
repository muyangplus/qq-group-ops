"""入群申请同步服务测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.adapters.fake_qq_official import FakeQQOfficialAPI
from qq_group_ops.services.audit import InMemoryAuditLog
from qq_group_ops.services.join_audit import JoinAuditService
from qq_group_ops.services.join_audit_sync import JoinRequestSyncService


class JoinRequestSyncServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.api = FakeQQOfficialAPI()
        self.audit_log = InMemoryAuditLog()
        self.join_audit = JoinAuditService(self.audit_log)
        self.service = JoinRequestSyncService(self.api, self.join_audit)

    async def test_sync_imports_pending_requests(self) -> None:
        self.api.add_join_request("g1", "u1", "想加入", request_id="r1")
        self.api.add_join_request("g1", "u2", "活动报名", request_id="r2")
        self.api.add_join_request("g2", "u3", "其他群", request_id="r3")

        pending = await self.service.sync_group("g1")

        self.assertEqual([request.request_id for request in pending], ["r1", "r2"])

    async def test_sync_is_idempotent(self) -> None:
        self.api.add_join_request("g1", "u1", "想加入", request_id="r1")
        await self.service.sync_group("g1")
        await self.service.sync_group("g1")
        self.assertEqual(len(self.join_audit.pending("g1")), 1)

    async def test_sync_skips_invalid_entries(self) -> None:
        self.api.join_requests["bad"] = {
            "request_id": "bad",
            "group_id": "g1",
        }
        pending = await self.service.sync_group("g1")
        self.assertEqual(pending, ())


if __name__ == "__main__":
    unittest.main()
