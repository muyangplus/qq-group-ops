"""配置加载测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.config import load_settings


class SettingsTests(unittest.TestCase):
    def test_load_defaults(self) -> None:
        settings = load_settings({})
        self.assertFalse(settings.has_qq_credentials)
        self.assertEqual(settings.raw_message_retention_days, 0)
        self.assertEqual(settings.audit_log_retention_days, 180)

    def test_load_env(self) -> None:
        settings = load_settings(
            {
                "QQ_BOT_APP_ID": "123",
                "QQ_BOT_CLIENT_SECRET": "secret",
                "QQ_BOT_SANDBOX": "true",
                "ADMIN_QQ_IDS": "1, 2",
                "RAW_MESSAGE_RETENTION_DAYS": "7",
            }
        )
        self.assertTrue(settings.has_qq_credentials)
        self.assertTrue(settings.qq_bot_sandbox)
        self.assertEqual(settings.admin_qq_ids, ("1", "2"))
        self.assertEqual(settings.raw_message_retention_days, 7)


if __name__ == "__main__":
    unittest.main()
