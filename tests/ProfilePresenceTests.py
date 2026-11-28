"""功能：验证人物画像作息先验只补充实时证据，不覆盖耳机与外出定位。

注册参数无；只使用固定时间、脱敏设备和临时配置，不调用模型、定位或摄像头。
"""
import unittest
from profilePresence.ProfilePresenceReasoner import ProfilePresenceReasoner
from profilePresence.GraphProfileAdapter import GraphProfileAdapter


class ProfilePresenceTests(unittest.TestCase):
    """画像推理必须可解释、可衰减，并在实时证据出现时让位。"""

    def setUp(self):
        """无参数；构造周一工作时段和下班时段的假画像。"""
        self.profile = {"utcOffsetMinutes": 480, "schedule": [
            {"weekdays": [0, 1, 2, 3, 4], "start": "09:00", "end": "18:00",
             "deviceId": "work", "confidence": .72},
            {"weekdays": [0, 1, 2, 3, 4], "start": "18:00", "end": "23:00",
             "deviceId": "home", "confidence": .42}]}

    def test_workday_schedule_prefers_work_device(self):
        """工作日上班时间没有实时证据时只产生大黄蜂画像候选。"""
        result = ProfilePresenceReasoner(self.profile).reason([], 1719219600)
        self.assertEqual(result["candidates"][0]["deviceId"], "work")
        self.assertEqual(result["candidates"][0]["reason"], "profileSchedulePrior")

    def test_outside_location_suppresses_profile_prior(self):
        """手机定位确认外出时不套用电脑工作时段先验。"""
        result = ProfilePresenceReasoner(self.profile).reason(
            [], 1719219600, {"outside": True})
        self.assertEqual(result["candidates"], [])

    def test_realtime_evidence_beats_profile_prior(self):
        """新鲜耳机媒体输出高于画像工作地点。"""
        evidence = [{"deviceId": "home", "score": .87, "reason": "bluetoothMediaOutput"}]
        result = ProfilePresenceReasoner(self.profile).reason(evidence, 1719219600)
        self.assertEqual(result["candidates"][0]["deviceId"], "home")

    def test_profile_is_loaded_from_graph_snapshot_infrastructure(self):
        """画像先验来自现有graph_snapshot适配器，而不是另一份事实数据库。"""
        adapter = GraphProfileAdapter(lambda: {
            "nodes": [{"name": "主人", "notes": "作息：上班 09:00-18:00"}],
            "edges": []})
        profile = adapter.load_profile()
        self.assertEqual(profile["source"], "graphSnapshot")
        self.assertEqual(profile["schedule"][0]["deviceId"], "androidGateway")


if __name__ == "__main__":
    unittest.main()
