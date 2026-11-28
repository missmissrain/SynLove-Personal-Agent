"""功能：事实层的主动激活运行时。90 秒一轮判断是否该主动开口，结论与预算留在事实层。

注册参数 root 为主项目 Path、config 为可选配置；默认读 config/screenInitiative.json。
本类不合成语音、不播放：判断完成后把投递请求交给消息层 /v1/initiative。
消息层不可用时按「忙」处理（不打扰），并把失败写进状态，不静默当作成功。
"""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from screenInitiative.screenInitiative import ScreenInitiative
from voiceRouting.AudioRouteService import AudioRouteService


class ActivationRuntime:
    """主动激活的判断者，唯一持有开口预算与最近判断。"""

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 为可选配置（保留扩展位）。"""
        self.root = Path(root)
        self.config = dict(config or {})
        self.message = os.environ.get("SYNLOVE_MESSAGE_URL", "http://127.0.0.1:8805").rstrip("/")
        self.routes = AudioRouteService(self.root)
        self.initiative = ScreenInitiative(self.root, deliver=self._deliver,
                                           busy=self._busy, audio_router=self.routes)

    def start(self):
        """无参数；启动 90 秒判断线程，返回自身。"""
        self.initiative.start_worker()
        return self

    def stop(self):
        """无参数；停止判断线程。"""
        self.initiative.stop.set()

    def snapshot(self):
        """无参数；返回当前判断状态、预算与最近一次结果。"""
        status = dict(getattr(self.initiative, "status", {}) or {})
        state = getattr(self.initiative, "state", {}) or {}
        return {"updatedAt": time.time(), "status": status,
                "chatsToday": state.get("chats", 0),
                "lastChat": state.get("lastChat", 0),
                "modelCallsThisHour": len(state.get("calls") or []),
                "lastDecision": getattr(self.initiative, "last_decision", None)}

    def fresh_route(self, device_id):
        """device_id 为观察设备；返回按当前状态重算的路由，供消息层播放前复核。"""
        return self.initiative.fresh_route(str(device_id or ""))

    def _busy(self):
        """无参数；查消息层是否有语音回合在跑。查询失败按忙处理，避免打断。"""
        try:
            with _opener().open(self.message + "/v1/activity", timeout=2) as response:
                value = json.loads(response.read().decode("utf-8"))
            return bool(value.get("busy"))
        except Exception:  # noqa: BLE001 —— 查不到就当忙，宁可少说一句
            return True

    def _deliver(self, request):
        """request 为投递请求；提交给消息层并把最终状态原样返回，失败抛 RuntimeError。"""
        body = json.dumps(request, ensure_ascii=False).encode("utf-8")
        try:
            with _opener().open(self.message + "/v1/initiative", data=body, timeout=300) as response:
                value = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError("消息层拒绝投递：HTTP %d" % error.code)
        except Exception as error:  # noqa: BLE001
            raise RuntimeError("消息层投递失败：%s" % type(error).__name__)
        if not value.get("ok"):
            raise RuntimeError("消息层返回失败：" + str(value.get("error") or "")[:120])
        return value.get("value") or {}


def _opener():
    """无参数；返回绕过系统代理的本机请求器。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))
