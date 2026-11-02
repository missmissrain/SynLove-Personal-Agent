"""控制台窗口与子进程扫描器（诊断用）。

功能：按固定间隔轮询系统进程表与顶层窗口，记录两类证据：
  1. 新出现的进程（pid / 父 pid / 可执行文件路径 / 存活区间）；
  2. 真实可见的控制台窗口（窗口类名 / 所属 pid / 标题 / 可见区间）。
用途：定位"启动时闪黑框"到底由哪个进程创建，而不是靠猜代码。

注册参数（命令行）：
    --seconds   扫描时长，默认 45 秒
    --interval  采样间隔毫秒，默认 60
    --out       输出 JSON 路径，默认 runtime/console-window-scan.json
    --roots     只关心这些根进程名（逗号分隔），默认 electron.exe,node.exe,python.exe,pythonw.exe

只读操作：只枚举进程与窗口，不结束、不修改任何进程。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import time
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
CONSOLE_CLASSES = {
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "PseudoConsoleWindow",
}


class PROCESSENTRY32W(ctypes.Structure):
    """Win32 进程快照条目；字段顺序必须与 Windows 头文件一致。"""

    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)

kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

user32.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]


def snapshot_processes() -> dict[int, dict]:
    """无参数；返回当前进程表 {pid: {ppid, name}}，失败时返回空表。"""
    result: dict[int, dict] = {}
    handle = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if handle == wintypes.HANDLE(-1).value:
        return result
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(handle, ctypes.byref(entry))
        while ok:
            result[int(entry.th32ProcessID)] = {
                "ppid": int(entry.th32ParentProcessID),
                "name": entry.szExeFile,
            }
            ok = kernel32.Process32NextW(handle, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(handle)
    return result


def process_path(pid: int) -> str:
    """参数 pid：进程号；返回可执行文件完整路径，取不到时返回空串。"""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        kernel32.CloseHandle(handle)


def visible_console_windows() -> dict[int, dict]:
    """无参数；返回当前所有可见控制台窗口 {pid: {class, title}}。"""
    found: dict[int, dict] = {}
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def on_window(hwnd, _lparam):
        """参数 hwnd：窗口句柄；只收集可见的控制台类窗口。"""
        if not user32.IsWindowVisible(hwnd):
            return True
        class_buffer = ctypes.create_unicode_buffer(256)
        if not user32.GetClassNameW(hwnd, class_buffer, 256):
            return True
        if class_buffer.value not in CONSOLE_CLASSES:
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        found[int(pid.value)] = {"class": class_buffer.value, "title": title.value}
        return True

    user32.EnumWindows(callback_type(on_window), 0)
    return found


def ancestor_chain(pid: int, table: dict[int, dict], depth: int = 8) -> list[str]:
    """参数 pid/table/depth：起点进程号、进程表与回溯层数；返回 "name(pid)" 形式的父链。"""
    chain: list[str] = []
    current = pid
    for _ in range(depth):
        item = table.get(current)
        if item is None:
            break
        chain.append("%s(%d)" % (item["name"], current))
        current = item["ppid"]
        if current in (0, 4):
            break
    return chain


def synlove_lineage(pid: int, table: dict[int, dict], depth: int = 8) -> list[str]:
    """参数 pid/table/depth：起点进程号与进程表；返回命中本项目的祖先可执行文件路径列表。"""
    hits: list[str] = []
    current = pid
    for _ in range(depth):
        item = table.get(current)
        if item is None:
            break
        path = process_path(current)
        if path and "SynLove-Personal-Agent" in path:
            hits.append("%s(%d)" % (item["name"], current))
        current = item["ppid"]
        if current in (0, 4):
            break
    return hits


def main() -> int:
    """入口：按间隔轮询，输出新建进程与可见控制台窗口的时间线。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=45.0)
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--out", default=str(ROOT / "runtime" / "console-window-scan.json"))
    args = parser.parse_args()

    baseline = snapshot_processes()
    seen = set(baseline)
    created: dict[int, dict] = {}
    windows: dict[int, dict] = {}
    first_seen: dict[int, float] = {}
    last_seen: dict[int, float] = {}
    timeline: list[dict] = []
    started = time.monotonic()
    deadline = started + max(1.0, args.seconds)
    print("[scan] 已进入基线：%d 个进程；开始监听 %.0f 秒" % (len(baseline), args.seconds), flush=True)

    while time.monotonic() < deadline:
        now = time.monotonic()
        table = snapshot_processes()
        for pid, item in table.items():
            if pid not in seen:
                seen.add(pid)
                created[pid] = {**item, "path": process_path(pid),
                                "first": round(now - started, 3)}
                first_seen[pid] = now
                timeline.append({
                    "t": round(now - started, 3), "event": "process", "pid": pid,
                    "name": item["name"], "ppid": item["ppid"],
                    "chain": ancestor_chain(pid, table),
                    "synlove": synlove_lineage(pid, table),
                    "path": created[pid]["path"],
                })
        for pid in list(created):
            if pid in table:
                last_seen[pid] = now
        for pid, item in visible_console_windows().items():
            if pid not in windows:
                windows[pid] = {**item, "first": round(now - started, 3),
                                "chain": ancestor_chain(pid, table),
                                "synlove": synlove_lineage(pid, table)}
                timeline.append({"t": round(now - started, 3), "event": "console-window",
                                 "pid": pid, "class": item["class"], "title": item["title"],
                                 "chain": ancestor_chain(pid, table),
                                 "synlove": synlove_lineage(pid, table)})
            windows[pid]["last"] = round(now - started, 3)
        time.sleep(max(0.01, args.interval / 1000.0))

    table = snapshot_processes()
    report = {
        "seconds": args.seconds,
        "created": [
            {**item, "pid": pid,
             "alive_seconds": round((last_seen.get(pid, item["first"]) - first_seen.get(pid, 0)), 3),
             "still_alive": pid in table}
            for pid, item in created.items()
        ],
        "visible_console_windows": [{"pid": pid, **item} for pid, item in windows.items()],
        "timeline": timeline,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[scan] 新建进程 %d 个，可见控制台窗口 %d 个" % (len(created), len(windows)), flush=True)
    for pid, item in windows.items():
        print("  [可见控制台] pid=%d title=%r 本项目=%s chain=%s" % (
            pid, item.get("title", ""), bool(item.get("synlove")),
            " <- ".join(item.get("chain") or [])), flush=True)
    print("[scan] 明细: %s" % out, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
