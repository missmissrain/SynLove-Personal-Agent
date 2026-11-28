"""功能：在状态漂移足够大时，起一次临时会话让模型判定「人现在在哪台设备旁」。

注册参数root/store/client/config；默认最小间隔 60 秒、每小时最多 20 次、单次上下文裁剪到 6000 字符。
本类失败不重试、不缓存失败结论；失败后立刻让规则兜底，并把失败原因写入 reasoning.json。
"""
import json
import time
from pathlib import Path

from presenceAgent.PresenceDecision import PresenceDecision
from presenceAgent.PresenceModelClient import PresenceModelClient


class PresenceReasoner:
    """漂移触发的临时会话推理，带预算、冷却与结果有效期。"""

    def __init__(self, root, store, client=None, config=None, allowed=None):
        """root为主项目Path；store为快照存储；client可注入；config为预算与有效期；allowed为白名单。"""
        self.root = Path(root)
        self.store = store
        self.client = client or PresenceModelClient(root)
        self.config = dict(config or {})
        self.allowed = set(allowed or [])
        self.min_interval = float(self.config.get("minReasonSeconds", 60))
        self.max_per_hour = int(self.config.get("maxReasonPerHour", 20))
        self.ttl = float(self.config.get("decisionTtlSeconds", 600))
        self.max_context = int(self.config.get("maxContextChars", 6000))
        self.last_attempt = 0.0
        self.calls = []
        self.decision = {}

    def may_attempt(self, now):
        """now为当前秒；预算允许且冷却结束返回 True。"""
        self.calls = [stamp for stamp in self.calls if now - stamp < 3600]
        if self.decision.get("nullDecision") and now < float(self.decision.get("expiresAt") or 0):
            return False
        return (now - self.last_attempt >= self.min_interval
                and len(self.calls) < self.max_per_hour)

    def current(self, now=None):
        """now为当前秒；返回未过期的决策，过期或失败返回 None。"""
        now = time.time() if now is None else now
        value = self.decision or {}
        if value.get("target") and float(value.get("expiresAt") or 0) > now:
            return value
        return None

    def fresh(self, now=None):
        """now为当前秒；只要最近一次判定还没过期就返回 True（含 target 为空的结论）。"""
        now = time.time() if now is None else now
        value = self.decision or {}
        return bool(value) and float(value.get("expiresAt") or 0) > now

    def maybe_reason(self, snapshot, drift, now=None):
        """snapshot为状态快照、drift为漂移结果；满足触发条件时做一次判定，返回决策或 None。"""
        now = time.time() if now is None else now
        if not self.allowed or not self.may_attempt(now):
            return None
        self.last_attempt = now
        self.calls.append(now)
        started = time.time()
        context = self._context(snapshot, drift, now)
        online = {item.get("id") for item in snapshot.get("devices", [])
                  if item.get("online") and item.get("id") in self.allowed}
        try:
            raw = self.client.ask(context)
            decision = PresenceDecision(self.allowed, online=online).validate(raw)
        except Exception as error:
            self.store.write_reasoning({
                "at": now, "failed": True, "errorType": type(error).__name__,
                "error": str(error)[:200],
                "drift": drift, "reasoning": "", "decision": None,
                "elapsedSeconds": round(time.time() - started, 2)})
            self.decision = {"failed": True, "at": now, "expiresAt": 0}
            return None
        self.decision = {
            "target": decision["target"], "confidence": decision["confidence"],
            "activity": decision["activity"], "reason": "agent:" + decision["reason"],
            "reasoning": decision["reasoning"], "at": now,
            "expiresAt": now + (self.ttl if decision["target"] else 120),
            "drift": drift.get("score"),
            "nullDecision": decision["target"] is None,
        }
        self.store.write_reasoning({
            "at": now, "failed": False, "decision": decision, "reasoning": decision["reasoning"],
            "drift": drift, "elapsedSeconds": round(time.time() - started, 2),
            "snapshotAt": snapshot.get("at")})
        self.store.write_last_reasoned(snapshot)
        return self.decision

    def _context(self, snapshot, drift, now):
        """snapshot/drift为输入；裁剪成低 token 的判定上下文。"""
        devices, others = [], []
        for item in snapshot.get("devices", []):
            row = {key: item.get(key) for key in (
                "id", "online", "platform", "idleSeconds", "locked", "interactive",
                "foregroundApp", "audioPrivate", "bluetoothMediaOutput",
                "bluetoothHeadphonesConnected", "batteryLevel", "charging",
                "cameraPresent", "cameraFaces", "location", "listening", "place",
                "audioRoute", "bluetoothAudio", "musicActive") if key in item}
            if item.get("listen") and item.get("id") in self.allowed:
                devices.append(row)
            else:
                # 不可监听的设备只作为旁证，不允许选它。
                others.append({key: row.get(key) for key in
                               ("id", "online", "idleSeconds", "locked", "foregroundApp",
                                "bluetoothMediaOutput", "place") if key in row})
        context = {
            "now": {"localTime": snapshot.get("localTime"), "weekday": snapshot.get("weekday"),
                    "scheduleBand": snapshot.get("scheduleBand")},
            "profileSchedule": snapshot.get("profileSchedule") or [],
            "places": snapshot.get("places") or [],
            "personPlace": snapshot.get("personPlace") or {},
            "listenDevices": sorted(self.allowed),
            "currentListenTarget": snapshot.get("listenTarget"),
            "devices": devices,
            "otherDevices": others,
            "drift": drift,
            "lastDecision": {key: (self.decision or {}).get(key)
                             for key in ("target", "confidence", "reason", "activity")},
        }
        text = json.dumps(context, ensure_ascii=False)
        if len(text) <= self.max_context:
            return context
        for item in devices:
            item.pop("capabilities", None)
            item.pop("location", None)
        return context
