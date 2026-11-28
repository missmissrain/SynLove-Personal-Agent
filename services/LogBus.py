"""功能：统一日志总线。每个服务写自己的日志文件，同时汇入一份总日志。

注册参数 root 为库根、service 为服务名；默认日志目录为生产根下 runtime/logs，
可用环境变量 SYNLOVE_LOG_DIR 覆盖。绑定幂等，可直接在入口调用。
日志写盘失败不抛出，避免日志问题把服务带崩；捕获标准输出供 pythonw 场景使用。
"""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOGGER_NAME = "synlove"
MAX_BYTES = 10 * 1024 * 1024
BACKUPS = 5


class _ServiceFilter(logging.Filter):
    """给每条日志补上服务名，便于总日志里区分来源。"""

    def __init__(self, service):
        """service 为服务名。"""
        super().__init__()
        self.service = service

    def filter(self, record):
        """record 为日志记录；补 service 字段并放行。"""
        record.service = self.service
        return True


def log_dir(root):
    """root 为库根；返回日志目录（生产根 runtime/logs），支持环境变量覆盖。"""
    override = os.environ.get("SYNLOVE_LOG_DIR", "").strip()
    if override:
        return Path(override)
    base = Path(root).resolve()
    for parent in [base, *base.parents]:
        if (parent / "repos").is_dir() and (parent / "models").is_dir():
            return parent / "runtime" / "logs"
    return base / "runtime" / "logs"


def bind(service, root, level="INFO"):
    """service 为服务名、root 为库根；返回已配置的 logger，重复调用不会重复加 handler。"""
    directory = log_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(LOGGER_NAME)
    if getattr(logger, "_synlove_bound", False):
        return logger
    logger.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)-5s [%(service)s] %(name)s:%(lineno)d %(message)s",
        "%Y-%m-%d %H:%M:%S")
    service_handler = RotatingFileHandler(directory / (service + ".log"),
                                          maxBytes=MAX_BYTES, backupCount=BACKUPS,
                                          encoding="utf-8")
    all_handler = logging.FileHandler(directory / "all.log", encoding="utf-8")
    handlers = [service_handler, all_handler]
    if sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    for handler in handlers:
        handler.setFormatter(formatter)
        handler.addFilter(_ServiceFilter(service))
        logger.addHandler(handler)
    logger.propagate = False
    logger._synlove_bound = True
    return logger


def capture_stdio(service, root):
    """service 为服务名；pythonw 下把 stdout/stderr 接到 <service>.console.log。"""
    if sys.stdout is not None and sys.stderr is not None:
        return
    directory = log_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    stream = open(directory / (service + ".console.log"), "ab", buffering=0)
    wrapper = io_wrapper(stream)
    if sys.stdout is None:
        sys.stdout = wrapper
    if sys.stderr is None:
        sys.stderr = wrapper


def io_wrapper(stream):
    """stream 为二进制文件；返回可写文本包装（带 reconfigure，兼容依赖它的模块）。"""
    import io
    return io.TextIOWrapper(stream, encoding="utf-8", line_buffering=True)


def install_excepthook(logger):
    """logger 为已绑定 logger；未捕获异常写进日志再交给默认钩子。"""
    def handle(exc_type, exc_value, exc_tb):
        """exc_type/exc_value/exc_tb 为标准异常三元组。"""
        logger.error("未捕获异常", exc_info=(exc_type, exc_value, exc_tb))
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    sys.excepthook = handle
