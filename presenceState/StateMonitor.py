"""功能：常驻第一层循环——每轮只采集快照并计算漂移，漂移够大才让 agent 起临时会话。

注册参数root/routes/config；默认 12 秒一轮、只读状态、不调用模型。
本类不直接发监听命令，只把结论交给 ListeningRouteService；异常不会终止网关。
"""
import json
import threading
import time
from pathlib import Path

from facts.FactsClient import facts_client
from presenceAgent.PresenceReasoner import PresenceReasoner
from presenceState.DriftScorer import DriftScorer
from presenceState.SnapshotStore import SnapshotStore
from presenceState.StateCollector import StateCollector
from screenInitiative.screenTerminal import ScreenTerminal


class StateMonitor:
    """维护「当前快照 + 漂移 + 最近一次 agent 决策」。"""

    def __init__(self, root, routes, config=None):
        """root为主项目Path；routes为AudioRouteService；config为采样、阈值与预算。"""
        self.root = Path(root)
        self.routes = routes
        self.config = dict(config or {})
        self.store = SnapshotStore(self.root)
        self.scorer = DriftScorer(self.config)
        self.collector = StateCollector(self.root, routes, config=self.config)
        self.latest = {}
        self.last_drift = {"score": 0.0, "reasons": []}
        self._stop = threading.Event()
        self._thread = None
        cfg = routes.load_config()
        self.allowed = set(cfg.get("listenDevices") or cfg.get("devices") or [])
        self.reasoner = PresenceReasoner(self.root, self.store, config=self.config,
                                         allowed=self.allowed)

    def start(self):
        """无参数；启动常驻线程，重复调用不会重复起线程。"""
        if self._thread and self._thread.is_alive():
            return self
        terminal = ScreenTerminal(self.root, self.routes.load_config())
        self.collector.attach(terminal)
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="SynLovePresenceState")
        self._thread.start()
        return self

    def stop(self):
        """无参数；通知线程退出，用于测试或重启。"""
        self._stop.set()

    def decision(self):
        """无参数；返回当前可用的 agent 决策，过期返回 None。"""
        return self.reasoner.current(time.time())

    def snapshot(self):
        """无参数；返回最近一轮状态快照。"""
        return self.latest

    def _loop(self):
        """无参数；常驻循环，任何异常只记录不退出。"""
        interval = float(self.config.get("intervalSeconds", 12))
        while not self._stop.is_set():
            started = time.time()
            try:
                self._tick(time.time())
            except Exception as error:  # 常驻线程不能因单轮失败退出
                try:
                    self.store.write_reasoning({"at": time.time(), "failed": True,
                                                "errorType": type(error).__name__,
                                                "stage": "tick", "decision": None})
                except Exception:
                    pass
            elapsed = time.time() - started
            self._stop.wait(max(1.0, interval - elapsed))

    def _tick(self, now):
        """now为当前秒；采集、算漂移、覆写快照，必要时触发一次推理。"""
        target = self._listen_target()
        snapshot = self.collector.collect(now, target)
        self.latest = snapshot
        previous = self.store.read_last_reasoned()
        drift = self.scorer.score(snapshot, previous)
        # 快照里只保留本轮相对基线的事实变化，供排查，不做历史累积。
        snapshot["changes"] = drift.get("reasons") or []
        threshold = float(self.config.get("driftThreshold", 0.45))
        # 决策过期后即使状态没变化也要重新判定，避免一直沿用旧结论。
        if not self.reasoner.fresh(now) and previous:
            drift = {"score": 1.0, "reasons": list(drift.get("reasons") or []) + [
                {"code": "decisionExpired", "weight": 1.0,
                 "detail": "上一份 agent 决策已过期或不存在"}]}
            snapshot["changes"] = drift["reasons"]
        self.last_drift = drift
        self.store.write_current(snapshot)
        if drift.get("score", 0) >= threshold:
            self.reasoner.maybe_reason(snapshot, drift, now)

    def _listen_target(self):
        """无参数；读取当前待命设备，供镜头采样与上下文参考。"""
        return facts_client().listening().get("target")
