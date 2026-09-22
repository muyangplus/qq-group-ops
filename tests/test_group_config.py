"""多群配置测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.services.group_config import (
    GroupConfig,
    GroupConfigOverride,
    GroupConfigStore,
)


class GroupConfigStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = GroupConfigStore(
            default=GroupConfig(
                group_id="__default__",
                join_audit_enabled=True,
                auto_approve_join=False,
                keywords=("广告",),
                raw_message_retention_days=0,
            )
        )

    def test_default_fallback(self) -> None:
        config = self.store.get("g1")
        self.assertEqual(config.group_id, "g1")
        self.assertTrue(config.join_audit_enabled)
        self.assertFalse(config.auto_approve_join)
        self.assertEqual(config.keywords, ("广告",))

    def test_override_one_field_inherits_others(self) -> None:
        self.store.set_override(GroupConfigOverride(group_id="g1", auto_approve_join=True))
        config = self.store.get("g1")
        self.assertTrue(config.auto_approve_join)
        self.assertTrue(config.join_audit_enabled)
        self.assertEqual(config.keywords, ("广告",))

    def test_override_keywords(self) -> None:
        self.store.set_override(GroupConfigOverride(group_id="g1", keywords=("刷屏",)))
        self.assertEqual(self.store.get("g1").keywords, ("刷屏",))
        self.assertEqual(self.store.get("g2").keywords, ("广告",))

    def test_remove_override(self) -> None:
        self.store.set_override(GroupConfigOverride(group_id="g1", auto_approve_join=True))
        self.store.remove_override("g1")
        self.assertFalse(self.store.get("g1").auto_approve_join)

    def test_default_group_id_cannot_be_overridden(self) -> None:
        with self.assertRaises(ValueError):
            self.store.set_override(GroupConfigOverride(group_id="__default__"))


if __name__ == "__main__":
    unittest.main()
