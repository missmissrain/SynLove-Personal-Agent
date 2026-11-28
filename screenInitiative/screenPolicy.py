"""功能：将短期终端状态与模型建议转成是否打扰、采用文字或语音的确定性策略。

注册参数config为私有配置；默认空闲超过120秒不观察、超过45秒不主动语音。
时间使用配置的UTC偏移，默认中国时区；会议、专注、夜间、过期状态均由代码抑制。
"""
import math
from datetime import datetime, timedelta, timezone


class ScreenPolicy:
    """模型建议受设备证据与用户设置约束，未知状态不解释为允许外放。"""

    def __init__(self, config, audio_router=None):
        """config为已加载策略；不存在的授权按关闭处理。"""
        self.config = config
        self.audio_router = audio_router

    def is_quiet(self, now):
        """now为Unix秒；按配置时区检查跨日安静时间和手动勿扰。"""
        if self.config.get("activity") in ("meeting", "focus", "sleep"):
            return True
        local = datetime.fromtimestamp(now, timezone(timedelta(
            minutes=self.config.get("utcOffsetMinutes", 480))))
        start, end = self.config.get("quietHours", ["23:00", "08:00"])
        current = local.strftime("%H:%M")
        return (start <= current < end) if start < end else (current >= start or current < end)

    def is_active(self, state, now, limit=120):
        """state为终端采样，now为当前秒，limit为空闲阈值；未知、过期和未来时间拒绝。"""
        sampled, idle = state.get("sampledAt"), state.get("idleSeconds")
        return (state.get("locked") is False
                and type(sampled) in (int, float) and math.isfinite(sampled)
                and -5 <= now - sampled <= 30
                and type(idle) in (int, float) and math.isfinite(idle) and 0 <= idle <= limit)

    def choose_route(self, decision, source, states, devices, now):
        """decision为已校验模型输出，source为观察设备；仅从明确配置的在线输出选路。"""
        if (self.is_quiet(now) or not decision.get("speak") or decision.get("sensitive")
                or decision.get("busy") or decision.get("confidence", 0) < 0.8):
            return {"mode": "silent", "reason": "暂不打扰"}
        if self.audio_router is not None:
            if decision.get("modality") == "text" or self.config.get("preferredChannel") == "qq":
                return {"mode": "qq", "reason": "文字更适合内容"}
            return self.audio_router.resolve_for_states(source, "initiative", devices, states, now)
        current = states.get(source, {})
        if not self.is_active(current, now):
            return {"mode": "silent", "reason": "用户活动证据已失效"}
        # 只有单一活跃终端时才自动语音；多终端同时活跃时文字更稳妥。
        active = [key for key, value in states.items() if self.is_active(value, now)]
        target = self.config.get("voiceOutputs", {}).get(source)
        device = next((item for item in devices if item["id"] == target), {})
        app = current.get("foregroundApp", "").lower()
        call_app = any(word in app for word in ("teams", "zoom", "voov", "meeting", "obs64"))
        output_state = states.get(target, {})
        private_audio = (output_state.get("audioPrivate") is True
                         and self.is_active(output_state, now))
        speaker = self.config.get("allowSpeaker", {}).get(target) is True
        prefer = self.config.get("preferredChannel", "auto")
        can_speak = (decision.get("modality") in ("auto", "tts") and prefer != "qq"
                     and len(active) == 1 and self.is_active(current, now, 45)
                     and not call_app and isinstance(target, str) and device.get("online") is True
                     and "audio.playback" in device.get("capabilities", [])
                     and (private_audio or speaker))
        if can_speak:
            return {"mode": "tts", "target": target, "reason": "单一活跃终端且输出已有授权"}
        return {"mode": "qq", "reason": "文字更适合当前状态或语音去向不确定"}
