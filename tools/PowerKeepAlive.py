"""运行期电源请求：阻止自动空闲睡眠，允许屏幕熄灭；不覆盖手动睡眠和低电量保护。

注册参数：无。仅 Windows 有效；必须在同一守护线程中获取和释放请求。
默认调用 ES_CONTINUOUS | ES_SYSTEM_REQUIRED，停止后台后释放，避免永久占用。
"""
import ctypes
import os


class PowerKeepAlive:
    """拥有一个线程级 Windows 电源请求，不创建额外常驻进程。"""

    def __init__(self):
        """无参数；构造不改变电源策略。"""
        self.active = False

    def set_active(self, active):
        """active 表示后台是否工作；变更时申请或释放阻止自动睡眠的请求。"""
        if os.name != "nt" or bool(active) == self.active:
            return self.active
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        call = kernel.SetThreadExecutionState
        call.argtypes = [ctypes.c_uint32]
        call.restype = ctypes.c_uint32
        value = 0x80000001 if active else 0x80000000
        if not call(value):
            raise ctypes.WinError(ctypes.get_last_error())
        self.active = bool(active)
        return self.active
