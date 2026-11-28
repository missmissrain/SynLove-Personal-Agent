"""酷狗音乐工具（MCP stdio）：搜索、点播、暂停/切歌、登录。

路由约定：
- 用户说"想听/放一首/点歌/搜一下 XX" → `kugou_play` / `kugou_search`
- 用户说"暂停/继续/下一首/上一首/停止" → `kugou_control`
- 用户问"在放什么/登录了吗" → `kugou_status`
- **不要用 GUI 点击/截图去控制酷狗**；搜索与播放都走本工具。
- 付费歌需要登录一次：`kugou_login` 生成二维码，发图给用户扫。

工具：
    kugou_search(keyword, limit?)
    kugou_play(query, limit?)
    kugou_control(action)
    kugou_status()
    kugou_playlists()
    kugou_login()
"""

import json
import base64
import urllib.request
import uuid
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT))

from plugins.music.kugou.client.kugouApi import kugouApi  # noqa: E402
from plugins.music.kugou.client.RemoteMusicPlayback import RemoteMusicPlayback  # noqa: E402

CONFIG = json.loads((ROOT / "plugins" / "music" / "kugou" / "config" / "kugou.json").read_text(encoding="utf-8-sig"))
API = kugouApi(ROOT, CONFIG)
PLAYBACK_FILE = ROOT / "config/musicPlayback.json"
PLAYBACK = (json.loads(PLAYBACK_FILE.read_text(encoding="utf-8-sig"))
            if PLAYBACK_FILE.is_file() else CONFIG.get("playback", {}))
PLAYER = RemoteMusicPlayback(ROOT, API, PLAYBACK)

TOOLS = [
    {
        "name": "kugou_search",
        "description": "在酷狗音乐里搜索歌曲，返回歌名/歌手/hash 等。只想确认有没有某首歌时用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "description": "歌名或 歌手+歌名"},
                "limit": {"type": "integer", "description": "返回条数，默认 10"},
            },
            "required": ["keyword"],
        },
    },
    {
        "name": "kugou_fetch",
        "description": (
            "在本机请求音乐：搜索并把音频下载到服务器文件，返回可传输的音频路径。"
            "要播放到终端，请把返回的 path 交给 terminal_media_play；不要用 GUI 找酷狗。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "歌名，或 歌手+歌名"},
                "limit": {"type": "integer", "description": "候选数量，默认 1"},
                "quality": {"type": "string", "enum": ["128", "320", "flac"],
                            "description": "码率，默认128（小文件便于传输）；无损用flac"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "kugou_control",
        "description": "控制当前点播：play 继续、pause 暂停、next 下一首、prev 上一首、stop 停止。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["play", "pause", "next", "prev", "stop"]},
            },
            "required": ["action"],
        },
    },
    {
        "name": "kugou_status",
        "description": "查看酷狗服务、登录状态与当前在放的歌。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "kugou_playlists",
        "description": "查看登录账号的歌单（需要先登录）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "kugou_playlist_tracks",
        "description": "查看某个歌单里有哪些歌（按名字或 collection id）。只读，不播放。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "playlist": {"type": "string", "description": "歌单名字（如“战歌”）或 collection id"},
                "limit": {"type": "integer", "description": "最多列几首，默认 20"},
            },
            "required": ["playlist"],
        },
    },
    {
        "name": "kugou_play_playlist",
        "description": (
            "把歌单前 limit 首加入服务器轮询队列：服务端逐首下载音频、经 file.stream 直传到目标终端并自动续播。"
            "调用一次即可，不要自己循环点歌。用户说“放我的XX歌单/歌单里的歌”时用。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "playlist": {"type": "string", "description": "歌单名字（如“战歌”）或 collection id"},
                "limit": {"type": "integer", "description": "最多播多少首，默认 50"},
            },
            "required": ["playlist"],
        },
    },
    {
        "name": "kugou_login",
        "description": (
            "生成酷狗登录二维码（用户用酷狗 App 扫码一次，之后就能取 VIP 歌曲地址）。"
            "生成后把二维码图片发给用户。"
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def text(value):
    """统一返回文本块。"""
    return [{"type": "text", "text": value}]


def do_search(arguments):
    """搜索。"""
    keyword = str(arguments.get("keyword") or "").strip()
    if not keyword:
        raise ValueError("keyword 不能为空")
    songs = API.search(keyword, arguments.get("limit"))
    if not songs:
        return "没搜到。"
    lines = [f"搜到 {len(songs)} 首："]
    for index, song in enumerate(songs[:10], 1):
        lines.append(f"{index}. {song['name']} - {song['artist']}")
    return "\n".join(lines)


def do_fetch(arguments):
    """搜索并下载音频到服务器文件，返回 path；只用于传给终端播放。"""
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("query 不能为空")
    songs = API.search(query, arguments.get("limit") or 1)
    if not songs:
        return json.dumps({"ok": False, "error": "没搜到这首歌"}, ensure_ascii=False)
    song = songs[0]
    resolved = API.song_url(song.get("hash"), song.get("album_id"), song.get("album_audio_id"),
                            arguments.get("quality") or "128")
    if not resolved.get("ok"):
        return json.dumps({"ok": False, "error": resolved.get("error") or "取音频地址失败"}, ensure_ascii=False)
    url = (resolved.get("urls") or [""])[0]
    if not url:
        return json.dumps({"ok": False, "error": "没有可下载的音频地址"}, ensure_ascii=False)
    ext = str(resolved.get("ext") or "mp3").lower()
    out_dir = ROOT / "runtime" / "kugou-downloads"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / (str(song.get("hash") or uuid.uuid4().hex) + "." + ext)
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024:
        return json.dumps({"ok": False, "error": "音频超过50MiB"}, ensure_ascii=False)
    target.write_bytes(data)
    return json.dumps({"ok": True, "song": song, "path": str(target), "format": ext,
                       "bytes": len(data)}, ensure_ascii=False)


def do_play(arguments):
    """点歌并播放。"""
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("query 不能为空")
    songs = API.search(query, arguments.get("limit"))
    if not songs:
        return "没搜到这首歌。"
    result = PLAYER.play(songs, 0)
    song = result.get("song") or songs[0]
    if result.get("ok"):
        return f"正在播放：{song['name']} - {song['artist']}（{_quality_label(result.get('format'))}）"
    if result.get("needs_auth"):
        return (f"找到《{song['name']}》 - {song['artist']}，但这是付费/VIP 歌，需要先登录一次。"
                "让我生成二维码，你用酷狗 App 扫一下就行。")
    return f"播放失败：{result.get('error')}"


def do_control(arguments):
    """播放控制。"""
    action = str(arguments.get("action") or "").strip()
    if action == "pause":
        status = PLAYER.status()
        if not status.get("ok", True):
            return status.get("error", "播放器未连接")
        if status.get("paused"):
            return "已经暂停。"
        result = PLAYER.set_paused(True) if hasattr(PLAYER, "set_paused") else PLAYER.pause_or_resume()
        if not result.get("ok"):
            return result.get("error", "当前没有在播放")
        return "已暂停。" if result.get("paused") else "已继续。"
    if action == "next":
        result = PLAYER.next()
    elif action == "prev":
        result = PLAYER.prev()
    elif action == "stop":
        result = PLAYER.stop()
        return "已停止。" if result.get("ok") else result.get("error", "停止失败")
    elif action == "play":
        status = PLAYER.status()
        if not status.get("ok", True):
            return status.get("error", "播放器未连接")
        if status.get("paused"):
            result = PLAYER.set_paused(False) if hasattr(PLAYER, "set_paused") else PLAYER.pause_or_resume()
            return "已继续。" if result.get("ok") else result.get("error", "继续失败")
        if status.get("playing"):
            return "已经在播放。"
        return do_play({"query": (status.get("song") or {}).get("name") or ""}) if status.get("song") else "队列是空的。"
    else:
        raise ValueError(f"未知操作：{action}")
    song = result.get("song") or {}
    if result.get("ok"):
        return f"正在播放：{song.get('name')} - {song.get('artist')}（{_quality_label(result.get('format'))}）"
    return str(result.get("error"))


def _quality_label(fmt):
    """把返回的扩展名翻译成音质说明。"""
    value = str(fmt or "").lower()
    if value in ("flac", "ape", "wav"):
        return "无损"
    if value == "mp3":
        return "mp3"
    return value or "未知音质"


def do_status():
    """状态。"""
    hw = API.status()
    pb = PLAYER.status()
    lines = [
        f"API: {'在线' if hw['server'] else '未启动'}",
        f"登录: {'已登录' if hw['auth'] else '未登录'}",
    ]
    if not pb.get("ok", True):
        lines.append("播放端：" + pb.get("error", "未连接"))
    if pb.get("song"):
        state = "暂停" if pb.get("paused") else ("播放中" if pb.get("playing") else "已停止")
        lines.append(f"当前: {pb['song'].get('name')} - {pb['song'].get('artist')}（{state}）")
    else:
        lines.append("当前: 没有在放歌")
    return "\n".join(lines)


def do_playlists():
    """歌单。"""
    if not API.status().get("auth"):
        return "还没登录，先扫码登录一次。"
    items = API.user_playlists()
    if not items:
        return "没拿到歌单。"
    return "\n".join(f"- {item['name']}" for item in items[:30])


def _resolve_playlist(name_or_id):
    """按名字/id 找歌单；找不到时给出候选。"""
    target = str(name_or_id or "").strip()
    found = API.find_playlist(target)
    if found is not None:
        return found, ""
    names = [item["name"] for item in API.user_playlists()]
    return None, "没找到这个歌单。现有：" + "、".join(names[:15])


def do_playlist_tracks(arguments):
    """列出歌单曲目。"""
    playlist = str(arguments.get("playlist") or "").strip()
    if not playlist:
        raise ValueError("playlist 不能为空")
    found, error = _resolve_playlist(playlist)
    if found is None:
        return error
    limit = max(1, int(arguments.get("limit") or 20))
    tracks = API.playlist_page(found["gcid"], 1, min(limit, 30))
    if not tracks:
        return f"《{found['name']}》里没取到歌。"
    lines = [f"《{found['name']}》共取到 {len(tracks)} 首（最多 {limit}）："]
    for index, song in enumerate(tracks, 1):
        lines.append(f"{index}. {song['name']} - {song['artist']}")
    return "\n".join(lines)


def do_play_playlist(arguments):
    """把歌单前 limit 首交给长驻音乐服务轮询播放；不在 MCP 进程里自己循环。"""
    playlist = str(arguments.get("playlist") or "").strip()
    if not playlist:
        raise ValueError("playlist 不能为空")
    limit = max(1, int(arguments.get("limit") or 30))
    body = json.dumps({"name": playlist, "limit": limit}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request("http://127.0.0.1:8830/v1/plugins/music/play_playlist",
                                     data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            value = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        return "歌单播放服务不可用：" + type(error).__name__
    if not value.get("ok"):
        return "歌单播放失败：" + str(value.get("error"))[:120]
    payload = value.get("value") or {}
    song = payload.get("song") or {}
    return ("已把《%s》前 %d 首加入轮询；开始播放：%s - %s，播完由服务自动下一首。"
            % (payload.get("playlist") or playlist, limit, song.get("name"), song.get("artist")))


def do_login():
    """生成登录二维码（后台跑登录助手，等二维码文件出现）。"""
    qr = ROOT / "runtime" / "kugou-login-qr.png"
    try:
        qr.unlink()
    except OSError:
        pass
    subprocess.Popen(
        [sys.executable, str(ROOT / "plugins" / "music" / "kugou" / "tools" / "kugouLogin.py"), "--qr"],
        cwd=str(ROOT), creationflags=0x08000000,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**__import__("os").environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
    )
    for _ in range(20):
        time.sleep(0.5)
        if qr.is_file() and qr.stat().st_size > 0:
            return f"二维码已生成：{qr}\n把这个图片发给用户，用酷狗 App 扫码并确认。"
    return "二维码生成超时，稍后再试一次。"


def handle(message):
    """JSON-RPC 分发。"""
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
            "serverInfo": {"name": "kugou-music", "version": "1.0.0"}}}
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            if name == "kugou_search":
                result = do_search(args)
            elif name == "kugou_fetch":
                result = do_fetch(args)
            elif name == "kugou_control":
                result = do_control(args)
            elif name == "kugou_status":
                result = do_status()
            elif name == "kugou_playlists":
                result = do_playlists()
            elif name == "kugou_playlist_tracks":
                result = do_playlist_tracks(args)
            elif name == "kugou_play_playlist":
                result = do_play_playlist(args)
            elif name == "kugou_login":
                result = do_login()
            else:
                raise ValueError(f"未知工具：{name}")
            return {"jsonrpc": "2.0", "id": request_id, "result": {"content": text(result)}}
        except Exception as error:  # noqa: BLE001
            return {"jsonrpc": "2.0", "id": request_id, "result": {
                "content": text(f"酷狗操作失败：{type(error).__name__}: {error}"), "isError": True}}
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"unsupported: {method}"}}


def main():
    """stdio 循环。"""
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle(message)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
