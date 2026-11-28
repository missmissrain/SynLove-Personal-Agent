"""远控音乐播放器：服务器保留酷狗解析与逐首队列，通过终端管理API调用目标接收器。

注册参数root为主仓库，api为酷狗客户端，config来自私有config/musicPlayback.json：
mode=remote、target为登记设备ID，volume默认35；桥接配置指定独立终端组件。
远程失败明确返回失败，绝不回退到服务器扬声器；不传输酷狗账号令牌。
"""

import json
import importlib.util
import threading
import time
import uuid

from kugou.client.MusicQueue import MusicQueue


class RemoteMusicPlayback(MusicQueue):
    """复用逐首解析队列，通过目标接收器报告真实播放状态。"""

    def __init__(self, root, api, config, client=None):
        """root为生产目录，api为解析器，config为设备ID及音量；client仅供隔离测试注入。"""
        super().__init__(api, root / "runtime/kugou-remote-player-state.json")
        self._lock = threading.RLock()
        self.root = root
        self.config = dict(config)
        self.client = client

    def connect_client(self):
        """无参数；首次播放控制时加载独立终端桥接，缺少可选组件不影响搜歌和登录工具加载。"""
        cfg = None
        if self.client is None or not self.config.get("target"):
            bridge = self.root / "config" / "terminalConnection.json"
            cfg = json.loads(bridge.read_text(encoding="utf-8-sig"))
        if not self.config.get("target"):
            self.config["target"] = cfg.get("serverDeviceId") or "server"
        if self.client is None:
            entry = (self.root / cfg["repositoryRoot"]).resolve() / "terminalConnection/client/TerminalApiClient.py"
            spec = importlib.util.spec_from_file_location("synlove_terminal_api", entry)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.client = module.TerminalApiClient(cfg)

    def send_request(self, data):
        """data为播放指令；通过终端管理器提交一次，不自动重放写操作。"""
        data = dict(data)
        if data["action"] != "status":
            data.setdefault("requestId", uuid.uuid4().hex)
        try:
            self.connect_client()
            response = self.client.execute_command(self.config["target"],
                {"type": "music", "params": data}, wait_seconds=35)
            if not isinstance(response, dict):
                raise ValueError("目标响应不是对象")
            if not response.get("ok"):
                return response
            return response
        except Exception as exc:
            return {"ok": False, "error": "本机音乐远控失败：" + type(exc).__name__}

    def _play_current(self):
        """无参数；逐首解析地址并启动指定电脑播放器，成功后监测同一播放ID。"""
        with self._lock:
            song = self.current()
            if not song:
                return {"ok": False, "error": "没有当前曲目"}
            resolved = self.api.song_url(song.get("hash"), song.get("album_id"), song.get("album_audio_id"))
            if not resolved.get("ok"):
                return {**resolved, "song": song}
            result = self.send_request({"action": "play", "url": resolved["urls"][0], "song": song,
                                        "volume": int(self.config.get("volume", 35))})
            if not result.get("ok"):
                return {**result, "song": song}
            self._gen += 1
            gen = self._gen
            key = result["playbackId"]
            self.state.update(playbackId=key, pid=0, paused=False)
            self._save()
            deadline = time.monotonic() + 12
            while result.get("playing") and float(result.get("position", 0)) < 0.05:
                if time.monotonic() >= deadline:
                    return {"ok": False, "accepted": True, "song": song,
                            "error": "点播已提交，但尚未确认播放进度；请先查询状态，勿重复点播"}
                time.sleep(0.5)
                result = self.send_request({"action": "status"})
                if not result.get("ok") or result.get("playbackId") != key:
                    return {"ok": False, "accepted": True, "song": song,
                            "error": "点播已提交，但播放端断联或已切换曲目；请先查询状态"}
            if not result.get("playing"):
                return {"ok": False, "song": song, "error": "本机播放器在音频播放前退出，请检查音频设备和地址"}
        threading.Thread(target=self.watch_remote, args=(gen, key), daemon=True).start()
        return {**result, "song": song, "format": resolved.get("ext", ""),
                "target": self.config["target"], "accepted": True}

    def watch_remote(self, gen, key):
        """gen/key为本轮队列代次与目标播放ID；仅自然结束时自动下一首，断联或替换时停止监测。"""
        while True:
            time.sleep(10)
            with self._lock:
                if gen != self._gen:
                    return
                result = self.send_request({"action": "status"})
                if not result.get("ok") or result.get("playbackId") != key:
                    return
                if result.get("playing"):
                    continue
                # 非零退出码或用户停止不应触发自动切歌；只有正常到达曲尾才继续。
                if result.get("exitCode") != 0 or result.get("stopped"):
                    return
                queue = self.state.get("queue") or []
                index = int(self.state.get("index", 0)) + 1
                if index >= len(queue) and self._refill:
                    queue.extend(self._refill() or [])
                    self.state["queue"] = queue
                if index >= len(queue):
                    return
                self.state["index"] = index
                self._play_current()
            return

    def status(self):
        """无参数；以目标接收器状态为准，明确显示目标离线，不用服务器PID推断。"""
        result = self.send_request({"action": "status"})
        return {**result, "target": self.config.get("target"),
                "queue": len(self.state.get("queue") or []), "index": self.state.get("index", 0)}

    def set_paused(self, paused):
        """paused为目标状态；仅控制属于当前队列的播放ID，暂停和继续均为幂等操作。"""
        key = self.state.get("playbackId")
        if not key:
            return {"ok": False, "error": "当前会话没有可控制的音乐"}
        return self.send_request({"action": "pause" if paused else "resume", "expectedPlaybackId": key})

    def pause_or_resume(self):
        """无参数；兼容旧入口，读取目标状态后明确设置暂停状态。"""
        result = self.status()
        return self.set_paused(not result.get("paused")) if result.get("ok") else result

    def stop(self):
        """无参数；使自动连播失效，只停止当前队列拥有的播放ID，返回真实控制结果。"""
        with self._lock:
            self._gen += 1
            key = self.state.get("playbackId")
        if not key:
            return {"ok": False, "error": "当前会话没有可控制的音乐"}
        return self.send_request({"action": "stop", "expectedPlaybackId": key})
