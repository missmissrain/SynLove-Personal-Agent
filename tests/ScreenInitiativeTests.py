"""功能：离线核对屏幕观察静默门槛、路由、预算、去重与视觉模型协议。

注册参数无；使用临时配置、假设备和假模型，不访问网络、不截图、不播放。
"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock
from screenInitiative.screenInitiative import ScreenInitiative
from screenInitiative.screenModel import ScreenModel
from screenInitiative.screenPolicy import ScreenPolicy


class ScreenInitiativeTests(unittest.TestCase):
    """验证用户状态变化能够阻止错误打扰，模型不能突破投递规则。"""

    def make_config(self):
        """无参数；返回非安静时段的测试配置，不影响生产设置。"""
        return {"enabled": True, "devices": ["pc"], "sampleSeconds": 90,
                "maxModelCallsPerHour": 8, "maxChatsPerDay": 6,
                "minChatIntervalSeconds": 1800, "speechExpiresSeconds": 90,
                "quietHours": ["00:00", "00:01"], "utcOffsetMinutes": 0,
                "voiceOutputs": {"pc": "pc"}, "allowSpeaker": {"pc": True}}

    def make_decision(self):
        """无参数；返回可被策略进一步否决的模拟建议。"""
        return {"speak": True, "busy": False, "sensitive": False, "confidence": 0.95,
                "text": "需要我帮你看一下这个问题吗？", "topicKey": "specificIssue",
                "emotion": "gentle", "modality": "auto"}

    def test_route_requires_fresh_unlocked_unambiguous_evidence(self):
        """新鲜活动和授权输出可选TTS；多设备、未知输出或文字建议改QQ，锁屏与敏感静默。"""
        now = 1795258800.0
        state = {"sampledAt": now, "idleSeconds": 1, "locked": False}
        devices = [{"id": "pc", "online": True, "capabilities": ["audio.playback"]}]
        cfg, decision = self.make_config(), self.make_decision()
        policy = ScreenPolicy(cfg)
        self.assertEqual(policy.choose_route(decision, "pc", {"pc": state}, devices, now)["mode"], "tts")
        self.assertEqual(policy.choose_route(decision, "pc", {"pc": state, "other": state},
                                            devices, now)["mode"], "qq")
        self.assertEqual(policy.choose_route(decision, "pc", {"pc": state}, devices, now + 31)["mode"], "silent")
        cfg["allowSpeaker"] = {}
        self.assertEqual(policy.choose_route(decision, "pc", {"pc": state}, devices, now)["mode"], "qq")
        decision["sensitive"] = True
        self.assertEqual(policy.choose_route(decision, "pc", {"pc": state}, devices, now)["mode"], "silent")

    def test_cooldown_and_restart_preserve_delivery_budget(self):
        """完成一次文字入队后，下一轮及新建实例均不得立即重复打扰。"""
        with tempfile.TemporaryDirectory() as folder:
            cfg = self.make_config()
            cfg["preferredChannel"] = "qq"
            terminal, model = Mock(), Mock()
            terminal.list_devices.return_value = [{"id": "pc", "online": True,
                                                    "capabilities": ["screen.observe"]}]
            terminal.observe_device.side_effect = lambda *args: {
                "sampledAt": time.time(), "idleSeconds": 1, "locked": False}
            terminal.read_frame.return_value = (b"fakeImage", {})
            model.decide_screen.return_value = self.make_decision()
            worker = ScreenInitiative(folder, Mock(), terminal, model)
            worker.primary_idle = lambda: True
            worker.tick_once(cfg)
            terminal.queue_text.assert_called_once()
            worker.tick_once(cfg)
            restarted = ScreenInitiative(folder, Mock(), terminal, model)
            restarted.primary_idle = lambda: True
            restarted.tick_once(cfg)
            terminal.queue_text.assert_called_once()
            self.assertNotIn("fakeImage", worker.state_path.read_text("utf-8"))
            self.assertNotIn("需要我", worker.state_path.read_text("utf-8"))

    def test_silent_and_dry_run_never_deliver(self):
        """模型不想开口或验收模式均不调用合成、文字入队或播放器。"""
        with tempfile.TemporaryDirectory() as folder:
            cfg = self.make_config()
            cfg["dryRun"] = True
            terminal, model, pipe = Mock(), Mock(), Mock()
            terminal.list_devices.return_value = [{"id": "pc", "online": True,
                                                    "capabilities": ["screen.observe", "audio.playback"]}]
            terminal.observe_device.side_effect = lambda *args: {
                "sampledAt": time.time(), "idleSeconds": 1, "locked": False}
            terminal.read_frame.return_value = (b"fakeImage", {})
            model.decide_screen.return_value = self.make_decision()
            worker = ScreenInitiative(folder, pipe, terminal, model)
            worker.primary_idle = lambda: True
            worker.tick_once(cfg)
            terminal.queue_text.assert_not_called()
            terminal.play_audio.assert_not_called()
            pipe.process_reply.assert_not_called()

    def test_model_sends_reference_image_via_responses_without_tools(self):
        """主模型收到真实图片类型，输出非法字段被拒绝，不允许模型提供收件人或工具。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config").mkdir()
            (root / "prompts").mkdir()
            (root / "prompts/ScreenInitiative.md").write_text("测试提示词", "utf-8")
            (root / "config/modelConfig.json").write_text(json.dumps({
                "defaultModel": {"provider": "test", "model": "vision"},
                "providers": {"test": {"api": "openai-responses", "baseURL": "https://example.invalid/v1"}},
            }), "utf-8")
            (root / "config/secrets.json").write_text(json.dumps({
                "providers": {"test": {"apiKey": "fakeOfflineCredential"}}}), "utf-8")
            call = Mock(return_value={"output": [{"type": "message", "content": [
                {"type": "output_text", "text": json.dumps(self.make_decision())}]}]})
            model = ScreenModel(root, call)
            self.assertTrue(model.decide_screen(b"jpeg", {})["speak"])
            payload = call.call_args.args[1]
            self.assertEqual(payload["input"][0]["content"][1]["type"], "input_image")
            self.assertFalse(payload["store"])
            self.assertNotIn("tools", payload)
            with self.assertRaises(ValueError):
                model.validate_decision({**self.make_decision(), "confidence": float("nan")})
            # 失败后的回退也受真实请求预算限制，不能在一轮内突破额度。
            config = json.loads((root / "config/modelConfig.json").read_text("utf-8"))
            config["failover"] = {"enabled": True, "order": [{"provider": "test", "model": "fallback"}]}
            (root / "config/modelConfig.json").write_text(json.dumps(config), "utf-8")
            call.reset_mock()
            call.side_effect = OSError("fakeFailure")
            attempts = iter((True, False))
            model.before_request = lambda: next(attempts)
            with self.assertRaises(RuntimeError):
                model.decide_screen(b"jpeg", {})
            self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()
