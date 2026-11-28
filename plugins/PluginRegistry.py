"""功能：插件登记表。只描述插件怎么做，不关心 HTTP 与调度。

注册参数 root 为主项目 Path、config 为可选配置；默认读 config/plugins.json。
每项登记 name、module、class、description；启动时实例化一次，全部失败都明确报错。
"""
import importlib
import json
from pathlib import Path


class PluginRegistry:
    """按配置加载插件实例，提供目录与查找。"""

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 为可选配置（默认 config/plugins.json）。"""
        self.root = Path(root)
        path = self.root / "config" / "plugins.json"
        data = dict(config or {})
        if not data:
            data = json.loads(path.read_text("utf-8-sig")) if path.is_file() else {}
        self.host = str(data.get("host") or "127.0.0.1")
        self.port = int(data.get("port") or 8830)
        self.plugins = {}
        for item in data.get("plugins") or []:
            name = str(item.get("name") or "").strip()
            module_name = str(item.get("module") or "").strip()
            class_name = str(item.get("class") or "").strip()
            if not name or not module_name or not class_name:
                raise ValueError("插件登记缺少 name/module/class")
            module = importlib.import_module(module_name)
            factory = getattr(module, class_name)
            self.plugins[name] = factory(self.root, item.get("config") or {})

    def get(self, name):
        """name 为插件名；返回实例，不存在返回 None。"""
        return self.plugins.get(str(name))

    def catalog(self):
        """无参数；返回所有插件的动作目录。"""
        items = []
        for name, plugin in sorted(self.plugins.items()):
            items.append({"name": name, "description": getattr(plugin, "description", ""),
                          "actions": plugin.actions()})
        return {"updatedAt": __import__("time").time(), "plugins": items}
