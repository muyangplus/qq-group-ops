"""消息审核执行服务。

把规则引擎、群配置、官方 API 和审计日志连接起来。
不依赖 NoneBot2，便于单元测试；插件层只负责把事件转成 IncomingMessage。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from qq_group_ops.adapters.qq_official import QQOfficialAPI
from qq_group_ops.core.enums import AuditStatus, ModerationAction
from qq_group_ops.core.models import AuditRecord, IncomingMessage, RuleMatch
from qq_group_ops.services.audit import AuditLog, InMemoryAuditLog
from qq_group_ops.services.group_config import GroupConfig, GroupConfigStore
from qq_group_ops.services.moderation import RuleEngine


@dataclass(frozen=True, slots=True)
class MessageGuardResult:
    """一次消息审核的执行结果。"""

    group_id: str
    user_id: str
    message_id: str
    action: ModerationAction
    matches: tuple[RuleMatch, ...]
    executed: bool
    detail: str = ""


class MessageGuardService:
    """执行消息规则，并按动作调用官方 API。"""

    def __init__(
        self,
        api: QQOfficialAPI,
        rules: RuleEngine,
        config_store: GroupConfigStore,
        audit_log: AuditLog | None = None,
    ) -> None:
        self._api = api
        self._rules = rules
        self._config_store = config_store
        self._audit_log = audit_log or InMemoryAuditLog()

    async def handle_message(self, message: IncomingMessage) -> MessageGuardResult:
        config = self._config_store.get(message.group_id)
        if not config.enabled or not config.word_filter_enabled:
            return MessageGuardResult(
                group_id=message.group_id,
                user_id=message.user_id,
                message_id=message.message_id,
                action=ModerationAction.ALLOW,
                matches=(),
                executed=False,
                detail="disabled",
            )

        matches = self._rules.evaluate(message.content)
        if not matches:
            return MessageGuardResult(
                group_id=message.group_id,
                user_id=message.user_id,
                message_id=message.message_id,
                action=ModerationAction.ALLOW,
                matches=(),
                executed=False,
                detail="no_match",
            )

        action = self._rules.highest_action(message.content)
        executed, detail = await self._execute(action, message, config)
        audit_status = AuditStatus.EXECUTED if executed else AuditStatus.PENDING
        self._audit_log.append(
            AuditRecord(
                record_id=uuid4().hex,
                group_id=message.group_id,
                actor_id="bot",
                target_user_id=message.user_id,
                action=f"moderation:{action.value}",
                status=audit_status,
                reason=matches[0].reason,
            )
        )
        return MessageGuardResult(
            group_id=message.group_id,
            user_id=message.user_id,
            message_id=message.message_id,
            action=action,
            matches=matches,
            executed=executed,
            detail=detail,
        )

    async def _execute(
        self,
        action: ModerationAction,
        message: IncomingMessage,
        config: GroupConfig,
    ) -> tuple[bool, str]:
        if action == ModerationAction.WARN:
            await self._api.send_group_message(
                message.group_id,
                config.warning_message,
                msg_id=message.message_id,
            )
            return True, "warned"
        if action == ModerationAction.RECALL:
            await self._api.recall_group_message(message.group_id, message.message_id)
            return True, "recalled"
        if action == ModerationAction.MUTE:
            await self._api.mute_group_member(
                message.group_id,
                message.user_id,
                config.mute_duration_seconds,
            )
            return True, "muted"
        if action == ModerationAction.KICK:
            await self._api.remove_group_member(message.group_id, message.user_id)
            return True, "removed"
        if action == ModerationAction.REVIEW:
            return False, "queued_for_review"
        return False, "allow"
