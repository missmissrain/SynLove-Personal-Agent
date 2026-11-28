"""功能：酷狗音乐插件。把搜索、播放、控制、歌单能力包成统一动作。

注册参数 root 为主项目 Path、config 为可选配置；默认读 kugou/config/kugou.json 与
config/musicPlayback.json。API 与播放器首次调用时才创建，失败直接抛出原因。
"""
import json
from pathlib import Path


class MusicPlugin:
    """酷狗音乐的唯一调用出口。"""

    description = "酷狗音乐：搜索、播放、暂停/继续/切歌、歌单"

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 为可选覆盖配置。"""
        self.root = Path(root)
        self.overrides = dict(config or {})
        self.api = None
        self.playback = None

    def actions(self):
        """无参数；返回动作目录。"""
        return [
            {"name": "search", "description": "按关键词搜歌",
             "args": {"query": "关键词", "limit": "可选，默认 10"}},
            {"name": "play", "description": "搜到第一首并播放",
             "args": {"query": "关键词"}},
            {"name": "control", "description": "播放控制",
             "args": {"action": "next|prev|pause|resume|stop"}},
            {"name": "status", "description": "当前播放状态", "args": {}},
            {"name": "playlists", "description": "登录用户的歌单", "args": {}},
            {"name": "playlist_tracks", "description": "歌单曲目",
             "args": {"name": "歌单名或 gcid", "limit": "可选，默认 30"}},
            {"name": "play_playlist", "description": "按歌单开始播放",
             "args": {"name": "歌单名或 gcid"}},
        ]

    def call(self, action, payload):
        """action 为动作名、payload 为参数；返回结构化结果。"""
        api, playback = self._ensure()
        if action == "search":
            query = str(payload.get("query") or "").strip()
            if not query:
                raise ValueError("search 需要 query")
            return api.search(query, int(payload.get("limit") or 10))
        if action == "play":
            query = str(payload.get("query") or "").strip()
            if not query:
                raise ValueError("play 需要 query")
            songs = api.search(query, 1)
            if not songs:
                raise RuntimeError("没有搜到：" + query)
            playback.play([songs[0]], 0)
            return {"song": songs[0], "status": playback.status()}
        if action == "control":
            name = str(payload.get("action") or "").strip()
            if name == "next":
                return playback.next()
            if name == "prev":
                return playback.prev()
            if name == "pause":
                return playback.set_paused(True)
            if name == "resume":
                return playback.set_paused(False)
            if name == "stop":
                return playback.stop()
            raise ValueError("control 只支持 next/prev/pause/resume/stop")
        if action == "status":
            return playback.status()
        if action == "playlists":
            return api.user_playlists()
        if action == "playlist_tracks":
            found = api.find_playlist(str(payload.get("name") or ""))
            if not found:
                raise RuntimeError("没有这个歌单：" + str(payload.get("name") or ""))
            gcid, name = found["gcid"], found["name"]
            return {"playlist": name, "songs": api.playlist_page(
                gcid, 1, int(payload.get("limit") or 30))}
        if action == "play_playlist":
            found = api.find_playlist(str(payload.get("name") or ""))
            if not found:
                raise RuntimeError("没有这个歌单：" + str(payload.get("name") or ""))
            gcid, name = found["gcid"], found["name"]
            limit = max(1, min(int(payload.get("limit") or 30), 30))
            songs = api.playlist_page(gcid, 1, limit)
            if not songs:
                raise RuntimeError("歌单里没有取到歌曲：" + name)
            playback.play(songs, 0)
            return {"playlist": name, "song": songs[0], "status": playback.status()}
        raise KeyError("未知动作：" + action)

    def _ensure(self):
        """无参数；按需创建酷狗 API 与远控播放器。"""
        if self.api is None or self.playback is None:
            from plugins.music.kugou.client.kugouApi import kugouApi
            from plugins.music.kugou.client.RemoteMusicPlayback import RemoteMusicPlayback
            path = self.root / "plugins" / "music" / "kugou" / "config" / "kugou.json"
            config = json.loads(path.read_text("utf-8-sig")) if path.is_file() else {}
            config.update(self.overrides)
            api = kugouApi(self.root, config)
            playback_path = self.root / "config" / "musicPlayback.json"
            playback_config = (json.loads(playback_path.read_text("utf-8-sig"))
                               if playback_path.is_file() else {})
            self.api = api
            self.playback = RemoteMusicPlayback(self.root, api, playback_config)
        return self.api, self.playback
