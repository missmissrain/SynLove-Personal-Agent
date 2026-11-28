"""功能：由自迭代服务调用消息服务的管理 tick（记忆更新、主动研究）。

参数：--action 为 memory-tick 或 proactive-tick；--timeout 为等待秒数，默认 1800。
入口固定为 127.0.0.1 的注入口（默认 3081），失败直接报错并以非零码退出，不降级。
"""
import argparse
import os
import sys
import urllib.error
import urllib.request

ACTIONS = ("memory-tick", "proactive-tick")


def main():
    """无参数；向消息服务发起一次管理 tick 并打印结果。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=ACTIONS, required=True)
    parser.add_argument("--timeout", type=float, default=1800.0)
    args = parser.parse_args()
    port = int(os.environ.get("DSH_WEIXIN_INJECT_PORT") or "3081")
    url = "http://127.0.0.1:%d/admin/%s" % (port, args.action)
    request = urllib.request.Request(url, data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            print(response.read().decode("utf-8", "replace"))
            return 0
    except urllib.error.HTTPError as error:
        print("%s 失败：HTTP %d %s" % (args.action, error.code,
                                      error.read().decode("utf-8", "replace")[:300]))
        return 2
    except Exception as error:
        print("%s 失败：%s: %s" % (args.action, type(error).__name__, error))
        return 2


if __name__ == "__main__":
    sys.exit(main())
