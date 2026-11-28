"""夜间仓库维护入口；--check只检查配置，--config指定私有配置文件，默认config/nightlyMaintenance.json。"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from maintenance.NightlyMaintenance import NightlyMaintenance


def main():
    """解析配置路径和只读检查开关；返回可供计划任务识别的退出码。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(ROOT / "config/nightlyMaintenance.json"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        result = NightlyMaintenance(ROOT, args.config).run_once(args.check)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if result["ok"] else 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
