"""功能：网络爬虫插件。抓 RSSHub 订阅源与普通网页正文，统一成一个出口。

注册参数 root 为主项目 Path、config 为可选覆盖；默认 RSSHub 为 http://127.0.0.1:1200。
只允许 http/https、只读文本、限制体积与超时；越界直接报错，不做静默截断冒充完整内容。
"""
import json
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

MAX_BYTES = 2 * 1024 * 1024


class CrawlPlugin:
    """RSSHub 与网页抓取的唯一出口。"""

    description = "网络爬虫：RSSHub 订阅源（feed）与网页正文（fetch）"

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 可覆盖 rsshub 地址与超时。"""
        self.root = Path(root)
        data = {"rsshub": "http://127.0.0.1:1200", "timeoutSeconds": 20}
        data.update(dict(config or {}))
        self.rsshub = str(data.get("rsshub")).rstrip("/")
        self.timeout = float(data.get("timeoutSeconds") or 20)
        self.opener = build_opener(ProxyHandler({}))

    def actions(self):
        """无参数；返回动作目录。"""
        return [
            {"name": "feed", "description": "抓取 RSSHub 路由或任意 RSS 地址",
             "args": {"route": "/zhihu/hot 或完整 URL", "limit": "可选，默认 20"}},
            {"name": "fetch", "description": "抓取网页",
             "args": {"url": "http/https 地址", "maxChars": "可选，默认 20000"}},
        ]

    def call(self, action, payload):
        """action 为动作名、payload 为参数；返回结构化结果。"""
        if action == "feed":
            target = str(payload.get("route") or "").strip()
            if not target:
                raise ValueError("feed 需要 route")
            if not target.startswith("http"):
                target = self.rsshub + "/" + target.lstrip("/")
            text = self._get(target)
            return {"url": target, "items": _parse_feed(text,
                                                        int(payload.get("limit") or 20))}
        if action == "fetch":
            url = str(payload.get("url") or "").strip()
            if not url:
                raise ValueError("fetch 需要 url")
            text = self._get(url)
            limit = int(payload.get("maxChars") or 20000)
            plain = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text,
                           flags=re.S | re.I)
            plain = re.sub(r"<[^>]+>", " ", plain)
            plain = re.sub(r"\s+", " ", plain).strip()
            return {"url": url, "chars": len(plain), "text": plain[:limit],
                    "truncated": len(plain) > limit}
        raise KeyError("未知动作：" + action)

    def _get(self, url):
        """url 为 http/https 地址；返回响应文本，越界或失败抛 RuntimeError。"""
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("只支持 http/https 地址")
        request = Request(url, headers={"User-Agent": "SynLove-Crawler/1.0"})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_BYTES + 1)
                charset = response.headers.get_content_charset() or "utf-8"
        except HTTPError as error:
            raise RuntimeError("抓取失败：HTTP %d" % error.code)
        except Exception as error:  # noqa: BLE001
            raise RuntimeError("抓取失败：%s" % type(error).__name__)
        if len(raw) > MAX_BYTES:
            raise RuntimeError("响应超过 2MB 上限")
        return raw.decode(charset, "replace")


def _parse_feed(text, limit):
    """text 为 RSS/Atom 文本、limit 为条数上限；返回标题与链接列表。"""
    items = []
    for block in re.findall(r"<item\b.*?</item>|<entry\b.*?</entry>", text, flags=re.S | re.I):
        title = re.search(r"<title[^>]*>(.*?)</title>", block, flags=re.S | re.I)
        link = re.search(r"<link[^>]*href=\"([^\"]+)\"|<link[^>]*>(.*?)</link>", block,
                         flags=re.S | re.I)
        items.append({"title": _clean(title.group(1) if title else ""),
                      "link": _clean((link.group(1) or link.group(2)) if link else "")})
        if len(items) >= limit:
            break
    return items


def _clean(value):
    """value 为可能含 CDATA 与实体的文本；返回去掉标记的纯文本。"""
    text = re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", value or "", flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    return (text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').strip())
