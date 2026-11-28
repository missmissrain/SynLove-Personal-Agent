"""功能：通过既有graph_snapshot基础设施读取主人画像，转换为位置推理所需的脱敏先验。

注册参数snapshot_provider为graph_snapshot调用函数；默认使用memoryService现有快照实现。
只读取主人画像备注，不写图谱、不保存原始定位，不把单次设备事实升级为长期画像。
"""
import re


class GraphProfileAdapter:
    """把知识图谱节点适配为ProfilePresenceReasoner的输入格式。"""

    def __init__(self, snapshot_provider=None):
        """snapshot_provider无参数并返回nodes/edges快照；未提供时读取现有memoryService。"""
        self.snapshot_provider = snapshot_provider or self._default_snapshot

    def _default_snapshot(self):
        """无参数；调用既有graph_snapshot实现，失败时返回空快照。"""
        try:
            from memory.memoryService import snapshot
            return snapshot()
        except Exception:
            return {"nodes": [], "edges": []}

    def load_profile(self):
        """无参数；从主人节点的画像备注提取作息先验和证据来源。"""
        snapshot = self.snapshot_provider() or {}
        nodes = snapshot.get("nodes", []) if isinstance(snapshot, dict) else []
        notes = ""
        for node in nodes:
            if node.get("name") == "主人":
                notes = str(node.get("notes", ""))
                break
        schedule = []
        match = re.search(r"上班\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})", notes)
        if match:
            schedule.append({"name": "知识图谱作息-工作日", "weekdays": [0, 1, 2, 3, 4],
                             "start": match.group(1), "end": match.group(2),
                             "deviceId": "androidGateway", "confidence": .55,
                             "source": "graphSnapshot"})
        return {"schedule": schedule, "source": "graphSnapshot"}
