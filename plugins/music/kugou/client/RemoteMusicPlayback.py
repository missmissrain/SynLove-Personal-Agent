"""远控音乐播放器：服务器保留酷狗解析与逐首队列，通过终端管理API调用目标接收器。

注册参数root为主仓库，api为酷狗客户端，config来自私有config/musicPlayback.json：
mode=remote、target为登记设备ID，volume默认35；桥接配置指定独立终端组件。
远程失败明确返回失败，绝不回退到服务器扬声器；不传输酷狗账号令牌。
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import urllib.request
import importlib.util
import sys
import threading
import time
import uuid

from plugins.music.kugou.client.MusicQueue import MusicQueue


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
        if self.client is None:
            repo = (self.root / cfg["repositoryRoot"]).resolve()
            # terminal-pc 在 sys.path 上，TerminalApiClient 内部的 terminalConnection.* 才能导入。
            if str(repo) not in sys.path:
                sys.path.insert(0, str(repo))
            entry = repo / "terminalConnection/client/TerminalApiClient.py"
            spec = importlib.util.spec_from_file_location("synlove_terminal_api", entry)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.client = module.TerminalApiClient(cfg)
        if not self.config.get("target"):
            self.config["target"] = self._pick_terminal()
            if not self.config["target"]:
                raise ValueError("没有可用的播放终端；请先启动本机/大黄蜂终端")

    def _pick_terminal(self):
        """无参数；只在本机/大黄蜂等真实终端里选在线且支持 music.play 的设备，服务器本体不参与播放。"""
        try:
            data = self.client.request_json("GET", "/v1/devices")
        except Exception:
            return None
        for device in (data.get("devices") or []):
            if not isinstance(device, dict):
                continue
            if str(device.get("id")) == "server":
                continue
            if device.get("online") and "music.play" in (device.get("capabilities") or []):
                return str(device.get("id"))
        return None

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
        """无参数；逐首解析为本地音频文件，经 file.stream 传到终端播放，并监测同一播放ID。"""
        with self._lock:
            song = self.current()
            if not song:
                return {"ok": False, "error": "没有当前曲目"}
            resolved = self.api.song_url(song.get("hash"), song.get("album_id"),
                                         song.get("album_audio_id"), "128")
            if not resolved.get("ok"):
                return {**resolved, "song": song}
            url = (resolved.get("urls") or [""])[0]
            if not url:
                return {"ok": False, "error": "没有可下载的音频地址", "song": song}
            ext = str(resolved.get("ext") or "mp3").lower()
            target = self.root / "runtime" / "kugou-downloads" / (
                str(song.get("hash") or uuid.uuid4().hex) + "." + ext)
            target.parent.mkdir(parents=True, exist_ok=True)
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                return {"ok": False, "error": "音频超过8MiB；请用128码率", "song": song}
            target.write_bytes(data)
            song = {**song, "duration": self._probe_duration(target, song)}
            result = self._upload_and_play(target, song)
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
                return {"ok": False, "song": song, "error": "终端播放器在音频播放前退出，请检查音频设备和地址"}
        threading.Thread(target=self.watch_remote, args=(gen, key), daemon=True).start()
        return {**result, "song": song, "format": ext, "target": self.config["target"],
                "accepted": True}

    def _upload_only(self, path):
        """path为服务器音频；按 begin/write/commit 直传到终端 SynLoveMedia，返回终端路径。"""
        self.connect_client()
        target = self.config["target"]
        cfg = json.loads((self.root / "config" / "terminalConnection.json").read_text("utf-8-sig"))
        repo = (self.root / cfg["repositoryRoot"]).resolve()
        if str(repo) not in sys.path:
            sys.path.insert(0, str(repo))
        from fileTransfer.StreamFileClient import StreamFileClient
        server_cfg = json.loads((repo / "config" / "ServerConfig.json").read_text("utf-8-sig"))
        for name in ("runtimeDir", "keyPath", "tlsCaFile"):
            if server_cfg.get(name) and not os.path.isabs(server_cfg[name]):
                server_cfg[name] = str((repo / server_cfg[name]).resolve())
        data = path.read_bytes()
        remote = ("C:\\Users\\Public\\SynLoveMedia\\"
                  + path.stem + "-" + uuid.uuid4().hex[:8] + path.suffix)
        stream = StreamFileClient(server_cfg)
        try:
            begin = stream.execute_file(target, {"action": "begin", "path": remote, "overwrite": True},
                                        timeout=60)
            upload_id = begin.get("uploadId") if isinstance(begin, dict) else None
            if not upload_id:
                self._watch_log("upload begin failed %s" % (begin,))
                return None
            written = stream.execute_file(target, {"action": "write", "uploadId": upload_id, "offset": 0},
                                          data, timeout=120)
            if isinstance(written, dict) and written.get("ok") is False:
                self._watch_log("upload write failed %s" % (written,))
                return None
            committed = stream.execute_file(target, {"action": "commit", "uploadId": upload_id,
                "sha256": hashlib.sha256(data).hexdigest(), "overwrite": True}, timeout=60)
            if isinstance(committed, dict) and committed.get("ok") is False:
                self._watch_log("upload commit failed %s" % (committed,))
                return None
        finally:
            stream.close()
        return remote

    def _probe_duration(self, path, song):
        """path为已下载音频、song为曲目；优先用曲目时长，其次 ffprobe，最后按128kbps估算。"""
        value = int(song.get("duration") or 0)
        if value > 0:
            return value
        candidates = []
        env = os.environ.get("SYNLOVE_FFMPEG") or ""
        if env:
            candidates.append(os.path.join(os.path.dirname(env), "ffprobe.exe"))
        found = shutil.which("ffprobe")
        if found:
            candidates.append(found)
        candidates.append(r"G:\ffmpeg\ffmpeg-master-latest-win64-gpl\bin\ffprobe.exe")
        for probe in candidates:
            if not probe or not os.path.isfile(probe):
                continue
            try:
                done = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration",
                                       "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                                      capture_output=True, text=True, timeout=20)
                seconds = float((done.stdout or "0").strip() or 0)
                if seconds > 0:
                    return int(round(seconds))
            except Exception:
                continue
        try:
            return int(round(path.stat().st_size * 8 / 128000.0))
        except Exception:
            return 0

    def _fetch_song(self, song):
        """song为曲目；取128码率并下载到服务器文件，返回(path, ext)或(None, error)。"""
        resolved = self.api.song_url(song.get("hash"), song.get("album_id"),
                                     song.get("album_audio_id"), "128")
        if not resolved.get("ok"):
            return None, resolved.get("error") or "取音频地址失败"
        url = (resolved.get("urls") or [""])[0]
        if not url:
            return None, "没有可下载的音频地址"
        ext = str(resolved.get("ext") or "mp3").lower()
        target = self.root / "runtime" / "kugou-downloads" / (
            str(song.get("hash") or uuid.uuid4().hex) + "." + ext)
        target.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            return None, "音频超过8MiB；请用128码率"
        target.write_bytes(data)
        return target, ext

    def _upload_and_play(self, path, song):
        """path为服务器音频；直传终端后立即本地播放。"""
        remote = self._upload_only(path)
        if not remote:
            return {"ok": False, "error": "终端流式上传失败"}
        return self.client.execute_command(self.config["target"], {"type": "music", "params": {
            "action": "play_file", "path": remote, "kind": "audio",
            "duration": int(song.get("duration") or 0),
            "volume": int(self.config.get("volume", 35)), "song": song}}, wait_seconds=60)

    def _watch_log(self, message):
        """message为文本；追加到 runtime/logs/music-watch.log，便于排查自动续播。"""
        try:
            path = self.root / "runtime" / "logs" / "music-watch.log"
            path.parent.mkdir(parents=True, exist_ok=True)
            with io.open(str(path), "a", encoding="utf-8") as handle:
                handle.write("%s %s\n" % (time.strftime("%H:%M:%S"), message))
        except Exception:
            pass

    def _enqueue_song(self, song):
        """song为曲目；预取并加入终端本地队列，成功返回True。"""
        if not song:
            return False
        path, ext = self._fetch_song(song)
        if not path:
            self._watch_log("prefetch fetch failed %s" % (song.get("name"),))
            return False
        song = {**song, "duration": self._probe_duration(path, song)}
        remote = self._upload_only(path)
        if not remote:
            self._watch_log("prefetch upload failed %s" % (song.get("name"),))
            return False
        result = self.send_request({"action": "enqueue_file", "path": remote, "kind": "audio",
                                    "duration": int(song.get("duration") or 0),
                                    "volume": int(self.config.get("volume", 35)), "song": song})
        if not result.get("ok"):
            self._watch_log("prefetch enqueue failed %s" % (result.get("error"),))
            return False
        return True

    def _enqueue_current(self):
        """无参数；把当前索引曲目预取并加入终端队列。"""
        return self._enqueue_song(self.current())

    def watch_remote(self, gen, key):
        """gen/key为本轮代次与播放ID；曲尾预取下一首，结束时等待终端续播，失败回退直取。"""
        prefetched_for = None
        self._watch_log("start gen=%s key=%s queue=%s index=%s"
                        % (gen, key, len(self.state.get("queue") or []), self.state.get("index")))
        try:
            while True:
                time.sleep(2)
                with self._lock:
                    if gen != self._gen:
                        self._watch_log("superseded")
                        return
                    try:
                        result = self.send_request({"action": "status"})
                    except Exception as error:
                        self._watch_log("status error %s: %s" % (type(error).__name__, error))
                        return
                    if not result.get("ok"):
                        self._watch_log("status not ok %s" % (result.get("error"),))
                        return
                    songs = self.state.get("queue") or []
                    index = int(self.state.get("index", 0))
                    duration = float(result.get("duration") or 0)
                    position = float(result.get("position") or 0)
                    playback = result.get("playbackId")
                    self._watch_log("tick playing=%s exit=%s pos=%s dur=%s idx=%s/%s"
                                    % (result.get("playing"), result.get("exitCode"), position,
                                       duration, index, len(songs)))
                    if (duration and position >= duration - 10 and index + 1 < len(songs)
                            and prefetched_for != playback):
                        if self._enqueue_song(songs[index + 1]):
                            self.state["index"] = index + 1
                            self._save()
                            prefetched_for = playback
                            index += 1
                            self._watch_log("prefetched %s" % (songs[index].get("name"),))
                    if result.get("playing"):
                        continue
                    if result.get("stopped") or result.get("exitCode") not in (0, None):
                        self._watch_log("stop exit=%s stopped=%s"
                                        % (result.get("exitCode"), result.get("stopped")))
                        return
                    if prefetched_for == playback:
                        # 下一首已入终端队列，等终端自动接手；最多等 8 秒
                        started = False
                        for _ in range(4):
                            time.sleep(2)
                            try:
                                check = self.send_request({"action": "status"})
                            except Exception:
                                break
                            if check.get("playing") or check.get("playbackId") != playback:
                                if check.get("playbackId"):
                                    self.state["playbackId"] = check.get("playbackId")
                                    self._save()
                                prefetched_for = None
                                started = True
                                self._watch_log("terminal took over %s" % (check.get("playbackId"),))
                                break
                        if started:
                            continue
                        self._watch_log("terminal idle, play current directly")
                        self._play_current()
                        return
                    index = int(self.state.get("index", 0)) + 1
                    if index >= len(songs) and self._refill:
                        queue = list(songs)
                        queue.extend(self._refill() or [])
                        self.state["queue"] = queue
                        songs = queue
                    if index >= len(songs):
                        self._watch_log("queue end %s/%s" % (index, len(songs)))
                        return
                    self.state["index"] = index
                    self._save()
                    self._watch_log("advance to %s/%s" % (index, len(songs)))
                    self._play_current()
                    return
        except Exception:
            self._watch_log("crashed " + __import__("traceback").format_exc().replace("\n", " | ")[:800])

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
