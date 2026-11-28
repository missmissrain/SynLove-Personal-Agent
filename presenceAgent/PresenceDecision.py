"""功能：严格校验模型返回的在场判定 JSON，拒绝越权设备、越界分数与超长理由。

注册参数allowed为可监听设备集合，maxReasonChars为理由长度上限；默认只接受白名单内设备。
本类只做校验与归一化，不修改路由、不发送命令。
"""
import json


class PresenceDecision:
    """把模型输出收敛为固定字段，避免自由文本影响路由。"""

    ACTIVITIES = ("atDevice", "nearby", "awayFromComputers", "unknown")

    def __init__(self, allowed, max_reason_chars=240, online=None):
        """allowed为允许的设备ID集合；maxReasonChars为理由最大字符数；online为当前在线集合（可选）。"""
        self.allowed = set(allowed or [])
        self.online = set(online) if online is not None else None
        self.max_reason_chars = int(max_reason_chars)

    def validate(self, raw):
        """raw为模型返回的文本或字典；返回归一化决策，不合规时抛出 ValueError。"""
        value = raw
        if isinstance(raw, str):
            text = raw.strip()
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            if text.rstrip().endswith("```"):
                text = text.rstrip()[:-3]
            value = json.loads(text.strip())
        if not isinstance(value, dict):
            raise ValueError("判定不是对象")
        target = value.get("target")
        if target is not None and (not isinstance(target, str) or target not in self.allowed):
            raise ValueError("判定设备不可监听:" + str(target)[:40])
        if target is not None and self.online is not None and target not in self.online:
            raise ValueError("判定设备当前离线:" + str(target)[:40])
        confidence = value.get("confidence", 0)
        if type(confidence) not in (int, float) or not 0 <= float(confidence) <= 1:
            raise ValueError("判定置信度无效")
        activity = value.get("activity", "unknown")
        if activity not in self.ACTIVITIES:
            raise ValueError("判定活动类型无效")
        if target is not None and activity not in ("atDevice", "nearby"):
            raise ValueError("选出设备但活动类型矛盾:" + activity)
        code = value.get("reasonCode") or "agent"
        if not isinstance(code, str) or not 1 <= len(code) <= 40:
            raise ValueError("判定原因码无效")
        reasoning = value.get("reasoning") or ""
        if not isinstance(reasoning, str):
            raise ValueError("判定理由无效")
        reasoning = reasoning.strip()[: self.max_reason_chars]
        if target is not None and not reasoning:
            raise ValueError("判定缺少理由")
        exclude = []
        for item in value.get("exclude") or []:
            if isinstance(item, dict) and item.get("deviceId") in self.allowed:
                exclude.append({"deviceId": item["deviceId"],
                                "why": str(item.get("why") or "")[:80]})
        return {"target": target, "confidence": float(confidence), "activity": activity,
                "reason": code, "reasoning": reasoning, "exclude": exclude[:6]}
