"""规则引擎测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.core.enums import ModerationAction, RiskLevel
from qq_group_ops.services.moderation import ModerationRule, RuleEngine


class RuleEngineTests(unittest.TestCase):
    def test_keyword_match(self) -> None:
        engine = RuleEngine.from_keywords(["广告"])
        matches = engine.evaluate("这里有广告内容")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].pattern, "广告")
        self.assertEqual(matches[0].action, ModerationAction.WARN)

    def test_keyword_match_is_case_insensitive_by_default(self) -> None:
        engine = RuleEngine.from_keywords(["Spam"])
        matches = engine.evaluate("this is SPAM content")
        self.assertEqual(len(matches), 1)

    def test_regex_match(self) -> None:
        rule = ModerationRule(
            rule_id="url",
            pattern=r"https?://",
            action=ModerationAction.REVIEW,
            risk=RiskLevel.HIGH,
            is_regex=True,
        )
        engine = RuleEngine([rule])
        matches = engine.evaluate("访问 https://example.com")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].action, ModerationAction.REVIEW)
        self.assertEqual(matches[0].risk, RiskLevel.HIGH)

    def test_highest_action(self) -> None:
        rules = [
            ModerationRule(
                rule_id="warn",
                pattern="warn",
                action=ModerationAction.WARN,
            ),
            ModerationRule(
                rule_id="kick",
                pattern="kick",
                action=ModerationAction.KICK,
            ),
        ]
        engine = RuleEngine(rules)
        self.assertEqual(engine.highest_action("warn kick"), ModerationAction.KICK)

    def test_no_match_returns_allow(self) -> None:
        engine = RuleEngine.from_keywords(["广告"])
        self.assertEqual(engine.highest_action("正常聊天"), ModerationAction.ALLOW)

    def test_disabled_rule_is_ignored(self) -> None:
        rule = ModerationRule(
            rule_id="disabled",
            pattern="广告",
            enabled=False,
        )
        engine = RuleEngine([rule])
        self.assertEqual(engine.evaluate("广告"), ())

    def test_invalid_regex_raises_value_error(self) -> None:
        with self.assertRaises(ValueError):
            RuleEngine(
                [
                    ModerationRule(
                        rule_id="bad",
                        pattern="[",
                        is_regex=True,
                    )
                ]
            )


if __name__ == "__main__":
    unittest.main()
