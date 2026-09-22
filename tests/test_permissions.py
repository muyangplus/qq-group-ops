"""权限模型测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.core.enums import PermissionLevel
from qq_group_ops.services.permissions import (
    PermissionDeniedError,
    PermissionPolicy,
    PermissionService,
)


class PermissionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = PermissionService(
            PermissionPolicy(
                super_admin_ids=frozenset({"root"}),
                group_admin_ids={"g1": frozenset({"ga1"})},
                moderator_ids={"g1": frozenset({"mod1"})},
            )
        )

    def test_super_admin_is_highest(self) -> None:
        self.assertEqual(self.service.level_for("root", "g1"), PermissionLevel.SUPER_ADMIN)
        self.assertTrue(self.service.can_export_data("root", "g1"))

    def test_group_admin_is_scoped_to_group(self) -> None:
        self.assertEqual(
            self.service.level_for("ga1", "g1"),
            PermissionLevel.GROUP_ADMIN,
        )
        self.assertEqual(
            self.service.level_for("ga1", "g2"),
            PermissionLevel.MEMBER,
        )
        self.assertTrue(self.service.can_approve_join("ga1", "g1"))
        self.assertFalse(self.service.can_approve_join("ga1", "g2"))

    def test_moderator_can_review_but_not_approve(self) -> None:
        self.assertTrue(self.service.can_review_content("mod1", "g1"))
        self.assertFalse(self.service.can_approve_join("mod1", "g1"))

    def test_member_has_no_management_permissions(self) -> None:
        self.assertFalse(self.service.can_manage_rules("member", "g1"))
        self.assertFalse(self.service.can_export_data("member", "g1"))

    def test_private_context_is_guest(self) -> None:
        self.assertEqual(self.service.level_for("member", None), PermissionLevel.GUEST)

    def test_ensure_raises(self) -> None:
        with self.assertRaises(PermissionDeniedError):
            self.service.ensure(False, "no permission")


if __name__ == "__main__":
    unittest.main()
