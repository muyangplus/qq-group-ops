"""审计日志测试。"""

from __future__ import annotations

import unittest

from qq_group_guard.core.enums import AuditStatus
from qq_group_guard.core.models import AuditRecord
from qq_group_guard.services.audit import InMemoryAuditLog


class AuditLogTests(unittest.TestCase):
    def test_append_and_find_by_group(self) -> None:
        log = InMemoryAuditLog()
        record = AuditRecord(
            record_id="1",
            group_id="g1",
            actor_id="admin",
            action="approve_join_request",
            status=AuditStatus.APPROVED,
        )
        log.append(record)

        self.assertEqual(log.find_by_group("g1"), (record,))
        self.assertEqual(log.find_by_group("g2"), ())
        self.assertEqual(log.all(), (record,))


if __name__ == "__main__":
    unittest.main()
