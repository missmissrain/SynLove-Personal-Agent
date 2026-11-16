"""QQ 主动推送：把一条文本发给指定用户（QQ 官方机器人接口）。

职责：
- 用 config/secrets.json 里的 qq.appId/clientSecret 换 access_token（每次运行现换，2 小时有效期）；
- POST /v2/users/{openid}/messages，**不带 msg_id** → 走主动消息（不受"刚聊过"的窗口限制）；
- 主动消息失败且配置允许时，自动用 `is_wakeup=true` 再试一次（长期静默时的官方召回通道）；
- 返回结构化结果，供上层写库与日志。

注册参数（来自配置 push 段）：
    userOpenid         收件人 openid
    allowWakeupFallback 失败时是否用 is_wakeup 重试，默认 True
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # 极老的解释器没有 reconfigure
    pass

TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken"
SEND_URL = "https://api.bot.qq.com/v2/users/{openid}/messages"
# 这些错误值得换 is_wakeup 再试（额度/权限/用户侧开关三类）
WAKEUP_RETRY_CODES = {40034100, 40034105, 304003, 304004}


class qqPush:
    """QQ 官方机器人主动消息发送器。"""

    def __init__(self, secrets_path, user_openid, allow_wakeup=True):
        """secrets_path：config/secrets.json；user_openid：收件人；allow_wakeup：失败是否用召回消息重试。"""
        self.secrets_path = Path(secrets_path)
        self.openid = user_openid
        self.allow_wakeup = bool(allow_wakeup)

    def _token(self):
        """换取 access_token（失败抛异常，附接口返回原文）。"""
        secrets = json.loads(self.secrets_path.read_text(encoding="utf-8-sig"))
        qq = secrets.get("qq") or {}
        if not qq.get("appId") or not qq.get("clientSecret"):
            raise RuntimeError("secrets.json 缺 qq.appId / qq.clientSecret")
        payload = json.dumps({"appId": str(qq["appId"]), "clientSecret": str(qq["clientSecret"])}).encode("utf-8")
        request = urllib.request.Request(TOKEN_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        token = data.get("access_token")
        if not token:
            raise RuntimeError(f"获取 access_token 失败：{json.dumps(data, ensure_ascii=False)[:300]}")
        return token

    def _send(self, token, content, wakeup=False):
        """发一条消息；wakeup=True 时带 is_wakeup，返回 (是否成功, 说明, 原始响应)。"""
        payload = {"content": content, "msg_type": 0}
        if wakeup:
            payload["is_wakeup"] = True
        request = urllib.request.Request(
            SEND_URL.format(openid=self.openid),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"QQBot {token}"},
            method="POST",
        )
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8") or "{}")
            ok = response.status == 200 and bool(data.get("id"))
            return ok, ("已发送" if ok else "接口未返回消息 id"), data
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(body or "{}")
            except json.JSONDecodeError:
                data = {"raw": body}
            return False, f"HTTP {error.code}：{data.get('message') or data.get('raw', '')}", data
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return False, f"网络错误：{error}", {}

    def push(self, content):
        """发送文本，返回 dict(ok, mode, detail)；主动消息失败会按配置回落 is_wakeup。"""
        token = self._token()
        ok, detail, data = self._send(token, content)
        print(f"[推送] 主动消息：{'成功' if ok else '失败'}（{detail}）", flush=True)
        if ok:
            return {"ok": True, "mode": "active", "detail": detail}
        code = data.get("code")
        if not (self.allow_wakeup and (code in WAKEUP_RETRY_CODES or code is None)):
            return {"ok": False, "mode": "active", "detail": f"{detail}（code={code}）"}
        print("[推送] 主动消息被拒，改用 is_wakeup 召回消息重试 …", flush=True)
        ok2, detail2, data2 = self._send(token, content, wakeup=True)
        print(f"[推送] 召回消息：{'成功' if ok2 else '失败'}（{detail2}）", flush=True)
        return {
            "ok": bool(ok2),
            "mode": "wakeup" if ok2 else "wakeup_failed",
            "detail": f"{detail2}（code={data2.get('code')}）" if not ok2 else detail2,
        }
