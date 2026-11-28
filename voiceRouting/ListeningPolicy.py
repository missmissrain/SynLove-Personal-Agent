"""功能：监听目标的纯决策类，把「选哪台设备待命」从路由服务里独立出来。

注册参数cfg为路由配置、devices为设备清单、inference为在场推理结果；默认只读、无副作用。
本类不写文件、不下发命令、不读终端；调用方拿到 route 后自行落盘与下发。
"""
from screenInitiative.PresenceInference import PresenceInference


class ListeningPolicy:
    """根据在场证据选出唯一监听目标。"""

    def __init__(self, cfg, devices, inference):
        """cfg为配置、devices为设备清单、inference为在场推理结果。"""
        self.cfg = dict(cfg or {})
        self.devices = list(devices or [])
        self.inference = inference or {}
        self.listen_devices = set(self.cfg.get("listenDevices") or self.cfg.get("devices") or [])
        self.allowed = {item.get("id") for item in self.devices
                        if item.get("online") is True
                        and "audio.capture" in (item.get("capabilities") or [])
                        and item.get("id") in self.listen_devices}

    def resolve(self, agent_route=None):
        """agent_route为可选的模型决策；返回 {state, target, confidence, reason}。"""
        if agent_route is not None:
            return dict(agent_route)
        evidence = [item for item in self.inference.get("evidence", [])
                    if item.get("deviceId") in self.allowed]
        evidence.sort(key=lambda item: item.get("score", 0), reverse=True)
        if not evidence:
            online = self._online()
            if len(online) == 1:
                return {"state": "resolved", "target": online[0], "confidence": 0.55,
                        "reason": "singleCaptureDevice"}
            return {"state": "uncertain", "target": None, "confidence": 0,
                    "reason": "noCaptureCapableDevice"}
        if len(evidence) > 1 and evidence[0]["score"] - evidence[1]["score"] < .08:
            ordered = sorted(evidence, key=lambda item: (
                item.get("idleSeconds") if item.get("idleSeconds") is not None else 10 ** 9))
            first = ordered[0]
            second = ordered[1] if len(ordered) > 1 else {}
            idle_first = first.get("idleSeconds")
            idle_second = second.get("idleSeconds")
            if idle_first is not None and (idle_second is None or idle_first + 30 < idle_second):
                return {"state": "resolved", "target": first["deviceId"],
                        "confidence": first["score"], "reason": "mostRecentlyUsed"}
            return {"state": "uncertain", "target": None,
                    "confidence": evidence[0]["score"], "reason": "ambiguousCaptureDevices"}
        best = evidence[0]
        if best["score"] < .62:
            mobile = [item.get("id") for item in self.devices
                      if item.get("online") is True
                      and "audio.capture" in (item.get("capabilities") or [])
                      and item.get("id") in self.listen_devices
                      and "android" in str(item.get("platform") or "").lower()]
            if mobile:
                return {"state": "resolved", "target": mobile[0], "confidence": 0.5,
                        "reason": "mobileWhenNoComputerActivity"}
            if best["score"] >= 0.30:
                return {"state": "resolved", "target": best["deviceId"],
                        "confidence": best["score"], "reason": "recentlyUsedKeepListening"}
            return {"state": "uncertain", "target": None, "confidence": best["score"],
                    "reason": "presenceConfidenceTooLow"}
        return {"state": "resolved", "target": best["deviceId"],
                "confidence": best["score"], "reason": best["reason"]}

    def _online(self):
        """无参数；返回在线且授权采音的设备 ID。"""
        return [item.get("id") for item in self.devices
                if item.get("online") is True
                and "audio.capture" in (item.get("capabilities") or [])
                and item.get("id") in self.listen_devices]
