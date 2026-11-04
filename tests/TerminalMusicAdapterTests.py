"""远程音乐适配测试：核对终端API设备路由、未知结果不重放与所属播放ID限制；不连接真实设备。"""
import sys
import tempfile
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kugou.client.RemoteMusicPlayback import RemoteMusicPlayback


class TerminalMusicAdapterTests(unittest.TestCase):
    """对主程序音乐编排和独立终端客户端的接口边界做隔离检查。"""

    def setUp(self):
        """无参数；创建临时状态目录并注入终端API替身。"""
        self.temp = tempfile.TemporaryDirectory()
        self.client = Mock()
        self.player = RemoteMusicPlayback(Path(self.temp.name), Mock(),
            {"target": "testDevice", "volume": 25}, client=self.client)

    def tearDown(self):
        """无参数；清理本测试产生的状态目录。"""
        self.temp.cleanup()

    def test_offline_does_not_fallback_or_retry(self):
        """无参数；终端离线不在服务器播放，也不重新提交。"""
        self.client.execute_command.return_value = {"ok": False, "pending": True, "requestId": "one"}
        with patch("subprocess.Popen") as popen:
            result = self.player.send_request({"action": "status"})
            self.assertTrue(result["pending"])
            self.assertEqual(result["requestId"], "one")
            self.client.execute_command.assert_called_once()
            popen.assert_not_called()

    def test_music_is_routed_as_typed_terminal_command(self):
        """无参数；中文曲名以JSON参数提交，设备ID准确，不再拼接SSH命令。"""
        self.client.execute_command.return_value = {"ok": True, "playing": True, "playbackId": "mine"}
        self.assertTrue(self.player.send_request({"action": "play", "song": {"name": "中文曲名"}})["ok"])
        args = self.client.execute_command.call_args
        self.assertEqual(args.args[0], "testDevice")
        self.assertEqual(args.args[1]["type"], "music")
        self.assertEqual(args.args[1]["params"]["song"]["name"], "中文曲名")
        self.assertTrue(args.args[1]["params"]["requestId"])
        self.assertEqual(args.kwargs["wait_seconds"], 35)

    def test_stop_requires_owned_playback(self):
        """无参数；没有所属播放ID时不停止别人的播放，有ID时必须传递。"""
        self.assertFalse(self.player.stop()["ok"])
        self.client.execute_command.assert_not_called()
        self.player.state["playbackId"] = "mine"
        self.client.execute_command.return_value = {"ok": True}
        self.player.stop()
        self.assertEqual(self.client.execute_command.call_args.args[1]["params"]["expectedPlaybackId"], "mine")

    def test_optional_bridge_missing_does_not_break_music_tools_loading(self):
        """无参数；未安装终端时仍可创建音乐编排，实际播放控制明确失败且不启动本机进程。"""
        player = RemoteMusicPlayback(Path(self.temp.name), Mock(), {})
        with patch("subprocess.Popen") as popen:
            result = player.status()
        self.assertFalse(result["ok"])
        self.assertIn("FileNotFoundError", result["error"])
        popen.assert_not_called()

    def test_default_target_uses_registered_server_device(self):
        """无参数；未单独指定扬声器时，使用桥接登记的服务器终端ID，也必须经过终端API。"""
        root = Path(self.temp.name)
        (root / "config").mkdir()
        (root / "config/terminalConnection.json").write_text(
            json.dumps({"serverDeviceId": "registeredServer"}), encoding="utf-8")
        player = RemoteMusicPlayback(root, Mock(), {}, client=self.client)
        self.client.execute_command.return_value = {"ok": True}
        self.assertTrue(player.status()["ok"])
        self.assertEqual(self.client.execute_command.call_args.args[0], "registeredServer")

    def test_queue_navigation_and_refill_preserve_terminal_only_dispatch(self):
        """无参数；上下首和补页仍可用，队列的实际播放入口始终由终端适配器接管。"""
        with patch.object(self.player, "_play_current", side_effect=lambda: self.player.current()):
            self.assertEqual(self.player.play([{"name": "首曲"}], refill=lambda: [{"name": "次曲"}])["name"], "首曲")
            self.assertEqual(self.player.next()["name"], "次曲")
            self.assertEqual(self.player.prev()["name"], "首曲")
