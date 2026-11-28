"""功能：根据统一位置推理结果选择唯一长期待命采音终端。

注册参数root为主项目目录、route_service为音频路由服务；默认只保存当前目标和证据摘要。
本类不打开麦克风、不绕过终端权限，只有登记了audio.capture的终端才可进入armed状态。
"""
import json
import time
from pathlib import Path
from facts.FactsClient import facts_client
from screenInitiative.PresenceInference import PresenceInference
from voiceRouting.ListeningPolicy import ListeningPolicy


class ListeningRouteService:
    """将位置推理和麦克风长期待命状态解耦，避免所有终端同时监听。"""

    def __init__(self, root, route_service):
        """root为主项目目录；route_service提供终端快照和统一配置。"""
        self.root = Path(root)
        self.route_service = route_service
        self.path = self.root / "runtime/presence/listening.json"
        # agent 决策提供者由网关装配注入；为空时完全走原规则，保证可回滚。
        self.decision_provider = None

    def _read(self):
        """无参数；读取当前待命状态，损坏或不存在时返回关闭状态。"""
        return facts_client().listening()

    def _write(self, value):
        """value为脱敏待命状态；原子写入，禁止保存录音内容。"""
        facts_client().write_listening(value, source="listeningRouter")

    def resolve(self):
        """无参数；用最新终端状态选出唯一目标，决策交给 ListeningPolicy。"""
        cfg, _, devices, states, _ = self.route_service.read_snapshot()
        now = time.time()
        inference = PresenceInference(cfg).infer_presence(devices, states, {}, now)
        policy = ListeningPolicy(cfg, devices, inference)
        route = policy.resolve(agent_route=self._agent_route(
            policy.allowed, cfg, devices, states, inference, now))
        self._write_presence(self._presence(route, inference, devices, states, cfg, now))
        return route

    def _agent_route(self, allowed, cfg, devices, states, inference, now):
        """allowed为可监听设备；返回 agent 给出的路由结论，没有可用决策时返回 None。"""
        provider = getattr(self, "decision_provider", None)
        if not callable(provider):
            return None
        try:
            decision = provider() or {}
        except Exception:
            return None
        if not decision or decision.get("failed"):
            return None
        target = decision.get("target")
        if target and target in allowed:
            return {"state": "resolved", "target": target,
                    "confidence": float(decision.get("confidence") or 0),
                    "reason": str(decision.get("reason") or "agent"),
                    "source": "agent"}
        if decision.get("activity") == "awayFromComputers":
            return {"state": "uncertain", "target": None, "confidence":
                    float(decision.get("confidence") or 0),
                    "reason": "agent:awayFromComputers", "source": "agent"}
        return None

    def _capture_targets(self):
        """无参数；返回当前在线且授权采音的设备，供不确定时清理旧待命状态。"""
        cfg, _, devices, states, _ = self.route_service.read_snapshot()
        return [item["id"] for item in devices
                if item.get("online") is True
                and "audio.capture" in item.get("capabilities", [])
                and item["id"] in cfg.get("devices", [])
                and (states.get(item["id"], {}).get("audio", {}).get("listening") is True)]

    def _stop_targets(self, targets):
        """targets为设备ID序列；逐一发送停止命令，保证旧目标不会继续固定监听。"""
        for target in dict.fromkeys(item for item in targets if item):
            self._stop_target(target)

    def handle_request(self, body):
        """body支持status、start、stop和refresh；start只切换长期待命目标，不创建监听租约。"""
        action = body.get("action", "status")
        if action == "stop":
            current = self._read()
            try:
                if current.get("target"):
                    terminal = self.route_service.get_terminal(
                        self.route_service.load_config())
                    terminal.queue_command(
                        current["target"], {"type": "listening_stop",
                                            "params": {}, "expiresAt": time.time() + 30})
            except (AttributeError, OSError, RuntimeError, ValueError):
                pass
            value = {"state": "stopped", "updatedAt": time.time(), "target": None}
            self._write(value)
            return {"ok": True, **value}
        if action == "start":
            route = self.resolve()
            if route["state"] != "resolved":
                self._stop_targets(self._capture_targets())
                value = {"state": "uncertain", "updatedAt": time.time(), **route}
            else:
                value = {**route, "state": "armed", "updatedAt": time.time(),
                         "expiresAt": None}
                try:
                    terminal = self.route_service.get_terminal(
                        self.route_service.load_config())
                    value["commandId"] = terminal.queue_command(
                        route["target"], {"type": "listening_start",
                                          "params": {}, "expiresAt": time.time() + 240})
                except AttributeError:
                    # 纯推理测试适配器没有命令通道，不影响位置选择测试。
                    value["commandId"] = None
                except (OSError, RuntimeError, ValueError) as exc:
                    value = {"state": "captureUnavailable", "updatedAt": time.time(),
                             "target": None, "confidence": route["confidence"],
                             "reason": "listeningCommandFailed:" + type(exc).__name__}
            self._write(value)
            return {"ok": True, **value}
        if action == "refresh":
            current = self._read()
            route = self.resolve()
            target = current.get("target")
            # 监听目标切换时，同时清理仍处于active的旧终端，避免历史手动启动把手机固定住。
            active_targets = self._capture_targets()
            self._stop_targets(item for item in active_targets if item != route.get("target"))
            if current.get("state") == "armed" and route.get("state") == "resolved":
                if target == route.get("target"):
                    # 目标未变也可能换了结论来源（规则 → agent），刷新记录便于排查。
                    value = {**route, "state": "armed", "updatedAt": time.time(),
                             "expiresAt": None, "commandId": current.get("commandId")}
                    if (current.get("reason") != value.get("reason")
                            or current.get("confidence") != value.get("confidence")):
                        self._write(value)
                    return {"ok": True, "changed": False, "current": value,
                            "latestInference": route}
                self._stop_target(target)
            elif current.get("state") == "armed":
                self._stop_target(target)
            if route.get("state") != "resolved":
                self._stop_targets(self._capture_targets())
                value = {"state": "uncertain", "updatedAt": time.time(),
                         "target": None, "confidence": route.get("confidence", 0),
                         "reason": route.get("reason", "presenceUncertain")}
                self._write(value)
                return {"ok": True, "changed": True, "current": value,
                        "latestInference": route}
            result = self.handle_request({"action": "start"})
            return {"ok": True, "changed": True, "current": result,
                    "latestInference": route}
        if action == "status":
            value = self._read()
            route = self.resolve()
            if value.get("state") == "armed" and (
                    route.get("state") != "resolved" or route.get("target") != value.get("target")):
                try:
                    self._stop_target(value.get("target"))
                except (AttributeError, OSError, RuntimeError, ValueError):
                    pass
                value = {"state": "uncertain", "updatedAt": time.time(),
                         "target": None, "confidence": route.get("confidence", 0),
                         "reason": route.get("reason", "presenceChanged")}
                self._write(value)
            return {"ok": True, "armed": value.get("state") == "armed",
                    "current": value, "latestInference": route}
        raise ValueError("监听操作只支持status、start、stop或refresh")

    def _presence(self, route, inference, devices, states, cfg, now):
        """route/inference/devices/states/cfg/now 为本轮推理；返回统一在场结论。"""
        by_id = {item["id"]: item for item in devices}
        target = route.get("target")
        caps = by_id.get(target, {}).get("capabilities", []) if target else []
        activity = str(inference.get("activity") or "unknown")
        away = (inference.get("state") == "inferred"
                and activity == "awayFromComputers")
        if away:
            return {"updatedAt": now, "state": "away", "activity": activity,
                    "target": None, "confidence": float(inference.get("confidence") or 0),
                    "reason": "awayFromComputers", "listenTarget": None, "ttsTarget": None,
                    "speak": False, "channel": "qq", "shouldPush": True,
                    "expiresAt": now + 180}
        if route.get("state") == "resolved" and target:
            state = states.get(target) or {}
            audio = state.get("audio") or {}
            private = state.get("audioPrivate") is True or (
                audio.get("bluetoothMediaOutput") is True)
            allowed = bool((cfg.get("allowSpeaker") or {}).get(target)) or private
            playable = "audio.playback" in caps
            speak = bool(playable and allowed)
            proactive = bool(speak and float(route.get("confidence") or 0) >= 0.62)
            return {"updatedAt": now, "state": "resolved", "activity": activity,
                    "target": target, "confidence": float(route.get("confidence") or 0),
                    "reason": route.get("reason", ""),
                    "listenTarget": target if "audio.capture" in caps else None,
                    "ttsTarget": target if speak else None,
                    "speak": speak, "proactiveSpeak": proactive,
                    "channel": "tts" if speak else "qq",
                    "shouldPush": True, "expiresAt": now + 180}
        return {"updatedAt": now, "state": "uncertain", "activity": activity,
                "target": None, "confidence": float(route.get("confidence") or 0),
                "reason": route.get("reason", ""), "listenTarget": None, "ttsTarget": None,
                "speak": False, "channel": "qq", "shouldPush": True,
                "expiresAt": now + 180}

    def _write_presence(self, presence):
        """presence 为脱敏在场结论；写入统一事实源（唯一 presence.json）。"""
        facts_client().write_presence(presence, source="listeningRouter")

    def read_presence(self, ttl=180):
        """ttl 为有效秒数；读取最近结论，过期或损坏返回 None。"""
        value = facts_client().presence(ttl=ttl)
        updated = value.get("updatedAt")
        if type(updated) in (int, float) and time.time() - updated <= ttl:
            return value
        return None

    def _stop_target(self, target):
        """target为旧待命设备；发送停止命令，失败时只保留位置状态。"""
        if not target:
            return
        try:
            terminal = self.route_service.get_terminal(self.route_service.load_config())
            terminal.queue_command(target, {"type": "listening_stop",
                                            "params": {}, "expiresAt": time.time() + 30})
        except (AttributeError, OSError, RuntimeError, ValueError):
            return
