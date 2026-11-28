"""功能：向终端采集在场推理所需的低频模态（相机在/不在、粗定位、电量），并做频率与结果缓存。

注册参数terminal为终端适配器、config为采样配置；默认 90 秒最多一次相机、600 秒一次定位、300 秒一次电量。
本类只读取状态，不保存图像、不保存精确坐标，不调用模型。
"""
import time


class DeviceStateProbe:
    """按能力与频率向单台终端要一次状态，失败返回空字典且不重试。"""

    def __init__(self, terminal, config=None):
        """terminal为ScreenTerminal或等价适配器；config为间隔配置。"""
        self.terminal = terminal
        self.config = dict(config or {})
        self.cache = {}
        self.errors = {}
        self.camera_interval = float(self.config.get("cameraIntervalSeconds", 90))
        self.location_interval = float(self.config.get("locationIntervalSeconds", 600))
        self.battery_interval = float(self.config.get("batteryIntervalSeconds", 300))
        self.route_interval = float(self.config.get("audioRouteIntervalSeconds", 30))

    def cached(self, device, kind, now, max_age):
        """device/kind为缓存键，now为当前秒，max_age为可接受的最大年龄；过期返回 None。"""
        item = self.cache.get((device, kind))
        if isinstance(item, dict) and now - float(item.get("at", 0)) <= max_age:
            return item.get("value")
        return None

    def sample(self, device, kind, now, params=None, timeout=5.0):
        """device为设备ID、kind为命令类型；发送一次命令并等待结果，返回结果字典或空字典。"""
        try:
            key = self.terminal.queue_command(device, {
                "type": kind, "params": dict(params or {}), "expiresAt": now + 30})
        except (AttributeError, OSError, RuntimeError, ValueError) as error:
            self.errors[(device, kind)] = {"at": now, "error": type(error).__name__}
            return {}
        deadline = now + timeout
        while time.time() < deadline:
            try:
                item = self.terminal.command_result(key) or {}
            except (AttributeError, OSError, RuntimeError, ValueError) as error:
                self.errors[(device, kind)] = {"at": now, "error": type(error).__name__}
                return {}
            if item.get("state") in ("done", "failed", "expired"):
                value = item.get("result") or {}
                self.cache[(device, kind)] = {"at": now, "value": value}
                return value
            time.sleep(0.35)
        self.errors[(device, kind)] = {"at": now, "error": "Timeout"}
        return {}

    def camera(self, device, caps, now, active_hint):
        """device/caps为该设备登记项与能力，active_hint表示当前是否值得看镜头；返回在/不在。"""
        if "camera.presence" not in caps:
            return None
        cached = self.cached(device, "camera.presence", now, self.camera_interval)
        if isinstance(cached, dict):
            return cached
        if not active_hint:
            return None
        value = self.sample(device, "camera.presence", now, {"timeoutMs": 2000}, timeout=5.5)
        if not value.get("ok"):
            return None
        return {"present": bool(value.get("present")), "faces": value.get("faces"),
                "at": now}

    def location(self, device, caps, now):
        """device/caps为该设备；返回最近一次粗定位，超出间隔才重新询问。"""
        if "location.coarse" not in caps:
            return None
        cached = self.cached(device, "location.coarse", now, self.location_interval)
        if isinstance(cached, dict):
            return cached if cached.get("ok") else None
        value = self.sample(device, "location.coarse", now, {}, timeout=10.0)
        return value if value.get("ok") else None

    def battery(self, device, caps, now):
        """device/caps为该设备；返回电量与充电状态，供推理判断是否被带出门。"""
        if "device.probe" not in caps:
            return None
        cached = self.cached(device, "device.probe", now, self.battery_interval)
        if isinstance(cached, dict) and cached.get("ok"):
            return cached
        value = self.sample(device, "device.probe", now, {}, timeout=4.0)
        return value if value.get("ok") else None

    def route(self, device, caps, now):
        """device/caps为该设备；返回当前音频输出路由与媒体播放状态（30 秒一次）。"""
        if "audio.route" not in caps:
            return None
        cached = self.cached(device, "audio.route", now, self.route_interval)
        if isinstance(cached, dict):
            return cached if cached.get("ok") else None
        value = self.sample(device, "audio.route", now, {}, timeout=4.0)
        return value if value.get("ok") else None
