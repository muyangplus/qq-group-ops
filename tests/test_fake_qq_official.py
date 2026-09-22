"""官方 API 测试替身测试。"""

from __future__ import annotations

import unittest

from qq_group_ops.adapters.fake_qq_official import FakeQQOfficialAPI


class FakeQQOfficialAPITests(unittest.IsolatedAsyncioTestCase):
    async def test_send_group_message(self) -> None:
        api = FakeQQOfficialAPI()
        result = await api.send_group_message("g1", "hello", msg_id="m1")
        self.assertIn("id", result)
        self.assertEqual(api.sent_messages[0]["group_id"], "g1")
        self.assertEqual(api.sent_messages[0]["content"], "hello")
        self.assertEqual(api.sent_messages[0]["msg_id"], "m1")

    async def test_recall_and_mute(self) -> None:
        api = FakeQQOfficialAPI()
        await api.recall_group_message("g1", "m1")
        await api.mute_group_member("g1", "u1", 600)
        self.assertEqual(api.recalled_messages, [("g1", "m1")])
        self.assertEqual(api.muted_members, [("g1", "u1", 600)])

    async def test_join_request_flow(self) -> None:
        api = FakeQQOfficialAPI()
        api.add_join_request("g1", "u1", "想加入", request_id="r1")
        requests = await api.get_join_requests("g1")
        self.assertEqual(requests[0]["request_id"], "r1")
        await api.approve_join_request("g1", "u1", approve=True, reason="ok")
        self.assertEqual(api.join_request_reviews, [("g1", "u1", True, "ok")])


if __name__ == "__main__":
    unittest.main()
