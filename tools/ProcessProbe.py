"""进程只读探活，避免 Windows 上以 os.kill(pid, 0) 意外终止进程。

注册参数：无；process_alive 的 pid 为正整数进程号，查询失败保守判为存活。
"""
import ctypes
import errno
import os
from ctypes import wintypes


class ProcessProbe:
    """提供不发送信号的跨平台进程查询。"""

    @staticmethod
    def process_alive(pid):
        """pid 为进程号；返回是否存活，拒绝零和负数，不改变目标进程。"""
        try:
            pid = int(pid)
        except (ValueError, TypeError):
            return False
        if pid <= 0:
            return False
        if os.name != "nt":
            try:
                os.kill(pid, 0)
                return True
            except OSError as error:
                return error.errno == errno.EPERM
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
