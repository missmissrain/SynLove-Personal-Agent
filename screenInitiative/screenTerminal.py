"""功能：适配已登记终端的状态、内存截图及既有QQ和音频通道，不增加公网端口。

注册参数config含terminalRoot及terminalConfig，root为生产根，client可注入测试。
默认只操作明确白名单设备，图像最多2MiB；下载完成后释放终端帧，不保存截图。
"""
import base64
import hashlib
import sys
import time
from pathlib import Path


class ScreenTerminal:
    """把屏幕观察与终端中继协议隔离，未来可替换安卓适配器。"""

    def __init__(self, root, config, client=None):
        """root/config定位私有管理配置，client为测试传输；不把鉴权配置交给模型。"""
        self.config = config
        terminal = (root / config["terminalRoot"]).resolve()
        sys.path.insert(0, str(terminal))
        from terminalConnection.client.TerminalApiClient import TerminalApiClient
        self.client = client or TerminalApiClient(terminal / config["terminalConfig"])

    def list_devices(self):
        """无参数；返回已登记在线设备，由上层白名单和能力二次筛选。"""
        return self.client.request_json("GET", "/v1/devices")["devices"]

    def observe_device(self, device, args):
        """device为白名单终端，args为status/capture/read/release；不执行任意shell。"""
        if device not in self.config["devices"]:
            raise ValueError("设备没有观察授权")
        reply = self.client.execute_command(device, {"type": "screen_observe", "params": args},
                                            wait_seconds=25)
        if not reply.get("ok"):
            raise RuntimeError("终端当前无法提供观察")
        return reply

    def observe_audio(self, device):
        """device为已登记采音终端；读取脱敏监听状态，供位置推理判断证据新鲜度。"""
        if device not in self.config["devices"]:
            raise ValueError("设备没有观察授权")
        reply = self.client.execute_command(
            device, {"type": "listening_status", "params": {}}, wait_seconds=10)
        if not reply.get("ok"):
            raise RuntimeError("终端当前无法提供采音状态")
        return reply

    def read_frame(self, device):
        """device为白名单设备；分块校验内存图像并释放，失败不返回残缺帧。"""
        meta = self.observe_device(device, {"action": "capture"})
        try:
            size = meta["bytes"]
            if type(size) is not int or not 100 < size <= 2 * 1024 * 1024:
                raise ValueError("截图超出限制")
            raw = bytearray()
            for offset in range(0, size, 16384):
                part = self.observe_device(device, {"action": "read", "frameId": meta["frameId"],
                                                   "offset": offset})
                data = base64.b64decode(part["data"], validate=True)
                if len(data) != min(16384, size - offset):
                    raise ValueError("截图分块不完整")
                raw.extend(data)
            if hashlib.sha256(raw).hexdigest() != meta["sha256"]:
                raise ValueError("截图摘要不匹配")
            return bytes(raw), meta["state"]
        finally:
            try:
                self.observe_device(device, {"action": "release", "frameId": meta["frameId"]})
            except (OSError, RuntimeError, ValueError):
                pass

    def queue_text(self, ident, text, expires):
        """ident/text/expires为受限主动消息；只进入服务器已有主人QQ收件箱。"""
        return self.client.request_json("POST", "/v1/initiative/text",
            {"id": ident, "text": text, "expiresAt": expires})

    def play_audio(self, target, ident, raw, expires, guard, require_active=True):
        """target为策略选定设备，guard在真正播放前复核状态；失败或过期不补播。"""
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend-service"))
        from fleetService.VoicePlaybackRouter import VoicePlaybackRouter
        return VoicePlaybackRouter(self, Path("unused")).route_to(
            target, ident, raw, not_after=expires, guard=guard, require_active=require_active)

    def queue_command(self, target, body):
        """target/body为音频路由器生成的有界命令；返回原命令ID，不自动重试写入。"""
        return self.client.request_json("POST", "/v1/commands",
            {"deviceId": target, "command": body})["id"]

    def command_result(self, key):
        """key为已有命令ID；仅查询结果，不重新执行播放。"""
        return self.client.request_json("GET", "/v1/commands/" + key)
