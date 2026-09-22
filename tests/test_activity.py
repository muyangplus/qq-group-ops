"""活动报名服务测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.core.enums import ActivityStatus
from qq_group_ops.services.activity import ActivityService


class ActivityServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = ActivityService()

    def test_create_activity_defaults_to_draft(self) -> None:
        activity = self.service.create_activity("g1", "周末活动", "admin", activity_id="a1")
        self.assertEqual(activity.status, ActivityStatus.DRAFT)
        self.assertEqual(activity.group_id, "g1")
        self.assertEqual(self.service.get_activity("a1"), activity)

    def test_open_and_register(self) -> None:
        activity = self.service.create_activity("g1", "周末活动", "admin", activity_id="a1")
        self.service.open_activity(activity.activity_id)
        registration = self.service.register("a1", "u1", display_name="小明")
        self.assertEqual(registration.group_id, "g1")
        self.assertEqual(self.service.list_registrations("a1"), (registration,))

    def test_register_requires_open_activity(self) -> None:
        self.service.create_activity("g1", "周末活动", "admin", activity_id="a1")
        with self.assertRaises(ValueError):
            self.service.register("a1", "u1")

    def test_capacity_limit(self) -> None:
        self.service.create_activity("g1", "限额活动", "admin", capacity=1, activity_id="a1")
        self.service.open_activity("a1")
        self.service.register("a1", "u1")
        with self.assertRaises(ValueError):
            self.service.register("a1", "u2")

    def test_duplicate_registration_rejected(self) -> None:
        self.service.create_activity("g1", "活动", "admin", activity_id="a1")
        self.service.open_activity("a1")
        self.service.register("a1", "u1")
        with self.assertRaises(ValueError):
            self.service.register("a1", "u1")

    def test_cancel_registration(self) -> None:
        self.service.create_activity("g1", "活动", "admin", activity_id="a1")
        self.service.open_activity("a1")
        registration = self.service.register("a1", "u1", registration_id="r1")
        self.service.cancel_registration("r1", "u1")
        self.assertEqual(self.service.list_registrations("a1"), ())
        self.assertEqual(registration.user_id, "u1")

    def test_cancel_activity_blocks_registration(self) -> None:
        self.service.create_activity("g1", "活动", "admin", activity_id="a1")
        self.service.cancel_activity("a1")
        with self.assertRaises(ValueError):
            self.service.register("a1", "u1")

    def test_list_activities_filters_by_group(self) -> None:
        self.service.create_activity("g1", "活动1", "admin", activity_id="a1")
        self.service.create_activity("g2", "活动2", "admin", activity_id="a2")
        activities = self.service.list_activities("g1")
        self.assertEqual([activity.activity_id for activity in activities], ["a1"])


if __name__ == "__main__":
    unittest.main()
