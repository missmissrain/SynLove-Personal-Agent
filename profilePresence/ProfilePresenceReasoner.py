"""功能：把人物画像、作息先验和实时设备证据交给统一位置推理子代理。

注册参数profile为画像与作息配置；runner为可选子代理工具执行器。
子代理只返回位置候选，不直接播放语音、不修改路由、不扩大传感器权限。
"""
from datetime import datetime, timezone, timedelta
from profilePresence.GraphProfileAdapter import GraphProfileAdapter


class ProfilePresenceReasoner:
    """统一收集低频画像先验，给实时PresenceInference提供可解释候选。"""

    def __init__(self, profile=None, runner=None, graph_provider=None):
        """profile为调度覆盖配置；runner接收证据并可调用工具，graph_provider读取graph_snapshot。"""
        self.profile = profile or {}
        graph_profile = GraphProfileAdapter(graph_provider).load_profile()
        if graph_profile.get("schedule"):
            # 图谱是画像事实源；配置只保留调度与安全覆盖，不覆盖作息内容。
            self.profile = {**self.profile, "schedule": graph_profile["schedule"],
                            "source": graph_profile.get("source", "graphSnapshot")}
        self.runner = runner

    def _minute(self, value):
        """value为HH:MM字符串；转换为当天分钟数，异常时返回0。"""
        try:
            hour, minute = str(value).split(":", 1)
            return max(0, min(1440, int(hour) * 60 + int(minute)))
        except (TypeError, ValueError):
            return 0

    def schedule_candidates(self, now):
        """now为Unix秒；按工作日和时间窗生成低权重画像候选。"""
        offset = int(self.profile.get("utcOffsetMinutes", 480))
        local = datetime.fromtimestamp(now, timezone(timedelta(minutes=offset)))
        weekday = str(local.weekday())
        current = local.hour * 60 + local.minute
        result = []
        for item in self.profile.get("schedule", []):
            if weekday not in [str(value) for value in item.get("weekdays", [])]:
                continue
            start, end = self._minute(item.get("start", "00:00")), self._minute(item.get("end", "24:00"))
            inside = start <= current < end if start <= end else current >= start or current < end
            if inside and isinstance(item.get("deviceId"), str):
                result.append({"deviceId": item["deviceId"],
                               "score": min(float(item.get("confidence", .55)), .58),
                               "reason": "profileSchedulePrior",
                               "evidence": ["confirmedProfileSchedule"]})
        return result

    def reason(self, evidence, now, location=None):
        """evidence为设备脱敏快照，location为手机定位摘要；返回候选及证据来源。"""
        payload = {"evidence": evidence, "location": location or {},
                   "profileCandidates": self.schedule_candidates(now)}
        if callable(self.runner):
            result = self.runner(payload)
            if isinstance(result, dict) and isinstance(result.get("candidates"), list):
                return result
        merged = {item["deviceId"]: dict(item) for item in evidence if item.get("score", 0) > 0}
        outside = payload["location"].get("outside") is True
        for item in payload["profileCandidates"]:
            if outside:
                continue
            current = merged.get(item["deviceId"])
            if current is None:
                merged[item["deviceId"]] = dict(item)
            elif item["score"] > current.get("score", 0):
                current.update(score=item["score"], reason=item["reason"])
        return {"candidates": sorted(merged.values(),
                                     key=lambda value: (-value.get("score", 0),
                                                        value.get("deviceId", ""))),
                "profileCandidates": payload["profileCandidates"],
                "source": "profilePresenceReasoner"}
