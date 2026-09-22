"""管理员命令服务。

将 QQ 指令解析为业务操作；不依赖 NoneBot2，方便单元测试。
"""

from __future__ import annotations

from dataclasses import dataclass

from qq_group_ops.services.group_config import GroupConfigStore
from qq_group_ops.services.join_audit import JoinAuditService
from qq_group_ops.services.permissions import PermissionService

_HELP_TEXT = """可用指令：
/pending - 查看待审批入群申请
/approve <申请ID> - 通过入群申请
/reject <申请ID> [原因] - 拒绝入群申请
/rules - 查看当前群规则配置
/status - 查看当前群运行状态
/help - 显示帮助
""".strip()


@dataclass(frozen=True, slots=True)
class CommandResult:
    """命令执行结果。"""

    ok: bool
    text: str


class AdminCommandService:
    """解析并执行管理员命令。"""

    def __init__(
        self,
        permissions: PermissionService,
        join_audit: JoinAuditService,
        config_store: GroupConfigStore,
    ) -> None:
        self._permissions = permissions
        self._join_audit = join_audit
        self._config_store = config_store

    def handle(self, *, group_id: str, user_id: str, text: str) -> CommandResult:
        parts = text.strip().split(maxsplit=2)
        if not parts:
            return CommandResult(ok=False, text=_HELP_TEXT)

        command = parts[0].lstrip("/").lower()
        if command in {"help", "帮助"}:
            return CommandResult(ok=True, text=_HELP_TEXT)
        if command in {"pending", "待审批"}:
            return self._handle_pending(group_id, user_id)
        if command in {"approve", "通过"}:
            return self._handle_approve(group_id, user_id, parts)
        if command in {"reject", "拒绝"}:
            return self._handle_reject(group_id, user_id, parts)
        if command in {"rules", "规则"}:
            return self._handle_rules(group_id, user_id)
        if command in {"status", "状态"}:
            return self._handle_status(group_id, user_id)
        return CommandResult(ok=False, text=f"未知指令：{parts[0]}\n\n{_HELP_TEXT}")

    def _handle_pending(self, group_id: str, user_id: str) -> CommandResult:
        if not self._permissions.can_review_content(user_id, group_id):
            return CommandResult(ok=False, text="权限不足：需要审核员或以上权限。")
        pending = self._join_audit.pending(group_id)
        if not pending:
            return CommandResult(ok=True, text="当前没有待审批入群申请。")
        lines = ["待审批入群申请："]
        for index, request in enumerate(pending, start=1):
            reason = f" 理由：{request.reason}" if request.reason else ""
            lines.append(
                f"{index}. {request.request_id} 用户：{request.user_id}{reason}"
            )
        return CommandResult(ok=True, text="\n".join(lines))

    def _handle_approve(
        self,
        group_id: str,
        user_id: str,
        parts: list[str],
    ) -> CommandResult:
        if not self._permissions.can_approve_join(user_id, group_id):
            return CommandResult(ok=False, text="权限不足：需要群管理员或以上权限。")
        if len(parts) < 2:
            return CommandResult(ok=False, text="用法：/approve <申请ID>")
        request_id = parts[1].strip()
        try:
            self._join_audit.approve(request_id, user_id)
        except (KeyError, ValueError) as exc:
            return CommandResult(ok=False, text=f"审批失败：{exc}")
        return CommandResult(ok=True, text=f"已通过入群申请 {request_id}。")

    def _handle_reject(
        self,
        group_id: str,
        user_id: str,
        parts: list[str],
    ) -> CommandResult:
        if not self._permissions.can_approve_join(user_id, group_id):
            return CommandResult(ok=False, text="权限不足：需要群管理员或以上权限。")
        if len(parts) < 2:
            return CommandResult(ok=False, text="用法：/reject <申请ID> [原因]")
        request_id = parts[1].strip()
        reason = parts[2].strip() if len(parts) > 2 else ""
        try:
            self._join_audit.reject(request_id, user_id, reason)
        except (KeyError, ValueError) as exc:
            return CommandResult(ok=False, text=f"审批失败：{exc}")
        return CommandResult(ok=True, text=f"已拒绝入群申请 {request_id}。")

    def _handle_rules(self, group_id: str, user_id: str) -> CommandResult:
        if not self._permissions.can_review_content(user_id, group_id):
            return CommandResult(ok=False, text="权限不足：需要审核员或以上权限。")
        config = self._config_store.get(group_id)
        keywords = "、".join(config.keywords) if config.keywords else "（未配置）"
        return CommandResult(
            ok=True,
            text=(
                f"群 {group_id} 规则配置：\n"
                f"启用：{config.enabled}\n"
                f"关键词过滤：{config.word_filter_enabled}\n"
                f"关键词：{keywords}\n"
                f"入群审核：{config.join_audit_enabled}\n"
                f"自动通过：{config.auto_approve_join}"
            ),
        )

    def _handle_status(self, group_id: str, user_id: str) -> CommandResult:
        if not self._permissions.can_review_content(user_id, group_id):
            return CommandResult(ok=False, text="权限不足：需要审核员或以上权限。")
        config = self._config_store.get(group_id)
        return CommandResult(
            ok=True,
            text=(
                f"群 {group_id} 状态：\n"
                f"机器人启用：{config.enabled}\n"
                f"消息过滤：{config.word_filter_enabled}\n"
                f"入群审核：{config.join_audit_enabled}\n"
                f"导出功能：{config.export_enabled}\n"
                f"禁言时长：{config.mute_duration_seconds} 秒"
            ),
        )
