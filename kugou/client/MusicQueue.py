"""音乐队列编排：保存候选曲目、逐首切换与补页，不启动或控制任何本机播放进程。

注册参数api为服务器曲目解析器，state_path为本机队列状态路径；
实际播放由子类通过独立终端接口实现，默认队列为空、索引为0。
"""
import json
import threading
from pathlib import Path


class MusicQueue:
    """为终端音乐适配器提供队列，不依赖ffplay、Windows进程或音频设备。"""

    def __init__(self, api, state_path):
        """api为曲目API，state_path为队列JSON；复用已有队列并建立可重入锁。"""
        self.api = api
        self.state_path = Path(state_path)
        self.state = self._load()
        self._gen = 0
        self._refill = None
        self._lock = threading.RLock()

    def play(self, songs, start=0, refill=None):
        """songs为曲目列表，start为起始索引，refill为下一页回调；提交当前曲目至终端。"""
        if not songs:
            raise ValueError("没有可播放的歌曲")
        with self._lock:
            self._gen += 1
            self._refill = refill
            self.state = {"queue": list(songs), "index": max(0, min(start, len(songs)-1)),
                          "playbackId": "", "paused": False}
        return self._play_current()

    def current(self):
        """无参数；返回索引对应的曲目，空队列或越界返回None。"""
        with self._lock:
            songs = self.state.get("queue") or []
            index = int(self.state.get("index") or 0)
            return songs[index] if 0 <= index < len(songs) else None

    def next(self):
        """无参数；前进一首，必要时通过已注册回调补充下一页。"""
        return self._advance(1)

    def prev(self):
        """无参数；后退一首，首曲处明确返回失败。"""
        return self._advance(-1)

    def _advance(self, delta):
        """delta为相对曲目位移；只更新队列，播放控制交给终端子类。"""
        with self._lock:
            songs = list(self.state.get("queue") or [])
            index = int(self.state.get("index") or 0) + delta
            if index >= len(songs) and self._refill:
                try:
                    songs.extend(self._refill() or [])
                except Exception:
                    return {"ok": False, "error": "歌单补页失败"}
                self.state["queue"] = songs
            if not 0 <= index < len(songs):
                return {"ok": False, "error": "歌单播完了"}
            self.state["index"] = index
            return self._play_current()

    def _play_current(self):
        """无参数；子类必须实现终端播放接口，基类不能在服务器启动播放器。"""
        raise NotImplementedError("尚未配置终端音乐适配器")

    def _load(self):
        """无参数；读取有效队列状态，文件缺失或损坏时返回空队列。"""
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8-sig"))
            if isinstance(data, dict) and isinstance(data.get("queue"), list):
                return data
        except (OSError, ValueError):
            pass
        return {"queue": [], "index": 0, "playbackId": "", "paused": False}

    def _save(self):
        """无参数；在队列锁内原子替换状态文件，不记录音频地址和认证信息。"""
        with self._lock:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.state_path.with_name(self.state_path.name + ".tmp")
            temp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(self.state_path)
