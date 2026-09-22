"""信息导出服务测试。"""

from __future__ import annotations

import csv
import io
import unittest

from qq_group_ops.core.enums import AuditStatus
from qq_group_ops.core.models import AuditRecord
from qq_group_ops.services.activity import Activity, ActivityRegistration
from qq_group_ops.services.audit import InMemoryAuditLog
from qq_group_ops.services.export import ExportService, mask_identifier
from qq_group_ops.services.permissions import PermissionPolicy, PermissionService


class ExportServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.audit_log = InMemoryAuditLog()
        self.permissions = PermissionService(
            PermissionPolicy(
                super_admin_ids=frozenset({"root"}),
                group_admin_ids={"g1": frozenset({"admin"})},
            )
        )
        self.service = ExportService(self.permissions, self.audit_log)
        self.activity = Activity(
            activity_id="a1",
            group_id="g1",
            title="周末活动",
            created_by="admin",
        )
        self.registrations = (
            ActivityRegistration(
                registration_id="r1",
                activity_id="a1",
                group_id="g1",
                user_id="user1",
                display_name="小明",
            ),
        )

    def test_mask_identifier(self) -> None:
        self.assertEqual(mask_identifier("user1"), "u***1")
        self.assertEqual(mask_identifier("ab"), "**")
        self.assertEqual(mask_identifier(None), "")

    def test_export_requires_permission(self) -> None:
        with self.assertRaises(PermissionError):
            self.service.export_activity_registrations_csv(
                actor_id="member",
                activity=self.activity,
                registrations=self.registrations,
            )

    def test_export_activity_masks_user_ids(self) -> None:
        content = self.service.export_activity_registrations_csv(
            actor_id="admin",
            activity=self.activity,
            registrations=self.registrations,
        )
        rows = list(csv.reader(io.StringIO(content)))
        self.assertEqual(rows[0][0], "registration_id")
        self.assertEqual(rows[1][0], "r1")
        self.assertEqual(rows[1][3], "u***1")

        audit_records = self.audit_log.all()
        self.assertEqual(len(audit_records), 1)
        self.assertEqual(audit_records[0].action, "export_activity_registrations")
        self.assertEqual(audit_records[0].status, AuditStatus.EXECUTED)

    def test_export_audit_records_csv(self) -> None:
        records = (
            AuditRecord(
                record_id="rec1",
                group_id="g1",
                actor_id="admin",
                target_user_id="user1",
                action="approve_join_request",
                status=AuditStatus.APPROVED,
                reason="ok",
            ),
        )
        content = self.service.export_audit_records_csv(
            actor_id="root",
            group_id="g1",
            records=records,
        )
        rows = list(csv.reader(io.StringIO(content)))
        self.assertEqual(rows[0][0], "record_id")
        self.assertEqual(rows[1][0], "rec1")
        self.assertEqual(rows[1][2], "a***n")
        self.assertEqual(rows[1][3], "u***1")

        audit_records = self.audit_log.all()
        self.assertEqual(audit_records[-1].action, "export_audit_records")


if __name__ == "__main__":
    unittest.main()
