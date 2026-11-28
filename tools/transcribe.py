"""
语音转写命令行：按统一服务配置调用本机或远程 ASR。

用法：
    python tools\\transcribe.py "D:\\path\\a.mp3" [--language zh] [--model small]

行为：
- managed 模式按需启动 whisper；external 模式只访问配置地址；
- 上传真实音频内容，不依赖共享文件系统；服务闲置退出。
"""

import argparse
import sys
import time
import urllib.error
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from services.ServiceRegistry import ServiceRegistry
from services.ServiceClient import ServiceClient
from services.LocalServiceLifecycle import LocalServiceLifecycle
LOG = ROOT / "runtime" / "asr-service.log"


def main(argv):
    """入口。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("path", help="本地音频/视频文件路径")
    parser.add_argument("--language", default=None, help="语言代码，如 zh / en；不填自动检测")
    parser.add_argument("--model", default=None, help="覆盖本次转写模型，默认采用服务配置")
    parser.add_argument("--idle-seconds", type=int, default=180)
    args = parser.parse_args(argv)

    path = str(Path(args.path).expanduser().resolve())
    if not Path(path).is_file():
        print(f"文件不存在：{path}")
        return 2
    started = time.time()
    try:
        cfg = ServiceRegistry().get_service("asr")
        if args.model:
            cfg["model"] = args.model
        LocalServiceLifecycle("asr", cfg).ensure_service(args.idle_seconds, model=args.model)
        data = ServiceClient(cfg).transcribe(path, args.language)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        print(f"转写失败 HTTP {error.code}: {body[:500]}")
        return 1
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, RuntimeError) as error:
        print(f"转写失败：{error}（日志 {LOG}）")
        return 1

    print(f"用时 {time.time() - started:.1f}s  模型 {data.get('model')}  设备 {data.get('device')}")
    for item in data.get("segments", []):
        print(f"[{item['start']:>7.2f}-{item['end']:>7.2f}] {item['text']}")
    print("--- 全文 ---")
    print(data.get("text", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
