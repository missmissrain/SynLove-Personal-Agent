"""功能：把手机定位与已登记地点对应起来，回答「人现在在哪个地点」「某台设备固定在哪」。

注册参数config为地点库（places 列表）；默认只在半径内匹配，未登记坐标的地点只作为名字绑定。
本类不做定位、不联网、不写配置，只做距离换算与设备归属查询。
"""
import math


class PlaceResolver:
    """按地点半径判断当前位置，并把固定设备归属到地点。"""

    def __init__(self, config=None):
        """config中places为[{name,lat,lon,radiusM,devices}]；缺省时地点库为空。"""
        self.config = dict(config or {})
        self.places = [item for item in (self.config.get("places") or [])
                       if isinstance(item, dict) and item.get("name")]
        self.default_radius = float(self.config.get("placeRadiusM", 250))

    def resolve(self, lat, lon, accuracy=None):
        """lat/lon为手机坐标；返回 {place, distanceM}，都不在范围内时 place 为 None。"""
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            return {"place": None, "distanceM": None}
        best = None
        for item in self.places:
            try:
                plat = float(item["lat"])
                plon = float(item["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            distance = self._distance(lat, lon, plat, plon)
            radius = float(item.get("radiusM") or self.default_radius)
            # 定位精度差时放宽半径，避免明明在同一地点却判不出来。
            if isinstance(accuracy, (int, float)):
                radius = max(radius, float(accuracy) * 2)
            if distance <= radius and (best is None or distance < best["distanceM"]):
                best = {"place": item["name"], "distanceM": int(distance)}
        return best or {"place": None, "distanceM": None}

    def device_place(self, device_id):
        """device_id为设备ID；返回该设备登记的地点名，未登记返回 None。"""
        for item in self.places:
            if device_id in (item.get("devices") or []):
                return item["name"]
        return None

    def names(self):
        """无参数；返回全部已登记地点名，供提示词与排查使用。"""
        return [item["name"] for item in self.places]

    def _distance(self, lat1, lon1, lat2, lon2):
        """两点经纬度；返回近似米数。"""
        dy = (lat1 - lat2) * 111320.0
        dx = (lon1 - lon2) * 111320.0 * math.cos(math.radians((lat1 + lat2) / 2))
        return (dx * dx + dy * dy) ** 0.5
