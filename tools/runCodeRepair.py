"""固定脚本自动修复入口：脱离 Harness Agent 直接调用 codeRepair。

负责的功能：
- 从一次性请求 JSON 读取故障原因和脱敏证据；
- 直接启动 codeRepair.py 的 Codex/OpenCode 链；
- 将结果原子写入 runtime/coderepair-result.json。

注册参数：
    --root       微信 Harness 工程根目录；
    --request    请求 JSON 路径；
    --result     结果 JSON 路径。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    """读取固定参数并执行一次自修；参数 argv 为命令行参数。"""
    parser = argparse.ArgumentParser(description="SynLove 固定脚本自动 Codex 修复")
    parser.add_argument("--root", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    request_path = Path(args.request)
    result_path = Path(args.result)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        reason = str(request.get("reason") or "链路恢复失败")
        detail = str(request.get("detail") or "")
        sys.path.insert(0, str(root / "tools"))
        from codeRepair import codeRepair  # noqa: PLC0415
        result = codeRepair(root=root).attempt(reason, detail)
        payload = {"pid": os.getpid(), **result}
        result_path.parent.mkdir(parents=True, exist_ok=True)
        temp = result_path.with_suffix(result_path.suffix + f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, result_path)
        return 0 if result.get("ok") else 1
    except Exception as error:  # noqa: BLE001
        payload = {"pid": os.getpid(), "ok": False, "cli": "",
                   "changed": [], "verify": f"固定自修脚本异常：{type(error).__name__}: {error}"}
        try:
            result_path.parent.mkdir(parents=True, exist_ok=True)
            result_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
