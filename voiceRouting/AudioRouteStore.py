"""功能：保存短时语音路由偏好、播放目标及摄像头在场证据。

注册参数root为主项目目录；明确指令默认保持一小时完整权重，之后在一小时衰减窗内逐步降低，最后恢复自动推理。
只保存结构化设置和证据，不保存录音、照片、用户原话或硬件身份。
"""
import json
import math
import threading
import time
from pathlib import Path


class AudioRouteStore:
    """由语音网关单一进程负责写入，线程锁和原子替换避免并发丢失。"""

    DEFAULT_PREFERENCE_TTL_SECONDS = 3600

    def __init__(self, root):
        """root为生产或隔离测试根；所有状态位于私有runtime/voiceRouting。"""
        self.path = Path(root) / "runtime/voiceRouting/state.json"
        self.lock = threading.RLock()

    def read_state(self, now=None):
        """now为当前秒；过期授权仅在返回值中失效，不破坏设置版本。"""
        with self.lock:
            value = (json.loads(self.path.read_text("utf-8")) if self.path.exists()
                     else {"revision": 0, "mode": "auto", "target": None, "cameras": {}})
            current = now or time.time()
            # 兼容旧状态：过去的“永久”明确偏好按更新时间补成一小时有效期。
            if value.get("mode") != "auto" and not value.get("expiresAt"):
                value["expiresAt"] = value.get("updatedAt", current) + self.DEFAULT_PREFERENCE_TTL_SECONDS
            expires = value.get("expiresAt", 0)
            if value.get("mode") != "auto" and expires:
                decay = max(0, min(1, (current - expires) / self.DEFAULT_PREFERENCE_TTL_SECONDS))
                value["preferenceConfidence"] = round(1 - decay, 6)
            else:
                value["preferenceConfidence"] = 0 if value.get("mode") == "auto" else 1
            if value.get("mode") != "auto" and value["preferenceConfidence"] <= 0:
                value.update(mode="auto", target=None, expired=True)
            return value

    def write_state(self, value):
        """value为已经校验的完整结构化状态；原子写入同目录临时文件。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
        temp.replace(self.path)

    def set_preference(self, body, devices, now):
        """body含action/mode/target/durationSeconds；devices为真实登记表，now为当前秒。"""
        if set(body) - {"action", "mode", "target", "durationSeconds"}:
            raise ValueError("音频路由设置含未知字段")
        with self.lock:
            state = self.read_state(now)
            if body.get("action") == "clear":
                state.update(mode="auto", target=None, expiresAt=0)
            elif body.get("action") == "set":
                mode = body.get("mode", "tts" if body.get("target") else state["mode"])
                target = body.get("target", state.get("target"))
                duration = body.get("durationSeconds", self.DEFAULT_PREFERENCE_TTL_SECONDS)
                if mode not in ("auto", "tts", "qq"):
                    raise ValueError("语音模式只支持auto、tts、qq")
                if target is not None and (not isinstance(target, str) or not any(
                        d["id"] == target and d.get("enabled", True)
                        and "audio.playback" in d.get("capabilities", []) for d in devices)):
                    raise ValueError("播放目标必须是已登记且支持音频播放的设备")
                if type(duration) is not int or not 1 <= duration <= 2592000:
                    raise ValueError("设置有效期须为1至2592000秒，默认一小时")
                state.update(mode=mode, target=target, expiresAt=now + duration)
            else:
                raise ValueError("设置操作只支持set或clear")
            state.update(revision=state.get("revision", 0) + 1, updatedAt=now,
                         origin="explicitUserPreference")
            state.pop("expired", None)
            state.pop("pendingQuestionKey", None)
            state.pop("pendingQuestionUntil", None)
            self.write_state(state)
            return state

    def record_camera(self, body, devices, now):
        """body为受信摄像头管线的在场结果；不接受仅以摄像头存在或有人脸作为主人身份。"""
        allowed = {"deviceId", "observedAt", "present", "ownerConfidence", "wearingHeadphones"}
        if set(body) - allowed or not allowed <= set(body):
            raise ValueError("摄像头证据字段不完整")
        stamp, score = body["observedAt"], body["ownerConfidence"]
        if (type(stamp) not in (int, float) or not math.isfinite(stamp)
                or not -5 <= now - stamp <= 90 or type(score) not in (int, float)
                or not math.isfinite(score) or not 0 <= score <= 1
                or type(body["present"]) is not bool
                or (body["wearingHeadphones"] is not None
                    and type(body["wearingHeadphones"]) is not bool)):
            raise ValueError("摄像头证据时间或置信度无效")
        if not any(d["id"] == body["deviceId"] and d.get("enabled", True)
                   and any(c.startswith("camera.") for c in d.get("capabilities", []))
                   for d in devices):
            raise ValueError("摄像头证据设备未登记或没有摄像头能力")
        with self.lock:
            state = self.read_state(now)
            previous = state.setdefault("cameras", {}).get(body["deviceId"], {})
            if previous.get("observedAt", 0) >= stamp:
                return
            state["cameras"][body["deviceId"]] = {
                k: body[k] for k in allowed if k != "deviceId"}
            self.write_state(state)

    def reserve_question(self, key, now):
        """key为缺失路由原因摘要；最多每30分钟占用一次QQ询问机会，失败也不重复轰炸。"""
        with self.lock:
            state = self.read_state(now)
            if (state.get("pendingQuestionKey") == key
                    and now < state.get("pendingQuestionUntil", 0)):
                return False
            if now - state.get("lastQuestionAt", 0) < 1800:
                return False
            state.update(lastQuestionAt=now, lastQuestionKey=key)
            self.write_state(state)
            return True

    def mark_question_queued(self, key, now):
        """key/now为成功入QQ收件箱的问题；同一未回答问题六小时内不重复询问。"""
        with self.lock:
            state = self.read_state(now)
            state.update(pendingQuestionKey=key, pendingQuestionUntil=now + 21600)
            self.write_state(state)
