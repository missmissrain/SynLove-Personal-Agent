"""功能：离线验证蓝牙先验、冲突证据、失联和排除推理，不调用模型或真实设备。"""
import tempfile
import time
import unittest
from unittest.mock import Mock
from screenInitiative.PresenceInference import PresenceInference
from screenInitiative.screenInitiative import ScreenInitiative
from screenInitiative.screenPolicy import ScreenPolicy


class PresenceInferenceTests(unittest.TestCase):
    """强线索需要新鲜且可验证，离开电脑不能自动等价于外出。"""

    def make_state(self, now, idle=1, locked=False, media=False, connected=False):
        """now/idle/locked为桌面状态，media/connected为已验证蓝牙耳机证据。"""
        return {"sampledAt": now, "idleSeconds": idle, "locked": locked,
                "audio": {"sampledAt": now, "available": True,
                          "bluetoothMediaOutput": media,
                          "bluetoothHeadphonesConnected": connected}}

    def infer(self, states, old=None, offline=()):
        """states为两台假设备状态，old为上轮推断，offline列出不可观测设备。"""
        cfg = {"devices": ["a", "b"]}
        devices = [{"id": key, "online": key not in offline} for key in cfg["devices"]]
        return PresenceInference(cfg).infer_presence(devices, states, old or {}, 10000)

    def test_bluetooth_media_is_high_weight_without_claiming_identity(self):
        """没有键鼠输入时蓝牙媒体可提高评分，仍保持推断状态。"""
        result = self.infer({"a": self.make_state(10000, 400, media=True, connected=True),
                             "b": self.make_state(10000, 2000)})
        self.assertEqual(result["deviceId"], "a")
        self.assertEqual(result["state"], "inferred")
        self.assertEqual(result["confidence"], .87)
        self.assertEqual(result["physicalLocation"], "unknown")

    def test_connection_only_is_weaker_than_media_output(self):
        """已连接但未作为媒体输出的耳机不能获得相同评分。"""
        result = self.infer({"a": self.make_state(10000, 400, connected=True),
                             "b": self.make_state(10000, 400)})
        self.assertEqual(result["confidence"], .72)

    def test_pairing_stale_audio_and_speaker_do_not_raise_score(self):
        """单独配对标志、旧音频状态或普通扬声器不能成为蓝牙耳机先验。"""
        for state in [self.make_state(10000, 400), self.make_state(9900, 400, media=True)]:
            state["bluetoothPaired"] = True
            result = self.infer({"a": state, "b": self.make_state(10000, 2000)})
            self.assertLessEqual(result["confidence"], .60)

    def test_conflicting_recent_devices_are_ambiguous(self):
        """两台设备同时近期使用时不把一台的耳机连接判成绝对确定。"""
        result = self.infer({"a": self.make_state(10000, 2, media=True),
                             "b": self.make_state(10000, 1)})
        self.assertTrue(result["ambiguous"])
        self.assertEqual(result["confidence"], .60)

    def test_exclusion_requires_all_devices_and_sustained_absence(self):
        """全部可观测电脑持续无活动才输出离开电脑，物理地点仍未知。"""
        states = {key: self.make_state(10000, 2000) for key in ("a", "b")}
        pending = self.infer(states)
        self.assertEqual(pending["activity"], "possiblyAwayFromComputers")
        result = self.infer(states, {"absenceSince": 9600})
        self.assertEqual(result["activity"], "awayFromComputers")
        self.assertIsNone(result["deviceId"])
        self.assertIn("outsidePossible", result["locationHypotheses"])
        self.assertEqual(result["physicalLocation"], "unknown")
        for missing in ("a", "b"):
            partial = self.infer(states, {"absenceSince": 9600}, offline=[missing])
            self.assertNotEqual(partial["activity"], "awayFromComputers")

    def test_locked_bluetooth_media_blocks_exclusion(self):
        """锁屏仍有蓝牙耳机媒体证据时，不能通过全锁屏排除用户。"""
        result = self.infer({"a": self.make_state(10000, None, True, True, True),
                             "b": self.make_state(10000, None, True)}, {"absenceSince": 9600})
        self.assertEqual(result["deviceId"], "a")
        self.assertNotEqual(result["activity"], "awayFromComputers")

    def test_unknown_devices_reset_absence_hold(self):
        """状态缺失会中断连续排除，不能跨越观测空白累计离开时间。"""
        result = self.infer({}, {"absenceSince": 9600})
        self.assertNotIn("absenceSince", result)
        self.assertEqual(result["state"], "unknown")

    def test_non_finite_and_future_evidence_are_rejected(self):
        """畸形数值及明显未来采样不能生成高置信结论。"""
        result = self.infer({"a": self.make_state(10000, float("nan")),
                             "b": self.make_state(10100, 0, media=True)})
        self.assertEqual(result["state"], "unknown")

    def test_presence_runs_during_cooldown_without_model_or_camera(self):
        """冷却期间仍查询轻量状态，不截图、不调用视觉或语音模型。"""
        with tempfile.TemporaryDirectory() as folder:
            terminal, model, pipe = Mock(), Mock(), Mock()
            terminal.list_devices.return_value = [
                {"id": "a", "online": True, "capabilities": ["screen.observe"]}]
            terminal.observe_device.side_effect = lambda *args: self.make_state(time.time(), 400, media=True)
            worker = ScreenInitiative(folder, pipe, terminal, model)
            worker.state["lastChat"] = time.time()
            cfg = {"enabled": True, "devices": ["a"], "quietHours": ["00:00", "23:59"],
                   "maxChatsPerDay": 6, "maxModelCallsPerHour": 8,
                   "minChatIntervalSeconds": 1800, "presenceIntervalSeconds": 90}
            worker.tick_once(cfg)
            self.assertEqual(worker.state["presence"]["deviceId"], "a")
            self.assertEqual(worker.status["state"], "quietOrCooldown")
            terminal.read_frame.assert_not_called()
            model.decide_screen.assert_not_called()
            pipe.process_reply.assert_not_called()

    def test_new_sample_is_not_misread_as_future_after_slow_network(self):
        """采样开始与结束间隔超过5秒时，使用完成时间验证返回状态。"""
        with tempfile.TemporaryDirectory() as folder:
            terminal = Mock()
            terminal.list_devices.return_value = [
                {"id": "a", "online": True, "capabilities": ["screen.observe"]}]
            terminal.observe_device.return_value = self.make_state(time.time(), 1)
            worker = ScreenInitiative(folder, Mock(), terminal)
            result = worker.update_presence({"devices": ["a"]}, terminal, ScreenPolicy({}),
                                            time.time() - 20, force=True)
            self.assertEqual(result["state"], "known")

    def test_source_headphones_do_not_authorize_other_device_speaker(self):
        """采音设备有耳机不等于另一台输出设备可外放，不允许跨设备误用证据。"""
        cfg = {"quietHours": ["00:00", "00:01"], "voiceOutputs": {"a": "b"},
               "allowSpeaker": {"b": False}}
        now = 1795404000
        state = self.make_state(now, 1, media=True)
        state["audioPrivate"] = True
        route = ScreenPolicy(cfg).choose_route(
            {"speak": True, "confidence": .95, "modality": "tts"}, "a", {"a": state},
            [{"id": "b", "online": True, "capabilities": ["audio.playback"]}], now)
        self.assertEqual(route["mode"], "qq")

    def test_long_listening_and_unknown_bluetooth_keep_their_meanings(self):
        """长时间没有键鼠输入仍可能戴耳机听歌，未知蓝牙不能变成明确未连接。"""
        result = self.infer({"a": self.make_state(10000, 4000, media=True, connected=True),
                             "b": self.make_state(10000, 5000)}, {"absenceSince": 9600})
        self.assertEqual(result["deviceId"], "a")
        self.assertEqual(result["confidence"], .68)
        self.assertNotEqual(result["activity"], "awayFromComputers")
        value = self.make_state(10000)
        value["audio"]["bluetoothHeadphonesConnected"] = None
        value["audio"]["bluetoothMediaOutput"] = None
        unknown = self.infer({"a": value})
        self.assertIsNone(unknown["evidence"][0]["bluetoothMediaOutput"])

    def test_short_outage_does_not_move_user_to_an_idle_computer(self):
        """一台强证据设备短暂掉线时，不用另一台十分钟前的输入强行改判。"""
        result = self.infer({"b": self.make_state(10000, 600)},
                            {"deviceId": "a", "confidence": .95, "expiresAt": 11000}, offline=["a"])
        self.assertEqual(result["deviceId"], "a")
        self.assertEqual(result["state"], "stale")
