"""源码校验入口：参数为隔离源码目录，仅做Python/JSON解析，不调用业务服务。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from maintenance.SourceValidator import SourceValidator


def main():
    """第一个参数为待验目录；成功返回0，异常交由调用方保存到验证日志。"""
    print("已检查源码文件：", SourceValidator(sys.argv[1]).validate_source())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
