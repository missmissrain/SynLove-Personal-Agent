"""功能：管理服务器默认唤醒音频轮换池的清单、去重、上限和过期删除。

注册参数root默认runtime/voiceDeployment/wakeReplies，cache_root默认runtime/voice/wakeCache，
max_items默认10。该类只管理已通过WAV校验的文件与元数据，不生成音频、不调用模型。
"""
import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path


class WakeReplyPoolManager:
    """维护最多十条固定音色唤醒应答，并安全删除最早条目。"""

    def __init__(self, root=None, cache_root=None, max_items=10):
        """root为部署音频目录，cache_root为语音缓存目录，max_items为池上限。"""
        base = Path(root or Path(__file__).resolve().parents[1] / "runtime/voiceDeployment/wakeReplies")
        self.root = base
        self.cache_root = Path(cache_root or Path(__file__).resolve().parents[1] / "runtime/voice/wakeCache")
        self.manifest = self.root / "WakeReplyPool.json"
        self.max_items = max(1, int(max_items))
        self.lock = threading.Lock()

    def load(self):
        """无参数；读取并校验池清单，不可读时返回空池。"""
        try:
            data = json.loads(self.manifest.read_text("utf-8-sig"))
            rows = data.get("replies")
            return list(rows) if isinstance(rows, list) else []
        except (OSError, ValueError):
            return []

    def save(self, rows):
        """rows为待保存的应答记录；原子写入池清单并保留UTF-8中文。"""
        self.root.mkdir(parents=True, exist_ok=True)
        temp = self.manifest.with_suffix(".tmp")
        temp.write_text(json.dumps({"version": 1, "maxItems": self.max_items,
                                    "replies": rows}, ensure_ascii=False, indent=2), "utf-8")
        temp.replace(self.manifest)

    def initialize_from_catalog(self, catalog_path, audio_root=None):
        """catalog_path为既有试听清单；将已经验收的音频转换为轮换池清单并去重。"""
        source = Path(catalog_path)
        data = json.loads(source.read_text("utf-8-sig"))
        rows = data.get("replies")
        if not isinstance(rows, list):
            raise ValueError("试听清单缺少replies")
        audio_dir = Path(audio_root or source.parent)
        prepared = []
        for row in rows:
            file_name = str(row.get("file") or "")
            file_path = audio_dir / file_name
            if not file_path.is_file():
                continue
            item = dict(row)
            item["createdAt"] = item.get("createdAt") or datetime.fromtimestamp(
                file_path.stat().st_mtime, timezone.utc).isoformat()
            item["sha256"] = hashlib.sha256(file_path.read_bytes()).hexdigest()
            prepared.append(item)
        prepared.sort(key=lambda item: item.get("createdAt", ""))
        with self.lock:
            self.save(prepared[-self.max_items:])
        return prepared[-self.max_items:]

    def add(self, row):
        """row为已生成且已核验的应答记录；按正文和摘要去重，超限删除最早音频及缓存。"""
        item = dict(row)
        item["createdAt"] = item.get("createdAt") or datetime.now(timezone.utc).isoformat()
        file_name = str(item.get("file") or "")
        if not file_name:
            raise ValueError("轮换应答缺少file")
        file_path = self.root / file_name
        if not file_path.is_file():
            raise FileNotFoundError(str(file_path))
        item["sha256"] = hashlib.sha256(file_path.read_bytes()).hexdigest()
        with self.lock:
            rows = self.load()
            rows = [old for old in rows if old.get("text") != item.get("text")
                    and old.get("sha256") != item.get("sha256")]
            rows.append(item)
            rows.sort(key=lambda old: old.get("createdAt", ""))
            removed = rows[:-self.max_items] if len(rows) > self.max_items else []
            rows = rows[-self.max_items:]
            self.save(rows)
            for old in removed:
                self._remove_file(old)
        return {"added": item, "removed": removed, "count": len(rows)}

    def _remove_file(self, row):
        """row为被淘汰的清单记录；删除部署音频和可定位的缓存副本，删除失败不影响清单更新。"""
        for raw in (row.get("file"), row.get("cacheFile")):
            if not raw:
                continue
            path = Path(raw)
            if not path.is_absolute():
                path = self.root / raw if raw == row.get("file") else self.cache_root / raw
            try:
                if path.is_file():
                    path.unlink()
            except OSError:
                pass
