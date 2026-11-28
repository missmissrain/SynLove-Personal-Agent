"""功能：统一提供音频路由查询、主人设置、摄像头证据接入和QQ澄清。

注册参数root为生产根，terminal为可注入终端适配器；默认不访问摄像头、不调用模型。
配置在config/audioRouting.json，状态在runtime/voiceRouting，低层播放另由终端负责。
"""
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from facts.FactsClient import facts_client
from voiceRouting.AudioRouteStore import AudioRouteStore
from voiceRouting.AudioRoutePolicy import AudioRoutePolicy


class AudioRouteService:
    """供主动观察、语音信箱和主人格工具共用同一份设置与策略。"""

    def __init__(self, root, terminal=None):
        """root为主项目路径；terminal注入隔离测试或复用既有终端管理适配器。"""
        self.root, self.terminal = Path(root), terminal
        self.store = AudioRouteStore(root)

    def load_config(self):
        """无参数；兼容既有观察白名单、扬声器授权，再合并独立路由配置。"""
        path = self.root / "config/screenInitiative.json"
        base = json.loads(path.read_text("utf-8-sig")) if path.exists() else {}
        cfg = {k: base[k] for k in ("devices", "allowSpeaker", "terminalRoot", "terminalConfig")
               if k in base}
        cfg["outputs"] = base.get("voiceOutputs", {})
        path = self.root / "config/audioRouting.json"
        if path.exists():
            cfg.update(json.loads(path.read_text("utf-8-sig")))
        return cfg

    def get_terminal(self, cfg):
        """cfg为独立配置；延迟创建终端客户端，不在构造或模块导入时联网。"""
        if self.terminal is None:
            from screenInitiative.screenTerminal import ScreenTerminal
            return ScreenTerminal(self.root, cfg)
        return self.terminal

    def read_snapshot(self):
        """无参数；并行只读查询授权终端，不截图；每个失败终端视为证据未知。"""
        cfg = self.load_config()
        terminal = self.get_terminal(cfg)
        devices = terminal.list_devices()
        targets = [d["id"] for d in devices if d.get("online") is True
                   and d["id"] in cfg.get("devices", [])
                   and ({"screen.observe", "audio.capture"} &
                        set(d.get("capabilities", [])))]
        by_id = {item["id"]: item for item in devices}
        def read_device(key):
            """key为白名单设备ID；失败按未知处理，不将异常转成离开设备的证据。"""
            try:
                device = by_id.get(key, {})
                value = {}
                if "screen.observe" in device.get("capabilities", []):
                    value.update(terminal.observe_device(key, {"action": "status"}))
                # 安卓终端没有屏幕观察能力，但可以提供采音服务状态。
                # 该状态只作为链路健康信息，不伪造用户正在手机前的证据。
                if "audio.capture" in device.get("capabilities", []):
                    try:
                        audio = terminal.observe_audio(key)
                        value["audio"] = {
                            "available": True,
                            "listening": audio.get("state") == "armed",
                            "sampledAt": time.time(),
                        }
                    except (AttributeError, OSError, RuntimeError, ValueError):
                        pass
                # 仅能采音的设备也要提供顶层采样时间，供在场推理判断新鲜度。
                value.setdefault("sampledAt", time.time())
                return key, value
            except (OSError, RuntimeError, ValueError):
                return key, {}
        with ThreadPoolExecutor(max_workers=max(1, min(len(targets), 8))) as pool:
            states = dict(pool.map(read_device, targets))
        preference = self.store.read_state()
        for key, camera in preference.get("cameras", {}).items():
            if key in cfg.get("devices", []):
                states.setdefault(key, {})["camera"] = camera
        return cfg, terminal, devices, states, preference

    def read_presence(self, ttl=180):
        """ttl为有效秒数；读取统一在场结论，过期或缺失返回None。"""
        value = facts_client().presence(ttl=ttl)
        updated = value.get("updatedAt")
        if type(updated) in (int, float) and time.time() - updated <= ttl:
            return value
        return None

    def resolve_route(self, source="", purpose="reply", snapshot=None):
        """source/purpose为来源和用途；snapshot可复用本轮证据，默认重新只读取证。"""
        if purpose not in ("reply", "initiative"):
            raise ValueError("音频路由用途无效")
        cfg, _, devices, states, preference = snapshot or self.read_snapshot()
        return AudioRoutePolicy(cfg).choose_route(
            source, purpose, preference, devices, states, time.time(),
            presence=self.read_presence())

    def resolve_for_states(self, source, purpose, devices, states, now):
        """传入本轮devices/states/now复用刚采样状态；只补入可信摄像头结果与明确设置。"""
        cfg, preference = self.load_config(), self.store.read_state(now)
        states = {k: dict(v) for k, v in states.items()}
        for key, camera in preference.get("cameras", {}).items():
            if key in cfg.get("devices", []):
                states.setdefault(key, {})["camera"] = camera
        return AudioRoutePolicy(cfg).choose_route(source, purpose, preference, devices, states,
                                                  now, presence=self.read_presence())

    def handle_request(self, body):
        """body为受鉴权的结构化操作；只接收状态、设置、解析和摄像头证据，不接受播放URL。"""
        action = body.get("action", "status")
        cfg = self.load_config()
        terminal = self.get_terminal(cfg)
        if action in ("set", "clear"):
            state = self.store.set_preference(body, terminal.list_devices(), time.time())
            result = {"ok": True, "preference": {k: state.get(k) for k in (
                "mode", "target", "expiresAt", "revision", "origin")}}
            if state.get("mode") == "tts":
                result["route"] = self.resolve_route()
                result["clarification"] = self.ask_target(result["route"], terminal)
            return result
        if action == "camera":
            self.store.record_camera({k: v for k, v in body.items() if k != "action"},
                                     terminal.list_devices(), time.time())
            return {"ok": True}
        if action not in ("status", "resolve"):
            raise ValueError("未知音频路由操作")
        snapshot = self.read_snapshot()
        route = self.resolve_route(body.get("source", ""), body.get("purpose", "reply"), snapshot)
        preference = snapshot[-1]
        return {"ok": True, "route": route, "preference": {k: preference.get(k) for k in (
            "mode", "target", "expiresAt", "revision", "expired")}}

    def ask_target(self, route, terminal=None):
        """route为缺少目标的真实路由结果；通过既有主人QQ询问，30分钟最多一次。"""
        if not route.get("needsTarget") or not self.store.reserve_question(
                route["reason"], time.time()):
            return {"asked": False}
        terminal = terminal or self.get_terminal(self.load_config())
        try:
            terminal.queue_text(uuid.uuid4().hex,
                "这次语音发到哪台设备？你可以告诉我“把语音发到天选”或“发到大黄蜂”，"
                "我会记住；也可以说“先用文字”。", time.time() + 120)
            self.store.mark_question_queued(route["reason"], time.time())
            return {"asked": True, "channel": "qq", "state": "queued"}
        except (OSError, RuntimeError, ValueError) as error:
            return {"asked": False, "channel": "qq", "state": "failed",
                    "errorType": type(error).__name__}
