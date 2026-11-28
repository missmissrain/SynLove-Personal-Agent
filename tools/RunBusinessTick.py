"""功能：由自迭代服务驱动业务服务的调度检查（提醒到期、日报当日领取）。

参数：--service reminders|digest，--timeout 秒（默认 60）。
鉴权顺序：环境变量 SYNLOVE_BUSINESS_API_KEY → models/config/secrets.json 的 backendService.apiKey；
两处都没有就明确报错退出，不发未鉴权请求。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

PORTS = {"reminders": 8791, "digest": 8792}
ROOT = Path(__file__).resolve().parents[1]


def resolve_key():
    """无参数；返回(密钥, 来源)，按环境、服务端 env 文件、secrets.json 顺序解析。"""
    key = os.environ.get("SYNLOVE_BUSINESS_API_KEY", "").strip()
    if key:
        return key, "env"
    env_file = ROOT.parents[1] / "ops" / "synlove-server.env"
    if env_file.is_file():
        for line in env_file.read_text("utf-8", errors="replace").splitlines():
            if line.startswith("SYNLOVE_BUSINESS_API_KEY="):
                value = line.split("=", 1)[1].strip()
                if value:
                    return value, "synlove-server.env"
    path = ROOT.parents[1] / "models" / "config" / "secrets.json"
    if path.is_file():
        data = json.loads(path.read_text("utf-8-sig"))
        key = str((data.get("backendService") or {}).get("apiKey") or "").strip()
        if key:
            return key, "secrets.json"
    return "", "missing"


def main():
    """无参数；向指定业务服务发起一次调度检查并打印结果。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", choices=sorted(PORTS), required=True)
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()
    key, source = resolve_key()
    if not key:
        print("缺少业务服务密钥：环境变量、ops/synlove-server.env 与 secrets.json 都没有")
        return 3
    url = "http://127.0.0.1:%d/v1/schedule/tick" % PORTS[args.service]
    request = urllib.request.Request(url, data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print("调度失败：HTTP %d %s" % (error.code,
                                        error.read().decode("utf-8", "replace")[:200]))
        return 2
    except Exception as error:
        print("调度失败：%s: %s" % (type(error).__name__, error))
        return 2
    value["keySource"] = source
    print(json.dumps(value, ensure_ascii=False))
    return 0 if value.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
