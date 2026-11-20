"""检查家庭服务器出站节点与 Relay 历史副本的漂移。参数：无。"""

import hashlib
import os
import sys

ROOT = r"G:\SynLove-houtai"
SOURCE = os.path.join(ROOT, "SynLove-Backend-Service", "relayNode")
TARGET = os.path.join(ROOT, "synlove-relay")
FILES = (
    r"dist\common\configLoader.js",
    r"dist\nodes\localClients.js",
    r"dist\nodes\nodeAgent.js",
    r"dist\protocol\frames.js",
    r"dist\protocol\types.js",
)


def digest(path):
    """返回文件的 sha256；不存在返回空串。"""
    if not os.path.isfile(path):
        return ""
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    """打印漂移表；存在差异返回 1，提醒发版前单向同步。"""
    drift = 0
    print("SOURCE", SOURCE)
    print("TARGET", TARGET)
    for rel in FILES:
        a = digest(os.path.join(SOURCE, rel))
        b = digest(os.path.join(TARGET, rel))
        state = "same" if a and a == b else "DIFF"
        if state == "DIFF":
            drift += 1
        print(f"{state:4} {rel}  {a[:12]}  {b[:12]}")
    print("DRIFT", drift, "（relayNode 是唯一发布源；只允许从源向 Relay 单向同步）")
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
