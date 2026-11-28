"""单实例运行锁：同一时刻只允许一轮技能复盘在跑（计划任务 + 兜底巡检会撞车）。

职责：
- `acquire()`：抢锁，成功返回 True；已有活进程持锁则返回 False；
- `release()`：放锁（只删自己写的那份，别人的不动）；
- `alive()`：只读判断"现在有没有一轮在跑"（给巡检和运维看）。

为什么需要：
计划任务是每天 03:00，兜底巡检是每 60 秒看一次；某个凌晨 03:00 那轮卡住了，
巡检补跑就会和它并排跑，两边同时写技能目录、同时推进水位，产出会互相覆盖。
锁要能**自己认死锁**：持锁进程没了、或者 pid 被系统回收给了别的进程、
或者锁文件太老（超过 stale_seconds），都视为可用，不然一次崩溃能永久锁死。

注册参数（构造）：
    path           锁文件路径（默认由调用方传入，一般是 runtime/skill-review.lock）
    stale_seconds  超过多久视为陈旧锁，默认 6 小时（一轮复盘正常几分钟）
"""

import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
# 判活容差：锁里记的进程启动时刻与实测值差超过这个秒数，就认为 pid 被回收过
START_TIME_TOLERANCE = 5.0


class runLock:
    """基于锁文件的最小单实例锁（pid + 进程启动时刻 + 时间戳）。"""

    def __init__(self, path, stale_seconds=6 * 3600):
        """path：锁文件；stale_seconds：超过多久算陈旧锁。"""
        self.path = Path(path)
        self.stale_seconds = max(60, int(stale_seconds))

    def acquire(self):
        """抢锁。返回 True 表示拿到了（调用方负责最后 release）。"""
        payload = {
            "pid": os.getpid(),
            "process_started_at": process_start_time(os.getpid()) or 0.0,
            "acquired_at": time.time(),
            "acquired_text": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if self._write_exclusive(payload):
            return True
        holder = self._read()
        if holder and self._holder_alive(holder):
            return False
        # 陈旧锁（进程没了 / pid 被回收 / 太老）：清掉再抢一次
        try:
            self.path.unlink()
        except OSError:
            return False
        return self._write_exclusive(payload)

    def release(self):
        """放锁（只删自己那份；pid 不匹配就不动，避免误删别人的锁）。"""
        holder = self._read()
        if not holder:
            return
        if int(holder.get("pid") or 0) != os.getpid():
            return
        try:
            self.path.unlink()
        except OSError:
            pass

    def alive(self):
        """只读判断：是否有活进程持锁。"""
        holder = self._read()
        return bool(holder) and self._holder_alive(holder)

    def holder(self):
        """返回持锁信息（给日志/运维看），没有则 {}。"""
        return self._read() or {}

    def _write_exclusive(self, payload):
        """用 O_CREAT|O_EXCL 原子创建锁文件（并发时只有一个能成功）。"""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        except OSError:
            return False
        try:
            os.write(handle, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        finally:
            os.close(handle)
        return True

    def _read(self):
        """读锁文件；坏文件返回 None（当作没锁，宁可多跑一轮也不永久卡死）。"""
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError:
            return None
        try:
            data = json.loads(raw or "{}")
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    def _holder_alive(self, holder):
        """持锁进程是否还活着（三重判据：进程真在跑 / 启动时刻对得上 / 锁没老过头）。"""
        pid = int(holder.get("pid") or 0)
        if pid <= 0:
            return False
        acquired = float(holder.get("acquired_at") or 0)
        if acquired and time.time() - acquired > self.stale_seconds:
            return False
        if not process_alive(pid):
            return False        # 进程没了（或已退出但句柄还没关）
        started = process_start_time(pid)
        recorded = float(holder.get("process_started_at") or 0)
        if started is not None and recorded and abs(started - recorded) > START_TIME_TOLERANCE:
            return False        # pid 被系统回收给了别的进程
        return True


def process_alive(pid):
    """进程是否**真的**在跑：已退出但句柄没关的僵尸进程要判成死。

    参数 pid：进程号。只靠 OpenProcess 成功不够——Windows 上父进程还留着句柄时，
    已结束的进程对象仍能被打开，会让我们以为锁还活着（测试里就踩到了）。
    """
    if os.name != "nt":
        return False
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    except Exception:  # noqa: BLE001 —— 查不到就按"不在"处理，宁可回收锁
        return False
    finally:
        kernel32.CloseHandle(handle)


def process_start_time(pid):
    """取进程启动的 epoch 秒（拿不到返回 None）。

    参数 pid：进程号。用 OpenProcess + GetProcessTimes，比 tasklist 快得多，
    也不需要额外装 psutil。
    """
    if os.name != "nt":
        return None
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return None
    try:
        created = wintypes.FILETIME()
        exited = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        ok = kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(kernel), ctypes.byref(user))
        if not ok:
            return None
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        return ticks / 10_000_000 - 11644473600     # 1601-01-01 → 1970-01-01
    except Exception:  # noqa: BLE001 —— 判活失败就当拿不到，交给上层降级
        print(f"[runLock] 读进程启动时刻失败 pid={pid}", file=sys.stderr, flush=True)
        return None
    finally:
        kernel32.CloseHandle(handle)
