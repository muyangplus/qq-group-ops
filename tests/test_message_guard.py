"""消息审核执行服务测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.adapters.fake_qq_official import FakeQQOfficialAPI
from qq_group_ops.core.enums import AuditStatus, ModerationAction
from qq_group_ops.core.models import IncomingMessage
from qq_group_ops.services.audit import InMemoryAuditLog
from qq_group_ops.services.group_config import (
    GroupConfig,
    GroupConfigOverride,
    GroupConfigStore,
)
from qq_group_ops.services.message_guard import MessageGuardService
from qq_group_ops.services.moderation import ModerationRule, RuleEngine


class MessageGuardServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.api = FakeQQOfficialAPI()
        self.audit_log = InMemoryAuditLog()
        self.config_store = GroupConfigStore(default=GroupConfig(group_id="__default__"))
        self.rules = RuleEngine(
            [
                ModerationRule(
                    rule_id="warn",
                    pattern="广告",
                    action=ModerationAction.WARN,
                    reason="发现广告",
                ),
                ModerationRule(
                    rule_id="recall",
                    pattern="违规",
                    action=ModerationAction.RECALL,
                    reason="发现违规内容",
                ),
                ModerationRule(
                    rule_id="mute",
                    pattern="刷屏",
                    action=ModerationAction.MUTE,
                    reason="发现刷屏",
                ),
                ModerationRule(
                    rule_id="kick",
                    pattern="炸群",
                    action=ModerationAction.KICK,
                    reason="发现炸群",
                ),
                ModerationRule(
                    rule_id="review",
                    pattern="可疑",
                    action=ModerationAction.REVIEW,
                    reason="需要人工复核",
                ),
            ]
        )
        self.service = MessageGuardService(
            self.api,
            self.rules,
            self.config_store,
            self.audit_log,
        )

    async def test_no_match_returns_allow(self) -> None:
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "正常聊天")
        )
        self.assertEqual(result.action, ModerationAction.ALLOW)
        self.assertFalse(result.executed)
        self.assertEqual(self.api.sent_messages, [])
        self.assertEqual(self.audit_log.all(), ())

    async def test_warn_sends_message_and_records_audit(self) -> None:
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "这是广告")
        )
        self.assertEqual(result.action, ModerationAction.WARN)
        self.assertTrue(result.executed)
        self.assertEqual(len(self.api.sent_messages), 1)
        self.assertEqual(self.api.sent_messages[0]["msg_id"], "m1")
        record = self.audit_log.all()[0]
        self.assertEqual(record.status, AuditStatus.EXECUTED)
        self.assertEqual(record.action, "moderation:warn")

    async def test_recall_calls_api(self) -> None:
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "违规内容")
        )
        self.assertEqual(result.action, ModerationAction.RECALL)
        self.assertEqual(self.api.recalled_messages, [("g1", "m1")])

    async def test_mute_uses_group_config(self) -> None:
        self.config_store.set_override(
            GroupConfigOverride(group_id="g1", mute_duration_seconds=120)
        )
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "刷屏内容")
        )
        self.assertEqual(result.action, ModerationAction.MUTE)
        self.assertEqual(self.api.muted_members, [("g1", "u1", 120)])

    async def test_kick_calls_api(self) -> None:
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "炸群内容")
        )
        self.assertEqual(result.action, ModerationAction.KICK)
        self.assertEqual(self.api.removed_members, [("g1", "u1")])

    async def test_review_queues_without_immediate_action(self) -> None:
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "可疑内容")
        )
        self.assertEqual(result.action, ModerationAction.REVIEW)
        self.assertFalse(result.executed)
        self.assertEqual(result.detail, "queued_for_review")
        self.assertEqual(self.api.sent_messages, [])
        self.assertEqual(self.api.recalled_messages, [])
        record = self.audit_log.all()[0]
        self.assertEqual(record.status, AuditStatus.PENDING)

    async def test_disabled_group_skips_rules(self) -> None:
        self.config_store.set_override(GroupConfigOverride(group_id="g1", enabled=False))
        result = await self.service.handle_message(
            IncomingMessage("g1", "u1", "m1", "广告")
        )
        self.assertEqual(result.action, ModerationAction.ALLOW)
        self.assertEqual(result.detail, "disabled")
        self.assertEqual(self.api.sent_messages, [])


if __name__ == "__main__":
    unittest.main()
