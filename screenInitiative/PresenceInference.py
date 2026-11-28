"""功能：融合近期输入、锁屏及蓝牙媒体先验，输出设备位置和离开电脑的保守推断。

注册参数config为独立观察配置；蓝牙先验默认开启，耳机证据45秒有效。
默认全部电脑连续5分钟且各自15分钟无输入才推测离开电脑；物理地点始终未知。
"""
import math
from profilePresence.ProfilePresenceReasoner import ProfilePresenceReasoner


class PresenceInference:
    """采用可解释规则评分，不把主观置信评分当作经过校准的身份概率。"""

    def __init__(self, config):
        """config提供设备白名单及先验开关和时限；不访问网络、摄像头或模型。"""
        self.config = config
        self.profile_reasoner = ProfilePresenceReasoner(config.get("presenceProfile", {}))

    def finite_number(self, value):
        """value为外部状态字段；只接受有限数值，排除布尔值、NaN与无穷。"""
        return type(value) in (int, float) and math.isfinite(value)

    def fresh_state(self, value, now):
        """value为设备采样，now为完成采样后的时间；拒绝过时和明显未来的状态。"""
        stamp = value.get("sampledAt")
        # 终端与服务器的时钟可能存在少量偏差；允许15秒未来偏差，避免并行采样被误判过期。
        return self.finite_number(stamp) and -15 <= now - stamp <= 45

    def device_evidence(self, key, device, value, now):
        """key/device/value为设备与状态，now为当前秒；返回脱敏证据及候选评分。"""
        fresh = device.get("online") is True and self.fresh_state(value, now)
        idle = value.get("idleSeconds")
        idle = idle if self.finite_number(idle) and idle >= 0 else None
        audio = value.get("audio")
        audio = audio if isinstance(audio, dict) else {}
        audio_stamp = audio.get("sampledAt")
        audio_fresh = (fresh and audio.get("available") is True and self.finite_number(audio_stamp)
                       and -5 <= now - audio_stamp <= 45)
        media = audio_fresh and audio.get("bluetoothMediaOutput") is True
        connected = audio_fresh and audio.get("bluetoothHeadphonesConnected") is True
        prior = self.config.get("presenceBluetoothPrior", True) is True
        recent = fresh and value.get("locked") is False and idle is not None and idle <= 120
        score, reason = 0.0, "noFreshEvidence"
        if recent:
            score, reason = 0.90, "recentInput"
            if prior and media:
                score, reason = 0.95, "recentInputAndBluetoothMedia"
            elif prior and connected:
                score, reason = 0.93, "recentInputAndBluetoothHeadphones"
        elif fresh and prior and (media or connected):
            score = (0.87 if media else 0.72) if value.get("locked") is False else (0.76 if media else 0.62)
            if idle is not None and idle > self.config.get("presenceBluetoothIdleSeconds", 1800):
                score = min(score, .68 if media else .50)
            reason = "bluetoothMediaOutput" if media else "bluetoothHeadphonesConnected"
        elif fresh and value.get("locked") is False and idle is not None and idle <= 3600:
            score, reason = 0.35, "recentHistoricalInput"
        camera = value.get("camera")
        camera = camera if isinstance(camera, dict) else {}
        camera_stamp, owner = camera.get("observedAt"), camera.get("ownerConfidence")
        camera_owner = (device.get("online") is True and value.get("locked") is not True
                        and camera.get("present") is True and self.finite_number(camera_stamp)
                        and -5 <= now - camera_stamp <= 90 and self.finite_number(owner)
                        and owner >= self.config.get("cameraOwnerThreshold", .9))
        if camera_owner:
            score, reason = .98, "cameraOwnerPresent"
        return {"deviceId": key, "online": device.get("online") is True, "fresh": fresh,
                "locked": value.get("locked") if fresh else None, "idleSeconds": idle if fresh else None,
                "sampledAt": value.get("sampledAt") if fresh else None,
                "bluetoothHeadphonesConnected": audio.get("bluetoothHeadphonesConnected") if audio_fresh else None,
                "bluetoothMediaOutput": audio.get("bluetoothMediaOutput") if audio_fresh else None,
                "cameraOwnerPresent": camera_owner,
                "recentInput": recent, "score": score, "reason": reason}

    def infer_presence(self, devices, states, old, now):
        """devices/states为本轮实测，old为上轮状态，now为当前秒；返回可持久化推断。"""
        allowed = self.config.get("devices", [])
        registry = {item["id"]: item for item in devices if item["id"] in allowed}
        evidence = [self.device_evidence(key, registry.get(key, {}), states.get(key, {}), now)
                    for key in allowed]
        reasoning = self.profile_reasoner.reason(evidence, now, self.config.get("locationEvidence"))
        profile_by_id = {item["deviceId"]: item for item in reasoning.get("candidates", [])}
        for item in evidence:
            profile = profile_by_id.get(item["deviceId"])
            if profile and profile.get("reason") == "profileSchedulePrior" and profile.get("score", 0) > item["score"]:
                item.update(score=profile["score"], reason=profile["reason"])
        result = {"state": "unknown", "deviceId": None, "confidence": 0.0,
                  "activeDevices": [item["deviceId"] for item in evidence if item["recentInput"]],
                  "onlineDevices": [key for key, item in registry.items() if item.get("online")],
                  "observedAt": now, "expiresAt": now + self.config.get("presenceTtlSeconds", 7200),
                  "source": "terminalEvidence", "physicalLocation": "unknown",
                  "activity": "unknown", "evidence": evidence,
                  "reasoningSource": reasoning.get("source", "profilePresenceReasoner"),
                  "profileCandidates": reasoning.get("profileCandidates", [])}
        candidates = sorted((item for item in evidence if item["score"] > 0),
                            key=lambda item: (-item["score"],
                                              item["idleSeconds"] if item["idleSeconds"] is not None else 10**9))
        # 离线、未授权与传输失败不能作为不在场证明。
        away = bool(evidence) and all(item["fresh"] and item["score"] < .62
                                     and item["bluetoothHeadphonesConnected"] is not True
                                     and item["bluetoothMediaOutput"] is not True and (
            item["locked"] is True or
            (item["idleSeconds"] is not None and item["idleSeconds"] >=
             self.config.get("presenceAbsenceSeconds", 900))) for item in evidence)
        if away:
            since = old.get("absenceSince", now)
            since = since if self.finite_number(since) and since <= now else now
            result["absenceSince"] = since
            if now - since >= self.config.get("presenceAwayHoldSeconds", 300):
                result.update(state="inferred", confidence=0.65, activity="awayFromComputers",
                              source="completeTerminalExclusion",
                              locationHypotheses=["elsewhereAtHomePossible", "outsidePossible"])
                return result
        if candidates:
            best = candidates[0]
            if (best["score"] <= .35 and old.get("deviceId")
                    and old["deviceId"] != best["deviceId"]
                    and (old.get("confidence", 0) >= .62 or
                         old.get("source") == "previousStrongerEvidence")
                    and now < old.get("expiresAt", 0)):
                result.update(state="stale", deviceId=old["deviceId"], confidence=.35,
                              expiresAt=old["expiresAt"], source="previousStrongerEvidence")
                return result
            ambiguous = (len(candidates) > 1
                         and best["score"] - candidates[1]["score"] < 0.08 - 1e-9)
            result.update(state="known" if best["recentInput"] and not ambiguous else "inferred",
                          deviceId=best["deviceId"], confidence=0.60 if ambiguous else best["score"],
                          activity=("possiblyAwayFromComputers" if away else
                                    ("atDevice" if best["score"] >= .62 else "recentDevice")),
                          source=best["reason"], ambiguous=ambiguous,
                          candidates=[{"deviceId": item["deviceId"], "score": item["score"]}
                                      for item in candidates])
            return result
        if old.get("deviceId") and now < old.get("expiresAt", 0):
            result.update(state="stale", deviceId=old["deviceId"],
                          confidence=min(old.get("confidence", .35), .35),
                          expiresAt=old["expiresAt"], source="previousEvidence")
        if away:
            result["activity"] = "possiblyAwayFromComputers"
        return result
