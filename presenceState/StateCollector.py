"""功能：把三台终端的在线、输入、屏幕、音频、蓝牙、电量、镜头与定位汇总成一份状态快照。

注册参数root为主项目Path、routes为音频路由服务、probe为低频模态探针；默认每轮只读、不推理、不调用模型。
本类不保存图像与精确坐标，坐标只透传四位小数；画像作息只读，不回写。
"""
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from presenceState.DeviceStateProbe import DeviceStateProbe
from presenceState.PlaceResolver import PlaceResolver
from profilePresence.GraphProfileAdapter import GraphProfileAdapter


class StateCollector:
    """常驻第一层：只刻画状态，判断交给上层。"""

    def __init__(self, root, routes, probe=None, config=None):
        """root为主项目Path；routes提供设备与屏幕/音频快照；probe可注入；config为采样与作息配置。"""
        self.root = Path(root)
        self.routes = routes
        self.config = dict(config or {})
        self.probe = probe or DeviceStateProbe(None, self.config)
        self.offset = int(self.config.get("utcOffsetMinutes", 480))
        self.routine = self.config.get("routine") or []
        self.places = PlaceResolver(self.config)
        self.location_fresh = float(self.config.get("locationFreshSeconds", 900))
        self.profile_cache = {"at": 0, "value": {}}

    def attach(self, terminal):
        """terminal为终端适配器；由网关装配后注入，避免构造时就联网。"""
        self.probe.terminal = terminal
        return self

    def collect(self, now=None, listen_target=None):
        """now为可注入时间戳，listen_target为当前待命设备；返回一份脱敏状态快照。"""
        now = time.time() if now is None else float(now)
        cfg, _, devices, states, _ = self.routes.read_snapshot()
        listen_devices = set(cfg.get("listenDevices") or cfg.get("devices") or [])
        rows = []
        for device in devices:
            ident = device.get("id")
            value = states.get(ident) or {}
            caps = list(device.get("capabilities") or [])
            row = {
                "id": ident,
                "online": bool(device.get("online")),
                "listen": ident in listen_devices,
                "platform": device.get("platform") or "",
                "capabilities": caps,
                "lastSeenAgoSeconds": self._age(now, device.get("lastSeen")),
                "idleSeconds": value.get("idleSeconds"),
                "locked": value.get("locked"),
                "interactive": self._interactive(value),
                "foregroundApp": value.get("foregroundApp") or "",
                "audioPrivate": value.get("audioPrivate"),
                "bluetoothMediaOutput": (value.get("audio") or {}).get("bluetoothMediaOutput"),
                "bluetoothHeadphonesConnected":
                    (value.get("audio") or {}).get("bluetoothHeadphonesConnected"),
                "listening": (value.get("audio") or {}).get("listening"),
            }
            rows.append(row)

        # 镜头只在手机可能就在人手里时看一眼，避免无意义占用摄像头。
        laptop_quiet = any(item.get("id") == "tianxuanLaptop"
                           and isinstance(item.get("idleSeconds"), (int, float))
                           and item["idleSeconds"] >= 180 for item in rows)
        for row in rows:
            caps = row.get("capabilities") or []
            if "camera.presence" in caps:
                hint = row["id"] == listen_target or laptop_quiet
                shot = self.probe.camera(row["id"], caps, now, hint)
                if shot:
                    row["cameraPresent"] = shot.get("present")
                    row["cameraFaces"] = shot.get("faces")
            spot = self.probe.location(row["id"], caps, now)
            if spot and spot.get("hasFix"):
                row["location"] = {"lat": spot.get("lat"), "lon": spot.get("lon"),
                                   "accuracy": spot.get("accuracy"),
                                   "ageSeconds": spot.get("ageSeconds")}
            route = self.probe.route(row["id"], caps, now)
            if route:
                row["audioRoute"] = route.get("route")
                row["bluetoothAudio"] = route.get("bluetooth")
                row["musicActive"] = route.get("musicActive")
                row["callMode"] = route.get("mode")
            battery = self.probe.battery(row["id"], caps, now)
            if battery:
                row["batteryLevel"] = battery.get("batteryLevel")
                row["charging"] = battery.get("charging")
            # 固定设备按登记地点归属；移动设备按手机定位现算。
            fixed = self.places.device_place(row["id"])
            if fixed:
                row["place"] = fixed
            elif row.get("location"):
                spot = self.places.resolve(row["location"].get("lat"), row["location"].get("lon"),
                                           row["location"].get("accuracy"))
                row["place"] = spot.get("place")
                row["placeDistanceM"] = spot.get("distanceM")

        person = self._person_place(rows)
        local = datetime.fromtimestamp(now, timezone(timedelta(minutes=self.offset)))
        return {
            "at": now,
            "localTime": local.strftime("%H:%M"),
            "weekday": local.weekday(),
            "scheduleBand": self._band(local),
            "profileSchedule": self._profile_schedule(now),
            "places": self.places.names(),
            "personPlace": person,
            "listenTarget": listen_target,
            "devices": rows,
        }

    def _person_place(self, rows):
        """rows为设备行；用手机最新定位判断人在哪，过期或缺失时返回 place 为 None。"""
        for row in rows:
            spot = row.get("location")
            if not isinstance(spot, dict) or row.get("place") is None:
                continue
            age = spot.get("ageSeconds")
            if isinstance(age, (int, float)) and age > self.location_fresh:
                return {"place": None, "reason": "locationStale", "ageSeconds": age}
            return {"place": row.get("place"), "reason": "phoneLocation",
                    "distanceM": row.get("placeDistanceM"), "ageSeconds": age,
                    "source": row.get("id")}
        return {"place": None, "reason": "noLocation"}

    def _age(self, now, stamp):
        """now为当前秒、stamp为设备最后在线时间；返回秒数，缺失返回 None。"""
        try:
            return int(now - float(stamp))
        except (TypeError, ValueError):
            return None

    def _interactive(self, value):
        """value为设备屏幕/音节状态；能明确判断亮屏时返回布尔，否则 None。"""
        locked = value.get("locked")
        if locked is True:
            return False
        if locked is False:
            return True
        return None

    def _band(self, local):
        """local为本地时间；返回当前作息段名称，未配置时返回 unknown。"""
        current = local.hour * 60 + local.minute
        for item in self.routine:
            start = self._minute(item.get("start"))
            end = self._minute(item.get("end"))
            inside = start <= current < end if start <= end else current >= start or current < end
            if inside:
                return str(item.get("name") or "自定义")
        return "unknown"

    def _minute(self, value):
        """value为 HH:MM；转换为当天分钟数，异常返回 0。"""
        try:
            hour, minute = str(value).split(":", 1)
            return max(0, min(1440, int(hour) * 60 + int(minute)))
        except (TypeError, ValueError):
            return 0

    def _profile_schedule(self, now):
        """now为当前秒；十分钟内复用画像作息，避免每轮都读图谱。"""
        if now - float(self.profile_cache.get("at") or 0) < 600:
            return self.profile_cache.get("value") or []
        try:
            value = GraphProfileAdapter().load_profile().get("schedule") or []
        except Exception:
            value = []
        self.profile_cache = {"at": now, "value": value}
        return value
