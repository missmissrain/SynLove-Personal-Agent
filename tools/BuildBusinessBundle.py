"""家庭后台增量包。参数--output为ZIP输出路径；只打包四项业务、出站节点和部署文档，不含依赖或私人配置。"""

import argparse
import hashlib
import json
import os
import zipfile
from pathlib import Path


class BuildBusinessBundle:
    """显式白名单打包，排除运行数据、实际服务配置、密钥、日志和依赖目录。"""

    def __init__(self, backend=None):
        """backend为配套仓库根目录，默认使用生产仓库的同级Backend。"""
        self.backend = Path(backend or Path(__file__).resolve().parents[2] / "SynLove-Backend-Service")

    def build_bundle(self, output):
        """output为生成物路径；文件已存在时拒绝覆盖，返回SHA256和文件数量。"""
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        files = []
        for folder in ("businessRuntime", "relayNode", "deploy"):
            candidates = []
            for base, dirs, names in os.walk(self.backend / folder, followlinks=False):
                dirs[:] = [name for name in dirs if name not in
                           ("runtime", "node_modules", "__pycache__", "logs", "privateMigration")
                           and not (Path(base) / name).is_symlink()]
                candidates.extend(Path(base) / name for name in names)
            for path in candidates:
                if not path.is_file() or path.is_symlink():
                    continue
                parts = path.relative_to(self.backend).parts
                if any(part in ("runtime", "node_modules", "__pycache__", "logs", "privateMigration")
                       for part in parts):
                    continue
                if path.suffix not in (".py", ".md", ".ps1", ".ts", ".js", ".mjs", ".json", ".map", ".txt"):
                    continue
                if path.suffix == ".json" and not (
                        path.name.endswith(".example.json") or path.name in ("package.json", "tsconfig.json")):
                    continue
                if path.name == "secrets.json" or ".beforeMigration." in path.name:
                    continue
                files.append(path)
        if not (self.backend / "relayNode" / "dist" / "tools" / "startNode.js").is_file():
            raise ValueError("先构建业务出站节点，再生成部署包")
        files.append(self.backend / "README.md")
        manifest = {}
        with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(files):
                name = path.relative_to(self.backend).as_posix()
                data = path.read_bytes()
                manifest[name] = hashlib.sha256(data).hexdigest()
                bundle.writestr(name, data)
            bundle.writestr("bundleManifest.json", json.dumps(
                {"version": 1, "kind": "business-increment", "files": manifest},
                ensure_ascii=False, indent=2))
        return {"files": len(files), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "bytes": output.stat().st_size}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(BuildBusinessBundle().build_bundle(args.output)))
