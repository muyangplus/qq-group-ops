"""入群审核服务测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.core.enums import AuditStatus, JoinRequestStatus
from qq_group_ops.services.audit import InMemoryAuditLog
from qq_group_ops.services.join_audit import JoinAuditService


class JoinAuditServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.audit_log = InMemoryAuditLog()
        self.service = JoinAuditService(self.audit_log)

    def test_submit_creates_pending_request(self) -> None:
        request = self.service.submit("g1", "u1", "想加入")
        self.assertEqual(request.status, JoinRequestStatus.PENDING)
        self.assertEqual(self.service.pending("g1"), (request,))
        self.assertEqual(self.service.pending("g2"), ())

    def test_approve_updates_status_and_writes_audit(self) -> None:
        request = self.service.submit("g1", "u1", "想加入")
        updated = self.service.approve(request.request_id, "admin")
        self.assertEqual(updated.status, JoinRequestStatus.APPROVED)
        self.assertEqual(updated.reviewer_id, "admin")
        self.assertIsNotNone(updated.reviewed_at)
        records = self.audit_log.all()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].status, AuditStatus.APPROVED)
        self.assertEqual(records[0].target_user_id, "u1")

    def test_reject_records_reason(self) -> None:
        request = self.service.submit("g1", "u1", "想加入")
        updated = self.service.reject(request.request_id, "admin", "资料不完整")
        self.assertEqual(updated.status, JoinRequestStatus.REJECTED)
        records = self.audit_log.all()
        self.assertEqual(records[0].status, AuditStatus.REJECTED)
        self.assertEqual(records[0].reason, "资料不完整")

    def test_double_review_raises(self) -> None:
        request = self.service.submit("g1", "u1")
        self.service.approve(request.request_id, "admin")
        with self.assertRaises(ValueError):
            self.service.approve(request.request_id, "admin")

    def test_unknown_request_raises(self) -> None:
        with self.assertRaises(KeyError):
            self.service.approve("missing", "admin")


if __name__ == "__main__":
    unittest.main()
