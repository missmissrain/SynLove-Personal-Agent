"""维护副本基础检查：只读解析Python与JSON，不导入业务模块或加载模型。

参数root为隔离源码目录；默认采用RepositoryWorkspace的源码范围。此检查不能替代功能回归。
"""
import ast
import json
import os
from pathlib import Path

from maintenance.RepositoryWorkspace import RepositoryWorkspace


class SourceValidator:
    """为缺少完整运行依赖的隔离副本提供语法与配置格式校验。"""

    def __init__(self, root):
        """root为本轮源码根目录，必须存在。"""
        self.root = Path(root)

    def validate_source(self):
        """只检查准许维护范围内的Python/JSON文件；错误包含相对路径，返回计数。"""
        count = 0
        for folder, dirs, files in os.walk(self.root):
            dirs[:] = [d for d in dirs if d not in RepositoryWorkspace.skip and not d.startswith(".")]
            for name in files:
                path = Path(folder) / name
                rel = path.relative_to(self.root)
                if not RepositoryWorkspace.allowed_path(rel):
                    continue
                if path.suffix == ".py":
                    ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(rel))
                    count += 1
                elif path.suffix == ".json":
                    json.loads(path.read_text(encoding="utf-8-sig"))
                    count += 1
        if not count:
            raise RuntimeError("没有可验证源码")
        return count
