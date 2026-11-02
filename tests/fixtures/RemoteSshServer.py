"""隔离 SSH 测试端：只监听本机随机端口，模拟 Windows OpenSSH 的命令响应。

注册参数 handler 为命令处理函数；不调用本机或真实远端 shell，不使用正式凭据。
默认每个测试只接受一个连接，生命周期由上下文管理器回收。
"""

import socket
import threading

import paramiko


class RemoteSshServer(paramiko.ServerInterface):
    """供 Paramiko 客户端进行真实握手、认证、CMD 请求和输出读取验证。"""

    def __init__(self, handler):
        """handler(channel, command) 只生成假响应；初始化本地监听和随机测试公钥。"""
        self.handler = handler
        self.key = paramiko.RSAKey.generate(2048)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(3)
        self.port = self.listener.getsockname()[1]
        self.transport = None
        self.command = None
        self.requested = threading.Event()
        self.finished = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self.serve_connection, daemon=True)

    def check_auth_password(self, username, password):
        """username/password 为测试账号；仅匹配固定假凭据才通过认证。"""
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("tester", "fake-secret") else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        """username 为测试登录名；仅声明密码认证，防止客户端尝试其他凭据来源。"""
        return "password"

    def check_channel_request(self, kind, chanid):
        """kind 为通道类型、chanid 为编号；只接受测试用 session 通道。"""
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        """channel 为测试通道、command 为原始请求；记录但从不交给真实 shell。"""
        self.command = command.decode("utf-8")
        self.requested.set()
        return True

    def serve_connection(self):
        """无参数；处理一个本机连接，在期限内等待 exec，随后交给假响应函数。"""
        try:
            conn, _ = self.listener.accept()
            with conn:
                self.transport = paramiko.Transport(conn)
                self.transport.add_server_key(self.key)
                self.transport.start_server(server=self)
                channel = self.transport.accept(3)
                if channel is not None and self.requested.wait(3):
                    self.handler(channel, self.command)
                    self.finished.wait(0.05)
                    channel.close()
        except (EOFError, OSError, paramiko.SSHException):
            pass  # 错误公钥、认证失败和客户端主动断开都属于测试预期。
        except Exception as error:
            self.error = error
        finally:
            if self.transport:
                self.transport.close()

    def __enter__(self):
        """无参数；启动本机测试监听线程。"""
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        """exc_type/exc/tb 为上下文异常；回收连接和线程，不遗留监听或后台任务。"""
        self.finished.set()
        if self.transport:
            self.transport.close()
        self.listener.close()
        self.thread.join(4)
