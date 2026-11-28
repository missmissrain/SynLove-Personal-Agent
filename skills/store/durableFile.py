"""可降级的持久化写入：文件被占用时重试，仍失败就转存降级副本，绝不抛异常。

职责（本模块只做"写文件"这一件事）：
- `append_line`：追加一行（日志用），失败重试 → 再失败转存降级副本；
- `write_text`：整文件原子写（临时文件 + `os.replace`），重试 Windows 上偶发的
  `PermissionError` / `EPERM`（杀软扫描、索引器、上一个进程还没放开句柄）；
- `read_json`：容错读 JSON，缺失 / BOM / 半截文件 / 被占用都返回默认值。

为什么要有这个东西：
2026-10-29 03:00 的技能复盘在写 `runtime/skill-review.log` 时撞上文件被占用，
`PermissionError` 一路冒到顶层，整轮复盘直接崩掉、水位没推进。
**日志写不进去是小事，把正事带崩才是大事**，所以这里的所有失败都"降级、不抛"：
主文件写不了就写 `<原名>.locked-<时间戳>-<pid>.bak`，内容一行都不丢。

注册参数（构造）：
    fallback_dir  降级副本目录，默认落在目标文件同目录（None 表示同目录）
    retries       重试次数，默认 6（约 0.15+0.3+0.6+1.2+2+2 ≈ 6 秒）
    base_delay    首次重试等待秒数，默认 0.15，逐次翻倍，单次上限 2 秒
"""

import json
import os
import sys
import time
from pathlib import Path


class durableFile:
    """面向上层业务的"写不坏"文件写入器（降级副本 + 原子替换）。"""

    def __init__(self, fallback_dir=None, retries=6, base_delay=0.15):
        """fallback_dir：降级副本目录；retries：重试次数；base_delay：首次等待秒数。"""
        self.fallback_dir = Path(fallback_dir) if fallback_dir else None
        self.retries = max(1, int(retries))
        self.base_delay = max(0.0, float(base_delay))
        self.degraded = 0            # 累计降级次数（上层可据此告警）

    def append_line(self, path, text):
        """向 path 追加一行文本。

        参数 path：目标文件；text：要写的内容（不带换行也行）。
        返回 True 表示写进主文件；False 表示已转存降级副本（内容没丢，但主文件没更新）。
        """
        target = Path(path)
        payload = text if text.endswith("\n") else text + "\n"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return self._degrade(target, payload)
        for attempt in range(self.retries):
            try:
                with open(target, "a", encoding="utf-8") as handle:
                    handle.write(payload)
                return True
            except OSError:
                self._sleep(attempt)
        return self._degrade(target, payload)

    def write_text(self, path, text):
        """原子写整个文件（先写临时文件再替换），被占用时重试。

        参数 path：目标文件；text：完整内容。
        返回 True 表示替换成功；False 表示已转存降级副本（原文件保持旧内容）。
        """
        target = Path(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return self._degrade(target, text)
        for attempt in range(self.retries):
            tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}-{attempt}")
            try:
                with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                    handle.write(text)
                os.replace(tmp, target)
                return True
            except OSError:
                try:
                    tmp.unlink()          # 半截临时文件留着会更乱，能删就删
                except OSError:
                    pass
                self._sleep(attempt)
        return self._degrade(target, text)

    def read_json(self, path, default=None):
        """容错读 JSON（缺失 / BOM / 截断 / 被占用都返回 default，默认 {}）。

        参数 path：JSON 文件；default：读不到时的返回值（内部会复制一份，避免共享可变默认值）。
        """
        blank = {} if default is None else default
        try:
            raw = Path(path).read_text(encoding="utf-8-sig")
        except OSError:
            return dict(blank) if isinstance(blank, dict) else blank
        if not raw.strip():
            return dict(blank) if isinstance(blank, dict) else blank
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return dict(blank) if isinstance(blank, dict) else blank
        return data if isinstance(data, dict) else (dict(blank) if isinstance(blank, dict) else blank)

    def _sleep(self, attempt):
        """按指数退避等待（不阻塞太久，最长 2 秒一次）。"""
        time.sleep(min(2.0, self.base_delay * (2 ** attempt)))

    def _degrade(self, target, text):
        """主文件写不进去时的最后一招：转存降级副本，内容一行不丢。

        参数 target：原本的目标文件；text：没写进去的内容。
        返回 False（语义：主文件未更新）。
        """
        self.degraded += 1
        folder = self.fallback_dir or target.parent
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = Path(folder) / f"{target.name}.locked-{stamp}-{os.getpid()}.bak"
        payload = f"# 主文件被占用，{stamp} 转存（原目标：{target}）\n{text}"
        if not payload.endswith("\n"):
            payload += "\n"
        for attempt in range(3):
            try:
                backup.parent.mkdir(parents=True, exist_ok=True)
                with open(backup, "a", encoding="utf-8") as handle:
                    handle.write(payload)
                print(f"[durableFile] 主文件不可写，已转存 {backup.name}", file=sys.stderr, flush=True)
                return False
            except OSError:
                self._sleep(attempt)
        # 连降级副本都写不了：只能打屏，绝不抛异常
        print(f"[durableFile] 降级写入也失败：{payload[:200]}", file=sys.stderr, flush=True)
        return False
