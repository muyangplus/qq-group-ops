"""管理员命令服务测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.core.enums import JoinRequestStatus
from qq_group_ops.services.admin_commands import AdminCommandService
from qq_group_ops.services.audit import InMemoryAuditLog
from qq_group_ops.services.group_config import GroupConfig, GroupConfigStore
from qq_group_ops.services.join_audit import JoinAuditService
from qq_group_ops.services.permissions import PermissionPolicy, PermissionService


class AdminCommandServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.audit_log = InMemoryAuditLog()
        self.permissions = PermissionService(
            PermissionPolicy(
                super_admin_ids=frozenset({"root"}),
                group_admin_ids={"g1": frozenset({"admin"})},
                moderator_ids={"g1": frozenset({"mod"})},
            )
        )
        self.join_audit = JoinAuditService(self.audit_log)
        self.config_store = GroupConfigStore(
            default=GroupConfig(group_id="__default__", keywords=("广告",))
        )
        self.service = AdminCommandService(
            self.permissions,
            self.join_audit,
            self.config_store,
        )

    def test_help(self) -> None:
        result = self.service.handle(group_id="g1", user_id="member", text="/help")
        self.assertTrue(result.ok)
        self.assertIn("可用指令", result.text)

    def test_unknown_command(self) -> None:
        result = self.service.handle(group_id="g1", user_id="member", text="/unknown")
        self.assertFalse(result.ok)
        self.assertIn("未知指令", result.text)

    def test_pending_requires_permission(self) -> None:
        result = self.service.handle(group_id="g1", user_id="member", text="/pending")
        self.assertFalse(result.ok)
        self.assertIn("权限不足", result.text)

    def test_pending_lists_requests(self) -> None:
        self.join_audit.submit("g1", "u1", "想加入", request_id="r1")
        self.join_audit.submit("g2", "u2", "其他群", request_id="r2")
        result = self.service.handle(group_id="g1", user_id="mod", text="/pending")
        self.assertTrue(result.ok)
        self.assertIn("r1", result.text)
        self.assertNotIn("r2", result.text)

    def test_approve(self) -> None:
        self.join_audit.submit("g1", "u1", "想加入", request_id="r1")
        result = self.service.handle(group_id="g1", user_id="admin", text="/approve r1")
        self.assertTrue(result.ok)
        self.assertEqual(self.join_audit.get("r1").status, JoinRequestStatus.APPROVED)

    def test_reject_records_reason(self) -> None:
        self.join_audit.submit("g1", "u1", "想加入", request_id="r1")
        result = self.service.handle(
            group_id="g1",
            user_id="admin",
            text="/reject r1 资料不完整",
        )
        self.assertTrue(result.ok)
        request = self.join_audit.get("r1")
        self.assertEqual(request.status, JoinRequestStatus.REJECTED)
        self.assertEqual(self.audit_log.all()[-1].reason, "资料不完整")

    def test_invalid_request_id(self) -> None:
        result = self.service.handle(group_id="g1", user_id="admin", text="/approve missing")
        self.assertFalse(result.ok)
        self.assertIn("审批失败", result.text)

    def test_rules(self) -> None:
        result = self.service.handle(group_id="g1", user_id="mod", text="/rules")
        self.assertTrue(result.ok)
        self.assertIn("广告", result.text)

    def test_status(self) -> None:
        result = self.service.handle(group_id="g1", user_id="mod", text="/status")
        self.assertTrue(result.ok)
        self.assertIn("禁言时长", result.text)


if __name__ == "__main__":
    unittest.main()
