"""功能：统一解析主动语音和对话回复的输出设备，分离采音来源与播放去向。

注册参数config为独立路由配置；默认强证据阈值0.85，摄像头主人识别阈值0.90。
优先级为带连续置信度的主人明确设置、实际耳机媒体输出、高置信在场和授权扬声器、既有回复映射。
"""
from screenInitiative.PresenceInference import PresenceInference


class AudioRoutePolicy:
    """纯策略，不发消息、不合成音频，不把配对耳机等价于佩戴或实际输出。"""

    def __init__(self, config):
        """config含devices、outputs、allowSpeaker，缺失授权默认不允许主动外放。"""
        self.config = config

    def choose_route(self, source, purpose, preference, devices, states, now,
                     presence=None):
        """source为采音/观察设备；purpose为reply或initiative；presence为统一在场结论。"""
        revision = preference.get("revision", 0)
        explicit_confidence = max(0, min(1, preference.get("preferenceConfidence", 1)))
        def result(mode, reason, target=None, score=0, ask=False):
            """mode/reason/target/score/ask生成统一路由结果，不宣称播放已经完成。"""
            return {"mode": mode, "target": target, "confidence": score, "reason": reason,
                    "revision": revision, "needsTarget": ask}
        if preference.get("mode") == "qq" and explicit_confidence > 0:
            return result("qq", "explicitTextPreference", score=explicit_confidence)
        registry = {d["id"]: d for d in devices if d.get("enabled", True)}
        def playable(key):
            """key为目标ID；只有在线且声明真实播放能力的登记设备可投送。"""
            dev = registry.get(key, {})
            return dev.get("online") is True and "audio.playback" in dev.get("capabilities", [])
        target = preference.get("target")
        if target and explicit_confidence > 0:
            return (result("tts", "explicitTarget", target, explicit_confidence)
                    if playable(target)
                    else result("qq", "explicitTargetUnavailable",
                                score=explicit_confidence, ask=True))
        # 统一在场推理优先：她说给谁听、要不要说，都以同一份结论为准。
        if presence and presence.get("state") in ("resolved", "uncertain", "away"):
            presence_target = presence.get("ttsTarget")
            if (purpose == "initiative" and presence.get("proactiveSpeak") is not True):
                return result("qq", "presenceTextOnly",
                              score=float(presence.get("confidence") or 0))
            if (presence.get("speak") is True and presence_target
                    and playable(presence_target)):
                return result("tts", "presenceTarget", presence_target,
                              float(presence.get("confidence") or 0) or .6)
            return result("qq", "presenceAway" if presence.get("state") == "away"
                          else "presenceTextOnly",
                          score=float(presence.get("confidence") or 0))
        inferred = PresenceInference(self.config)
        candidates = []
        for key, dev in registry.items():
            if not playable(key) or key not in self.config.get("devices", []):
                continue
            state = states.get(key, {})
            evidence = inferred.device_evidence(key, dev, state, now)
            audio = state.get("audio", {})
            audio_fresh = (isinstance(audio, dict) and audio.get("available") is True
                           and inferred.finite_number(audio.get("sampledAt"))
                           and -5 <= now - audio["sampledAt"] <= 45)
            private = audio_fresh and (
                audio.get("bluetoothMediaOutput") is True or (
                    state.get("audioPrivate") is True
                    and audio.get("defaultOutput", {}).get("headphones") is True))
            if (private and state.get("locked") is False
                    and inferred.finite_number(state.get("idleSeconds"))
                    and state["idleSeconds"] <= 1800 and evidence["score"] < .85):
                evidence.update(score=.87, reason="privateMediaOutput")
            # 摄像头看到戴耳机并不证明音频正在该设备的耳机输出，仍须媒体端点证据。
            permitted = (private or (preference.get("mode") == "tts"
                                    and explicit_confidence > 0)
                         or self.config.get("allowSpeaker", {}).get(key) is True)
            if permitted and state.get("locked") is not True and evidence["score"] >= .85:
                candidates.append((evidence["score"], key, private, evidence["reason"],
                                   audio_fresh and audio.get("bluetoothMediaOutput") is True))
        private = [x for x in candidates if x[2]]
        bluetooth = [x for x in private if x[4]]
        pool = sorted(bluetooth or private or candidates, reverse=True)
        if pool and (len(pool) == 1 or pool[0][0] - pool[1][0] >= .08 - 1e-9):
            score, target, private, reason, _ = pool[0]
            return result("tts", "headphoneOutput" if private else reason, target, score)
        if len(pool) > 1:
            return result("qq", "ambiguousOutputs", ask=True)
        if purpose == "reply" and preference.get("mode") != "tts":
            target = self.config.get("outputs", {}).get(source, source)
            if playable(target):
                return result("tts", "replyOutput", target, .8)
        return result("qq", "noConfidentOutput", ask=True)
