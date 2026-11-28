"""功能：比较「当前状态快照」与「上次推理时的快照」，给出漂移分与可读原因。

注册参数config为阈值配置，默认阈值与权重在本文件内；本类只做差异计算，不调用模型、不发送命令。
漂移分 0~1，越大表示越值得让 agent 重新推理一次。
"""
import math


class DriftScorer:
    """把设备状态差异折算成 0~1 分数，并保留每条差异的原因码。"""

    def __init__(self, config=None):
        """config为可选覆盖项，默认权重见 _weights；未给出的项走默认值。"""
        self.config = dict(config or {})
        self.weights = {
            "noBaseline": 1.0,
            "staleBaseline": 0.30,
            "onlineChanged": 0.50,
            "capabilityChanged": 0.25,
            "lockedChanged": 0.35,
            "interactiveChanged": 0.30,
            "idleBandChanged": 0.20,
            "foregroundChanged": 0.15,
            "bluetoothChanged": 0.25,
            "audioPrivateChanged": 0.20,
            "audioRouteChanged": 0.30,
            "musicActiveChanged": 0.15,
            "cameraChanged": 0.50,
            "locationMoved": 0.60,
            "locationMovedFar": 0.90,
            "scheduleBandChanged": 0.25,
            "personPlaceChanged": 0.70,
            "listeningChanged": 0.20,
            "sampleGapLarge": 0.35,
        }
        self.weights.update(self.config.get("weights") or {})
        self.idle_bands = [30, 120, 300, 900, 1800]

    def score(self, current, previous):
        """current/previous为两份快照；返回 {score, reasons[]}，reasons 每项含 code/weight/detail。"""
        if not isinstance(previous, dict) or not previous.get("devices"):
            return {"score": 1.0, "reasons": [{"code": "noBaseline", "weight": 1.0,
                                               "detail": "首次推理，无历史基线"}]}
        reasons = []
        total = 0.0

        def add(code, detail):
            """code为原因码、detail为说明；按权重累加并记录。"""
            nonlocal total
            weight = float(self.weights.get(code, 0.1))
            total += weight
            reasons.append({"code": code, "weight": weight, "detail": detail})

        now_at = float(current.get("at") or 0)
        old_at = float(previous.get("at") or 0)
        if now_at - old_at >= float(self.config.get("staleBaselineSeconds", 1800)):
            add("staleBaseline", "距上次推理 %d 秒" % int(now_at - old_at))
        if current.get("scheduleBand") != previous.get("scheduleBand"):
            add("scheduleBandChanged", "作息段 %s → %s" % (
                previous.get("scheduleBand"), current.get("scheduleBand")))
        old_person = (previous.get("personPlace") or {}).get("place")
        new_person = (current.get("personPlace") or {}).get("place")
        if old_person != new_person:
            add("personPlaceChanged", "人在 %s → %s" % (old_person or "未知", new_person or "未知"))

        old_devices = {item.get("id"): item for item in previous.get("devices", [])}
        for device in current.get("devices", []):
            ident = device.get("id")
            old = old_devices.get(ident) or {}
            if not old:
                if device.get("online"):
                    add("onlineChanged", "%s 首次出现在快照中" % ident)
                continue
            if bool(device.get("online")) != bool(old.get("online")):
                add("onlineChanged", "%s 在线 %s → %s" % (
                    ident, old.get("online"), device.get("online")))
            if self._caps(device) != self._caps(old):
                add("capabilityChanged", "%s 能力集变化" % ident)
            if bool(device.get("locked")) != bool(old.get("locked")):
                add("lockedChanged", "%s 锁屏 %s → %s" % (
                    ident, old.get("locked"), device.get("locked")))
            if bool(device.get("interactive")) != bool(old.get("interactive")):
                add("interactiveChanged", "%s 亮屏 %s → %s" % (
                    ident, old.get("interactive"), device.get("interactive")))
            if self._band(device.get("idleSeconds")) != self._band(old.get("idleSeconds")):
                add("idleBandChanged", "%s 空闲 %s → %s 秒" % (
                    ident, old.get("idleSeconds"), device.get("idleSeconds")))
            if (device.get("foregroundApp") or "") != (old.get("foregroundApp") or ""):
                add("foregroundChanged", "%s 前台 %s → %s" % (
                    ident, old.get("foregroundApp"), device.get("foregroundApp")))
            if self._bluetooth(device) != self._bluetooth(old):
                add("bluetoothChanged", "%s 蓝牙媒体输出变化" % ident)
            if bool(device.get("audioPrivate")) != bool(old.get("audioPrivate")):
                add("audioPrivateChanged", "%s 私密输出变化" % ident)
            if (device.get("audioRoute") or "") != (old.get("audioRoute") or ""):
                add("audioRouteChanged", "%s 音频路由 %s → %s" % (
                    ident, old.get("audioRoute"), device.get("audioRoute")))
            if bool(device.get("musicActive")) != bool(old.get("musicActive")):
                add("musicActiveChanged", "%s 媒体播放 %s → %s" % (
                    ident, old.get("musicActive"), device.get("musicActive")))
            if device.get("cameraPresent") is not None and old.get("cameraPresent") is not None \
                    and bool(device.get("cameraPresent")) != bool(old.get("cameraPresent")):
                add("cameraChanged", "%s 摄像头前有人 %s → %s" % (
                    ident, old.get("cameraPresent"), device.get("cameraPresent")))
            moved = self._distance(device.get("location"), old.get("location"))
            if moved is not None and moved >= 200:
                add("locationMovedFar" if moved >= 1000 else "locationMoved",
                    "%s 位置移动约 %d 米" % (ident, moved))
            if bool(device.get("listening")) != bool(old.get("listening")):
                add("listeningChanged", "%s 监听 %s → %s" % (
                    ident, old.get("listening"), device.get("listening")))
        return {"score": round(min(1.0, total), 3), "reasons": reasons}

    def _caps(self, device):
        """device为设备快照；返回排序后的能力元组，便于直接比较。"""
        return tuple(sorted(device.get("capabilities") or []))

    def _band(self, idle):
        """idle为空闲秒数；返回所属区间序号，未知返回 None。"""
        if not isinstance(idle, (int, float)):
            return None
        for index, edge in enumerate(self.idle_bands):
            if idle < edge:
                return index
        return len(self.idle_bands)

    def _bluetooth(self, device):
        """device为设备快照；返回蓝牙媒体输出标记，未知为 None。"""
        return device.get("bluetoothMediaOutput")

    def _distance(self, left, right):
        """left/right为 {lat, lon}；返回粗略米数，缺失返回 None。"""
        if not isinstance(left, dict) or not isinstance(right, dict):
            return None
        try:
            lat1, lon1 = float(left["lat"]), float(left["lon"])
            lat2, lon2 = float(right["lat"]), float(right["lon"])
        except (KeyError, TypeError, ValueError):
            return None
        dy = (lat1 - lat2) * 111320.0
        dx = (lon1 - lon2) * 111320.0 * math.cos(math.radians((lat1 + lat2) / 2))
        return int((dx * dx + dy * dy) ** 0.5)
