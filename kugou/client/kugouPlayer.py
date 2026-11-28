"""酷狗播放控制：媒体键 + 客户端唤起 + 当前曲目读取。

职责：
- `next / prev / pause / resume`：向系统注入全局媒体键（不点界面、不截图）；
- `open_song`：用 `kugou://` 深度链接让客户端打开并播放指定歌曲，失败回退网页版；
- `now_playing`：读酷狗主窗口标题，解析当前歌曲/歌手；
- 客户端没启动时可按需唤起（KuGou.exe）。

注册参数（构造）：app_path（酷狗主程序，默认 E:\\kugou\\KGMusic\\KuGou.exe）
"""

import ctypes
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import urllib.parse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

VK = {"prev": 0xB1, "next": 0xB0, "stop": 0xB2, "pause": 0xB3, "play": 0xB3}


class kugouPlayer:
    """媒体键 + 深链播放控制。"""

    def __init__(self, app_path=r"E:\kugou\KGMusic\KuGou.exe"):
        """app_path：酷狗主程序路径（用于唤起）。"""
        self.app_path = Path(app_path)

    def press(self, action):
        """发送一次全局媒体键（next/prev/pause/play/stop）。"""
        vk = VK.get(str(action or "").lower())
        if vk is None:
            raise ValueError(f"未知操作：{action}")
        user32 = ctypes.windll.user32
        user32.keybd_event(vk, 0, 1, 0)  # 按下
        user32.keybd_event(vk, 0, 3, 0)  # 抬起
        time.sleep(0.2)
        return True

    def ensure_app(self):
        """酷狗没运行就启动；返回是否在运行。"""
        if self._window() is not None:
            return True
        if self.app_path.is_file():
            subprocess.Popen([str(self.app_path)], creationflags=0x08000000)
            for _ in range(20):
                time.sleep(0.5)
                if self._window() is not None:
                    return True
        return self._window() is not None

    def open_song(self, song):
        """让酷狗打开指定歌曲；返回 {ok, method, detail}。"""
        song_hash = str(song.get("hash") or "")
        album_id = int(song.get("album_id") or 0)
        audio_id = int(song.get("album_audio_id") or 0)
        if not song_hash:
            return {"ok": False, "method": "", "detail": "缺少 hash"}
        deep = (f"kugou://play?hash={song_hash}&album_id={album_id}"
                f"&album_audio_id={audio_id}")
        try:
            os.startfile(deep)  # noqa: S606 - 调起已注册的 kugou:// 协议
            return {"ok": True, "method": "kugou://", "detail": deep}
        except OSError:
            pass
        web = f"https://www.kugou.com/song/#hash={song_hash}&album_id={album_id}"
        try:
            os.startfile(web)  # noqa: S606 - 回退网页版
            return {"ok": True, "method": "web", "detail": web}
        except OSError as error:
            return {"ok": False, "method": "", "detail": str(error)}

    def now_playing(self):
        """读酷狗窗口标题；没运行返回 None。"""
        title = self._window()
        if not title:
            return None
        match = re.match(r"(.+?)\s+-\s+(.+)$", title)
        if match:
            return {"raw": title, "name": match.group(1).strip(), "artist": match.group(2).strip()}
        return {"raw": title, "name": title, "artist": ""}

    def _window(self):
        """找酷狗主窗口标题。"""
        try:
            output = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq KuGou.exe", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=15,
            ).stdout
            if "KuGou.exe" not in output:
                return None
            script = (
                "Get-Process KuGou -ErrorAction SilentlyContinue | "
                "Where-Object { $_.MainWindowTitle } | "
                "Select-Object -First 1 -ExpandProperty MainWindowTitle"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script],
                capture_output=True, text=True, timeout=15,
                encoding="utf-8", errors="replace",
            )
            return (result.stdout or "").strip() or None
        except (OSError, subprocess.SubprocessError):
            return None
