"""功能：事实层的在场运行时，常驻采集设备状态、推断位置、计算漂移并刷新监听目标。

注册参数 root 为主项目 Path、config 为在场推理配置；默认 12 秒采集一轮、30 秒刷新一次监听。
本类只写事实（在场/监听），不发送消息、不合成语音；异常写盘但不退出服务。
"""
import json
import threading
import time
from pathlib import Path

from presenceState.StateMonitor import StateMonitor
from voiceRouting.AudioRouteService import AudioRouteService
from voiceRouting.ListeningRouteService import ListeningRouteService


class PresenceRuntime:
    """事实层唯一的在场采集与监听决策循环。"""

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 为在场推理配置。"""
        self.root = Path(root)
        self.config = dict(config or {})
        self.routes = AudioRouteService(self.root)
        self.presence = StateMonitor(self.root, self.routes, config=self.config)
        self.listening = ListeningRouteService(self.root, self.routes)
        self.listening.decision_provider = self.presence.decision
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        """无参数；启动采集与监听刷新，重复调用不会重复起线程。"""
        self.presence.start()
        if self._thread and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name="SynLoveListeningRefresh")
        self._thread.start()
        return self

    def stop(self):
        """无参数；停止刷新与采集线程。"""
        self._stop.set()
        self.presence.stop()

    def _loop(self):
        """无参数；按配置刷新监听目标，失败只记录不退出。"""
        while not self._stop.is_set():
            try:
                if self.routes.load_config().get("autoListeningMonitor", True):
                    self.listening.handle_request({"action": "refresh"})
            except Exception as error:
                path = self.root / "runtime/logs/factsLastError.json"
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({"at": time.time(), "stage": "refreshListening",
                                                "errorType": type(error).__name__,
                                                "message": str(error)[:200]},
                                               ensure_ascii=False), "utf-8")
                except OSError:
                    pass
            self._stop.wait(30)
