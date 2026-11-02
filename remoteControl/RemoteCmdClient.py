"""远程 CMD 执行器：通过现有 FRP TCP 隧道连接目标电脑 Windows OpenSSH。

注册参数 config 为 RemoteTargetConfig，client_factory 为测试替身；生产默认 Paramiko。
命令默认超时 30 秒，最大 120 秒；stdout/stderr 合计最多保留 32 KiB，继续排空避免死锁。
不安装 FRP、不启动 HTTP 服务、不重试命令；超时断开 SSH 不保证远端进程已终止。
"""

import time
import socket

import paramiko

from remoteControl.PinnedHostPolicy import PinnedHostPolicy


class RemoteCmdClient:
    """在受配置约束的目标电脑执行一次 CMD 命令，返回真实退出码和有界输出。"""

    def __init__(self, config, client_factory=None):
        """config 为目标配置实例；client_factory 仅用于隔离测试注入 SSH 客户端。"""
        self.config = config
        self.client_factory = client_factory or paramiko.SSHClient

    def execute_command(self, target, command, timeout_sec=30):
        """target 为电脑别名，command 为 CMD 命令，timeout_sec 为 1~120 秒命令期限。"""
        if not isinstance(command, str) or not command.strip() or "\0" in command or len(command) > 16000:
            raise ValueError("command 必须为非空 CMD 文本，最多 16000 字符且不含空字符")
        if type(timeout_sec) is not int or not 1 <= timeout_sec <= 120:
            raise ValueError("timeoutSec 必须为 1 至 120 秒整数")
        cfg = self.config.resolve_target(target)
        client = self.client_factory()
        channel = None
        try:
            if cfg["known"]:
                client.load_host_keys(cfg["known"])
            client.set_missing_host_key_policy(
                PinnedHostPolicy(cfg["fingerprint"]) if cfg["fingerprint"] else paramiko.RejectPolicy())
            # 指纹模式独立校验；known_hosts 已命中时 Paramiko 自身验证对应公钥。
            client.connect(hostname=cfg["host"], port=cfg["port"], username=cfg["user"],
                           password=cfg["password"] or None, key_filename=cfg["key"] or None,
                           passphrase=cfg["passphrase"], timeout=cfg["timeout"],
                           auth_timeout=cfg["timeout"], banner_timeout=cfg["timeout"],
                           allow_agent=False, look_for_keys=False)
            transport = client.get_transport()
            if transport is None or not transport.is_active():
                raise paramiko.SSHException("SSH 连接未就绪")
            # 同时指定两个校验来源时，指纹也必须通过，不能被 known_hosts 跳过。
            if cfg["fingerprint"]:
                PinnedHostPolicy(cfg["fingerprint"]).missing_host_key(
                    client, cfg["host"], transport.get_remote_server_key())
            deadline = time.monotonic() + timeout_sec
            channel = transport.open_session(timeout=timeout_sec)
            channel.settimeout(max(0.01, deadline - time.monotonic()))
            channel.exec_command('cmd.exe /d /s /c "' + command + '"')
            # 无交互任务：关闭输入，避免等待 stdin；不申请 PTY。
            channel.shutdown_write()
            result = self.collect_output(channel, deadline, cfg["encoding"])
            result["target"] = target
            return result
        except socket.timeout:
            return {"target": target, "ok": False, "exitCode": None, "timedOut": True,
                    "remoteMayStillRun": channel is not None, "stdout": "", "stderr": "",
                    "error": "SSH 操作超时；若命令已提交，远端可能仍在运行，不要自动重做"}
        finally:
            if channel is not None:
                channel.close()
            client.close()

    def collect_output(self, channel, deadline, encoding):
        """channel 为 SSH 通道，deadline 为单调时钟期限，encoding 为输出编码；并行排空两路。"""
        out, err = bytearray(), bytearray()
        total = 0
        limit = 32768
        while True:
            if time.monotonic() >= deadline:
                return {"ok": False, "exitCode": None, "timedOut": True,
                        "remoteMayStillRun": True, "truncated": total > limit,
                        "stdout": self.decode_output(out, encoding),
                        "stderr": self.decode_output(err, encoding),
                        "error": "命令超时，SSH 已断开；远端任务可能仍在运行，不要自动重做"}
            drained = False
            # 每轮限量读取，持续输出也不能饿死期限检查或另一条输出流。
            for ready, receive, dest in ((channel.recv_ready, channel.recv, out),
                                         (channel.recv_stderr_ready, channel.recv_stderr, err)):
                for _ in range(8):
                    if not ready():
                        break
                    chunk = receive(4096)
                    if not chunk:
                        break
                    drained = True
                    remaining = max(0, limit - len(out) - len(err))
                    dest.extend(chunk[:remaining])
                    total += len(chunk)
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                code = channel.recv_exit_status()
                return {"ok": code == 0, "exitCode": code, "timedOut": False,
                        "remoteMayStillRun": code == -1, "truncated": total > limit,
                        "stdout": self.decode_output(out, encoding),
                        "stderr": self.decode_output(err, encoding)}
            if not drained:
                time.sleep(0.01)

    def decode_output(self, data, encoding):
        """data 为有界字节输出，encoding 为 auto/utf-8/gb18030；自动兼容 Windows 中文。"""
        if encoding != "auto":
            return bytes(data).decode(encoding, errors="replace")
        try:
            return bytes(data).decode("utf-8")
        except UnicodeDecodeError as error:
            if error.reason == "unexpected end of data":
                return bytes(data).decode("utf-8", errors="replace")
            return bytes(data).decode("gb18030", errors="replace")
