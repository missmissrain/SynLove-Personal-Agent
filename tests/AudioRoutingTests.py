"""功能：离线验证统一音频路由、跨会话设置、摄像头强证据与QQ询问去重。

注册参数无；使用假设备、临时文件和假QQ，不调用摄像头、模型或真实音频。
"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock
from voiceRouting.AudioRoutePolicy import AudioRoutePolicy
from voiceRouting.AudioRouteService import AudioRouteService
from voiceRouting.AudioRouteStore import AudioRouteStore
from screenInitiative.screenPolicy import ScreenPolicy
from voiceRouting.AudioRouteDelivery import AudioRouteDelivery


class AudioRoutingTests(unittest.TestCase):
    """同时检查选择、拒绝、证据衰减和设置持久化，不仅检查成功分支。"""

    def setUp(self):
        """无参数；准备两台在线假电脑和相同的新鲜输入，不触碰生产实例。"""
        self.now = time.time()
        self.devices = [{"id": key, "enabled": True, "online": True,
                         "capabilities": ["audio.playback", "screen.observe", "camera.capture"]}
                        for key in ("a", "b")]
        self.states = {key: self.make_state() for key in ("a", "b")}
        self.cfg = {"devices": ["a", "b"], "outputs": {}, "allowSpeaker": {}}
        self.pref = {"mode": "auto", "target": None, "revision": 1}

    def make_state(self, media=False, idle=1):
        """media为真实蓝牙媒体输出、idle为空闲秒；生成可校验时间戳。"""
        return {"sampledAt": self.now, "locked": False, "idleSeconds": idle,
                "audio": {"available": True, "sampledAt": self.now,
                          "bluetoothMediaOutput": media, "bluetoothHeadphonesConnected": media}}

    def resolve(self, purpose="initiative"):
        """purpose区分主动与回复，所有证据由测试显式提供。"""
        return AudioRoutePolicy(self.cfg).choose_route(
            "a", purpose, self.pref, self.devices, self.states, self.now)

    def test_single_headphone_beats_two_active_keyboards(self):
        """两台同时操作，唯一实际耳机媒体输出足以明确选择播放去向。"""
        self.states["b"] = self.make_state(True)
        self.assertEqual(self.resolve()["target"], "b")

    def test_listening_without_keyboard_is_not_rejected(self):
        """戴耳机听内容无需持续敲键盘，仍可主动语音。"""
        self.states["b"] = self.make_state(True, idle=600)
        self.assertEqual(self.resolve()["target"], "b")

    def test_paired_only_or_stale_audio_does_not_allow_speaker(self):
        """仅配对或过期的耳机采样，不作为当前私密媒体输出。"""
        self.states["a"]["audio"]["bluetoothHeadphonesConnected"] = True
        self.assertEqual(self.resolve()["mode"], "qq")
        self.states["a"] = self.make_state(True)
        self.states["a"]["audio"]["sampledAt"] = self.now - 60
        self.assertEqual(self.resolve()["mode"], "qq")

    def test_conflicting_headphone_outputs_ask_user(self):
        """两台耳机输出同样可信，不盲目挑一个。"""
        self.states = {key: self.make_state(True) for key in ("a", "b")}
        self.assertTrue(self.resolve()["needsTarget"])

    def test_bluetooth_media_beats_permanently_plugged_wired_headphones(self):
        """有线耳机插孔常驻不能与真实蓝牙媒体同权重，优先唯一蓝牙输出。"""
        self.states["a"]["audioPrivate"] = True
        self.states["a"]["audio"]["defaultOutput"] = {"headphones": True}
        self.states["b"] = self.make_state(True)
        self.assertEqual(self.resolve()["target"], "b")

    def test_explicit_target_overrides_automatic_headphone(self):
        """主人指定a，即使b戴着耳机也不能改投b。"""
        self.pref.update(mode="tts", target="a")
        self.states["b"] = self.make_state(True)
        self.assertEqual(self.resolve()["target"], "a")

    def test_explicit_offline_target_never_falls_back(self):
        """明确目标离线时必须QQ澄清，不使用其他在线设备。"""
        self.pref.update(mode="tts", target="a")
        self.devices[0]["online"] = False
        self.states["b"] = self.make_state(True)
        self.assertEqual(self.resolve()["reason"], "explicitTargetUnavailable")
        self.assertIsNone(self.resolve()["target"])

    def test_explicit_text_overrides_headphones(self):
        """明确不要说话优先于耳机和高分证据。"""
        self.pref["mode"] = "qq"
        self.states["a"] = self.make_state(True)
        self.assertEqual(self.resolve()["mode"], "qq")

    def test_camera_owner_is_strong_but_camera_existence_is_not(self):
        """确实识别主人可消除歧义，只有camera能力或普通人脸不行。"""
        self.pref["mode"] = "tts"
        self.assertTrue(self.resolve()["needsTarget"])
        self.states["b"]["camera"] = {"observedAt": self.now, "present": True,
                                      "ownerConfidence": .96, "wearingHeadphones": False}
        self.assertEqual(self.resolve()["target"], "b")
        self.states["b"]["camera"]["ownerConfidence"] = .5
        self.assertTrue(self.resolve()["needsTarget"])
        self.states["b"]["camera"].update(ownerConfidence=.96, observedAt=self.now - 120)
        self.assertTrue(self.resolve()["needsTarget"])

    def test_camera_does_not_imply_headphone_output(self):
        """画面看到戴耳机不能证明扬声器正在走耳机，仍须媒体证据或明确授权。"""
        self.states["b"]["camera"] = {"observedAt": self.now, "present": True,
                                      "ownerConfidence": .99, "wearingHeadphones": True}
        self.assertEqual(self.resolve()["mode"], "qq")

    def test_voice_permission_without_target_uses_clear_presence(self):
        """允许语音且只有一台可信在场时，可以选择该设备的扬声器。"""
        self.pref["mode"] = "tts"
        self.states["b"] = self.make_state(idle=1000)
        self.assertEqual(self.resolve()["target"], "a")

    def test_reply_mapping_keeps_recording_and_playback_independent(self):
        """自动模式保留既有回复映射，主动模式不能因此任意外放。"""
        self.cfg["outputs"] = {"a": "b"}
        self.assertEqual(self.resolve("reply")["target"], "b")
        self.assertEqual(self.resolve()["mode"], "qq")

    def test_store_survives_restart_and_explicit_clear(self):
        """新实例读取相同偏好；清除后回到自动，版本变化供播放前复核。"""
        with tempfile.TemporaryDirectory() as folder:
            store = AudioRouteStore(folder)
            state = store.set_preference({"action": "set", "target": "b"}, self.devices, self.now)
            self.assertEqual(AudioRouteStore(folder).read_state(self.now)["target"], "b")
            cleared = store.set_preference({"action": "clear"}, self.devices, self.now + 1)
            self.assertEqual(cleared["mode"], "auto")
            self.assertGreater(cleared["revision"], state["revision"])
            with self.assertRaises(ValueError):
                store.set_preference({"action": "set", "target": "notRegistered"}, self.devices, self.now)

    def test_expiry_and_invalid_camera_evidence(self):
        """限时授权到期即撤销，不接受NaN、过期或乱序摄像头观察。"""
        with tempfile.TemporaryDirectory() as folder:
            store = AudioRouteStore(folder)
            store.set_preference({"action": "set", "target": "b", "durationSeconds": 30},
                                 self.devices, self.now)
            self.assertAlmostEqual(
                store.read_state(self.now + 31)["preferenceConfidence"], .999722, places=5)
            body = {"deviceId": "b", "observedAt": self.now, "present": True,
                    "ownerConfidence": .98, "wearingHeadphones": None}
            store.record_camera(body, self.devices, self.now)
            store.record_camera({**body, "observedAt": self.now - 1, "present": False},
                                self.devices, self.now)
            self.assertTrue(store.read_state(self.now)["cameras"]["b"]["present"])
            for patch in ({"ownerConfidence": float("nan")}, {"observedAt": self.now - 120},
                          {"wearingHeadphones": 1}):
                with self.assertRaises(ValueError):
                    store.record_camera({**body, **patch}, self.devices, self.now)

    def test_explicit_preference_defaults_to_one_hour_then_returns_to_inference(self):
        """未提供有效期时只保留一小时，之后恢复自动推理而不是永久锁定设备。"""
        with tempfile.TemporaryDirectory() as folder:
            store = AudioRouteStore(folder)
            state = store.set_preference({"action": "set", "target": "b"},
                                         self.devices, self.now)
            self.assertEqual(state["expiresAt"], self.now + 3600)
            fading = store.read_state(self.now + 5400)
            self.assertAlmostEqual(fading["preferenceConfidence"], .5, places=5)
            expired = store.read_state(self.now + 7201)
            self.assertEqual(expired["mode"], "auto")
            self.assertIsNone(expired["target"])
            self.assertTrue(expired["expired"])

    def test_explicit_target_weight_fades_before_auto_inference(self):
        """指定设备在衰减期仍可使用，但置信度随时间下降。"""
        self.pref.update(mode="tts", target="a", preferenceConfidence=.25)
        route = self.resolve()
        self.assertEqual(route["target"], "a")
        self.assertAlmostEqual(route["confidence"], .25, places=5)
        self.pref["preferenceConfidence"] = 0
        self.states["b"] = self.make_state(True)
        self.assertEqual(self.resolve()["target"], "b")

    def test_qq_question_is_deduplicated_and_status_is_read_only(self):
        """未知目标只问一次，纯查询不能写设置或触发QQ。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config").mkdir()
            (root / "config/audioRouting.json").write_text(json.dumps(self.cfg), "utf-8")
            terminal = Mock()
            terminal.list_devices.return_value = self.devices
            terminal.observe_device.side_effect = lambda key, args: self.states[key]
            service = AudioRouteService(root, terminal)
            before = service.store.read_state()
            route = service.handle_request({"action": "status"})["route"]
            self.assertEqual(service.store.read_state(), before)
            terminal.queue_text.assert_not_called()
            self.assertTrue(service.ask_target(route)["asked"])
            self.assertFalse(service.ask_target(route)["asked"])
            terminal.queue_text.assert_called_once()
            self.assertFalse(service.store.reserve_question(
                route["reason"], time.time() + 1900))

    def test_unified_policy_keeps_sensitive_and_quiet_veto(self):
        """明确语音目标不能突破主动观察的敏感内容与勿扰门槛。"""
        router = Mock()
        router.resolve_for_states.return_value = {"mode": "tts", "target": "b"}
        policy = ScreenPolicy({"quietHours": ["00:00", "00:01"], "utcOffsetMinutes": 0}, router)
        decision = {"speak": True, "busy": False, "sensitive": True, "confidence": .99}
        self.assertEqual(policy.choose_route(decision, "a", {}, [], 1795258800)["mode"], "silent")
        router.resolve_for_states.assert_not_called()

    def test_short_reply_uses_fixed_pipeline_and_true_playback_receipt(self):
        """文本通道复用固定音色流水线，只有真实播放回执才写played。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            routes, terminal, pipeline = Mock(), Mock(), Mock()
            routes.root = root
            route = {"mode": "tts", "target": "b", "revision": 1, "reason": "headphoneOutput"}
            routes.read_snapshot.return_value = ({}, terminal, [], {}, {})
            routes.resolve_route.return_value = route
            path = root / "runtime/voice/test.wav"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"offlineFakeWav")
            pipeline.process_reply.return_value = {"audioPath": str(path)}
            terminal.play_audio.return_value = {"remotePlaybackCompleted": True}
            terminal.play_audio.side_effect = lambda *a, **k: (
                {"remotePlaybackCompleted": True} if a[4]() else {})
            value = AudioRouteDelivery(routes, pipeline).deliver_reply(
                {"action": "speak", "text": "我在呢。", "emotion": "gentle"})
            self.assertEqual(value["state"], "played")
            self.assertEqual(pipeline.process_reply.call_args.args[0]["ttsEmotion"], "gentle")
            self.assertFalse(path.exists())
            self.assertIn('"state": "played"', (root / "runtime/voiceRouting/delivery.jsonl").read_text())

    def test_headphones_unplugged_before_play_never_confirm_success(self):
        """路由原因变为扬声器回退，即便设备ID相同也取消播放。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            routes, terminal, pipeline = Mock(), Mock(), Mock()
            routes.root = root
            old = {"mode": "tts", "target": "b", "revision": 1, "reason": "headphoneOutput"}
            routes.read_snapshot.return_value = ({}, terminal, [], {}, {})
            routes.resolve_route.side_effect = [old, {**old, "reason": "replyOutput"}]
            path = root / "runtime/voice/test.wav"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"offlineFakeWav")
            pipeline.process_reply.return_value = {"audioPath": str(path)}
            terminal.play_audio.side_effect = lambda *a, **k: (
                {"remotePlaybackCompleted": True} if a[4]() else {})
            with self.assertRaises(RuntimeError):
                AudioRouteDelivery(routes, pipeline).deliver_reply(
                    {"action": "speak", "text": "你好", "emotion": "neutral"})
            self.assertFalse(path.exists())
            self.assertIn('"state": "failed"', (root / "runtime/voiceRouting/delivery.jsonl").read_text())

    def test_uncertain_reply_asks_on_qq_without_tts(self):
        """不能决定目标时通过QQ问，不先消耗TTS或让原手机外放。"""
        with tempfile.TemporaryDirectory() as folder:
            routes, terminal, pipeline = Mock(), Mock(), Mock()
            routes.root = Path(folder)
            routes.read_snapshot.return_value = ({}, terminal, [], {}, {})
            routes.resolve_route.return_value = {"mode": "qq", "needsTarget": True}
            routes.ask_target.return_value = {"asked": True}
            value = AudioRouteDelivery(routes, pipeline).deliver_reply(
                {"action": "speak", "text": "我在呢。", "emotion": "gentle"})
            self.assertEqual(value["state"], "textQueued")
            pipeline.process_reply.assert_not_called()
            routes.ask_target.assert_called_once()
            terminal.queue_text.assert_called_once()


if __name__ == "__main__":
    unittest.main()
