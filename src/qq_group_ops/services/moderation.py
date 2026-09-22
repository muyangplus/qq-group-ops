"""规则引擎。

当前实现只依赖标准库，方便 Phase 0/1 在没有安装任何第三方依赖时运行测试。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from qq_group_ops.core.enums import ModerationAction, RiskLevel
from qq_group_ops.core.models import RuleMatch

_ACTION_PRIORITY: dict[ModerationAction, int] = {
    ModerationAction.ALLOW: 0,
    ModerationAction.WARN: 1,
    ModerationAction.REVIEW: 2,
    ModerationAction.RECALL: 3,
    ModerationAction.MUTE: 4,
    ModerationAction.KICK: 5,
}


@dataclass(frozen=True, slots=True)
class ModerationRule:
    """一条可配置的审核规则。"""

    rule_id: str
    pattern: str
    action: ModerationAction = ModerationAction.WARN
    reason: str = "命中规则"
    risk: RiskLevel = RiskLevel.MEDIUM
    is_regex: bool = False
    enabled: bool = True
    case_sensitive: bool = False


class RuleEngine:
    """按规则逐条匹配消息内容。"""

    def __init__(self, rules: Iterable[ModerationRule] | None = None) -> None:
        self._rules = tuple(rules or ())
        self._compiled: dict[str, re.Pattern[str]] = {}
        for rule in self._rules:
            if rule.is_regex:
                flags = 0 if rule.case_sensitive else re.IGNORECASE
                try:
                    self._compiled[rule.rule_id] = re.compile(rule.pattern, flags)
                except re.error as exc:
                    raise ValueError(
                        f"invalid regex for rule {rule.rule_id!r}: {rule.pattern!r}"
                    ) from exc

    @property
    def rules(self) -> tuple[ModerationRule, ...]:
        return self._rules

    def evaluate(self, content: str) -> tuple[RuleMatch, ...]:
        """返回所有命中的规则。"""

        matches: list[RuleMatch] = []
        for rule in self._rules:
            if not rule.enabled:
                continue
            if not self._matches(rule, content):
                continue
            matches.append(
                RuleMatch(
                    rule_id=rule.rule_id,
                    pattern=rule.pattern,
                    action=rule.action,
                    reason=rule.reason,
                    risk=rule.risk,
                )
            )
        return tuple(matches)

    def highest_action(self, content: str) -> ModerationAction:
        """返回命中规则中优先级最高的动作。"""

        matches = self.evaluate(content)
        if not matches:
            return ModerationAction.ALLOW
        return max(matches, key=lambda match: _ACTION_PRIORITY[match.action]).action

    def _matches(self, rule: ModerationRule, content: str) -> bool:
        if rule.is_regex:
            return self._compiled[rule.rule_id].search(content) is not None
        if rule.case_sensitive:
            return rule.pattern in content
        return rule.pattern.lower() in content.lower()

    @classmethod
    def from_keywords(
        cls,
        keywords: Iterable[str],
        *,
        action: ModerationAction = ModerationAction.WARN,
        risk: RiskLevel = RiskLevel.MEDIUM,
    ) -> RuleEngine:
        """从关键词列表快速构建规则引擎。"""

        rules = [
            ModerationRule(
                rule_id=f"keyword:{keyword}",
                pattern=keyword,
                action=action,
                reason=f"命中关键词：{keyword}",
                risk=risk,
            )
            for keyword in keywords
            if keyword
        ]
        return cls(rules)
