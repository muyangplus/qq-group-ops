"""活动报名服务。

Phase 2 实现完整活动能力；当前先提供不依赖 QQ 平台的可测试核心。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from uuid import uuid4

from qq_group_ops.core.enums import ActivityStatus
from qq_group_ops.core.models import utc_now


@dataclass(frozen=True, slots=True)
class Activity:
    """一个群活动。"""

    activity_id: str
    group_id: str
    title: str
    created_by: str
    description: str = ""
    capacity: int | None = None
    status: ActivityStatus = ActivityStatus.DRAFT
    created_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True, slots=True)
class ActivityRegistration:
    """一条活动报名记录。"""

    registration_id: str
    activity_id: str
    group_id: str
    user_id: str
    display_name: str = ""
    note: str = ""
    created_at: datetime = field(default_factory=utc_now)


class ActivityService:
    """活动创建、开放、报名、关闭和取消。"""

    def __init__(self) -> None:
        self._activities: dict[str, Activity] = {}
        self._registrations: dict[str, ActivityRegistration] = {}

    def create_activity(
        self,
        group_id: str,
        title: str,
        created_by: str,
        *,
        description: str = "",
        capacity: int | None = None,
        activity_id: str | None = None,
    ) -> Activity:
        if not title.strip():
            raise ValueError("activity title must not be empty")
        if capacity is not None and capacity <= 0:
            raise ValueError("activity capacity must be positive")
        resolved_id = activity_id or uuid4().hex
        if resolved_id in self._activities:
            raise ValueError(f"duplicate activity id: {resolved_id}")
        activity = Activity(
            activity_id=resolved_id,
            group_id=group_id,
            title=title.strip(),
            created_by=created_by,
            description=description,
            capacity=capacity,
        )
        self._activities[resolved_id] = activity
        return activity

    def get_activity(self, activity_id: str) -> Activity:
        try:
            return self._activities[activity_id]
        except KeyError as exc:
            raise KeyError(f"activity not found: {activity_id}") from exc

    def list_activities(self, group_id: str) -> tuple[Activity, ...]:
        activities = [activity for activity in self._activities.values() if activity.group_id == group_id]
        return tuple(sorted(activities, key=lambda activity: activity.created_at))

    def open_activity(self, activity_id: str) -> Activity:
        return self._set_status(activity_id, ActivityStatus.OPEN)

    def close_activity(self, activity_id: str) -> Activity:
        return self._set_status(activity_id, ActivityStatus.CLOSED)

    def cancel_activity(self, activity_id: str) -> Activity:
        return self._set_status(activity_id, ActivityStatus.CANCELLED)

    def register(
        self,
        activity_id: str,
        user_id: str,
        *,
        display_name: str = "",
        note: str = "",
        registration_id: str | None = None,
    ) -> ActivityRegistration:
        activity = self.get_activity(activity_id)
        if activity.status != ActivityStatus.OPEN:
            raise ValueError(f"activity is not open: {activity_id}")
        registrations = self.list_registrations(activity_id)
        if activity.capacity is not None and len(registrations) >= activity.capacity:
            raise ValueError(f"activity is full: {activity_id}")
        if any(registration.user_id == user_id for registration in registrations):
            raise ValueError(f"duplicate registration: {activity_id}/{user_id}")

        resolved_id = registration_id or uuid4().hex
        if resolved_id in self._registrations:
            raise ValueError(f"duplicate registration id: {resolved_id}")
        registration = ActivityRegistration(
            registration_id=resolved_id,
            activity_id=activity_id,
            group_id=activity.group_id,
            user_id=user_id,
            display_name=display_name,
            note=note,
        )
        self._registrations[resolved_id] = registration
        return registration

    def list_registrations(self, activity_id: str) -> tuple[ActivityRegistration, ...]:
        registrations = [
            registration
            for registration in self._registrations.values()
            if registration.activity_id == activity_id
        ]
        return tuple(sorted(registrations, key=lambda registration: registration.created_at))

    def cancel_registration(self, registration_id: str, user_id: str) -> ActivityRegistration:
        try:
            registration = self._registrations[registration_id]
        except KeyError as exc:
            raise KeyError(f"registration not found: {registration_id}") from exc
        if registration.user_id != user_id:
            raise PermissionError("cannot cancel another user's registration")
        del self._registrations[registration_id]
        return registration

    def _set_status(self, activity_id: str, status: ActivityStatus) -> Activity:
        activity = self.get_activity(activity_id)
        updated = replace(activity, status=status)
        self._activities[activity_id] = updated
        return updated
