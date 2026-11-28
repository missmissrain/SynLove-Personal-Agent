"""功能：后台低频观察活跃终端，按模型建议和确定性门槛决定静默、QQ文字或固定音色语音。

注册参数root为生产根，deliver为投递实现（消息层）；terminal/model/busy/audio_router可注入测试。
本类只负责采样、预算与判断，不合成语音、不直连终端播放。
默认配置不存在即关闭；90秒检查并更新所在设备、每小时8次模型判断、
每日6次开口、间隔30分钟。只保存去重摘要、次数和脱敏设备状态，不保存截图或观察正文；
重启后保留打扰预算与最近一次位置状态。
"""
import hashlib
import json
import threading
import time
import uuid
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from facts.FactsClient import facts_client
from screenInitiative.screenModel import ScreenModel
from screenInitiative.screenPolicy import ScreenPolicy
from screenInitiative.screenTerminal import ScreenTerminal
from screenInitiative.PresenceInference import PresenceInference


class ScreenInitiative:
    """把采样、判断和投递分离，后台异常只记类型，不向聊天渠道发送运行报告。"""

    def __init__(self, root, deliver, terminal=None, model=None, busy=None, audio_router=None):
        """root提供配置；deliver为投递实现，terminal/model/busy为可注入的设备、模型及前台忙碌标记。"""
        self.root, self.deliver = Path(root), deliver
        self.path = self.root / "config/screenInitiative.json"
        self.state_path = self.root / "runtime/screenInitiative/state.json"
        self.presence_path = self.root / "runtime/screenInitiative/presence.json"
        self.terminal, self.model = terminal, model or ScreenModel(self.root)
        self.busy = busy or (lambda: False)
        self.audio_router = audio_router
        self.stop = threading.Event()
        self.thread = None
        self.status = {"enabled": False, "state": "disabled"}
        self.frames = {}
        self.last_decision = None
        try:
            self.state = json.loads(self.state_path.read_text("utf-8"))
        except FileNotFoundError:
            self.state = {"calls": [], "topics": {}, "lastChat": 0, "day": "", "chats": 0,
                          "presence": {}}

    def load_config(self):
        """无参数；每轮读取独立配置，校验预算和白名单，禁止非法配置放大轮询。"""
        if not self.path.is_file():
            return {"enabled": False}
        cfg = json.loads(self.path.read_text("utf-8-sig"))
        if cfg.get("enabled") is not True:
            return {"enabled": False}
        for key, default, low, high in (
            ("sampleSeconds", 90, 30, 3600), ("maxModelCallsPerHour", 8, 1, 30),
            ("maxChatsPerDay", 6, 1, 30), ("minChatIntervalSeconds", 1800, 300, 86400),
            ("speechExpiresSeconds", 90, 30, 180), ("presenceIntervalSeconds", 90, 30, 86400),
            ("presenceTtlSeconds", 7200, 600, 172800),
            ("presenceAbsenceSeconds", 900, 300, 86400),
            ("presenceAwayHoldSeconds", 300, 60, 3600),
            ("presenceBluetoothIdleSeconds", 1800, 120, 86400)):
            value = cfg.setdefault(key, default)
            if type(value) is not int or not low <= value <= high:
                raise ValueError("主动观察预算配置不合法")
        if type(cfg.setdefault("presenceBluetoothPrior", True)) is not bool:
            raise ValueError("蓝牙先验开关必须为布尔值")
        profile_path = self.root / cfg.get("presenceProfilePath", "config/presenceProfile.json")
        if profile_path.is_file():
            profile = json.loads(profile_path.read_text("utf-8-sig"))
            if not isinstance(profile, dict) or not isinstance(profile.get("schedule", []), list):
                raise ValueError("人物画像位置先验配置不合法")
            cfg["presenceProfile"] = profile
        else:
            cfg["presenceProfile"] = {}
        if (not isinstance(cfg.get("devices"), list) or len(cfg["devices"]) > 10
                or any(not isinstance(key, str) or not key for key in cfg["devices"])):
            raise ValueError("观察设备白名单无效")
        return cfg

    def start_worker(self):
        """无参数；启动单个可停止后台线程，不在导入或构造时访问屏幕。"""
        if self.thread is None:
            self.thread = threading.Thread(target=self.run_worker, daemon=True, name="screenInitiative")
            self.thread.start()

    def run_worker(self):
        """无参数；低频串行处理，不重叠采样，错误时至少等待90秒。"""
        while not self.stop.is_set():
            delay = 90
            try:
                cfg = self.load_config()
                delay = cfg.get("sampleSeconds", 90)
                self.tick_once(cfg)
            except Exception as exc:
                self.status.update(state="waiting", errorType=type(exc).__name__)
            self.stop.wait(delay)

    def save_state(self):
        """无参数；原子保存预算、主题哈希和最近设备状态，不存观察画面或私人正文。"""
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.state_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.state), "utf-8")
        temp.replace(self.state_path)

    def save_presence(self, presence):
        """presence为脱敏设备位置状态；原子保存当前设备、置信度、证据时间和过期时间。"""
        facts_client().update_presence_section("screenInitiative", presence,
                                               source="screenInitiative")

    def update_presence(self, cfg, terminal, policy, now, force=False):
        """cfg/terminal/policy/now为配置、终端适配器、策略和当前时间；按周期更新所在设备。"""
        old = self.state.get("presence") or {}
        last = old.get("observedAt", 0)
        interval = cfg.get("presenceIntervalSeconds", 90)
        # 轻量状态查询不调用视觉模型，也不受主动交流的预算和冷却限制。
        if (not force and old.get("state") != "unknown"
                and type(last) in (int, float) and now - last < interval):
            return old
        # 在场结论优先采用统一路由（含 agent 决策），避免两条链路互相覆盖。
        source = getattr(self, "presence_source", None)
        if source is not None:
            try:
                shared = source.read_presence()
            except (AttributeError, OSError, RuntimeError, ValueError):
                shared = None
            if shared:
                self.state["presence"] = shared
                self.save_state()
                self.save_presence(shared)
                return shared
        devices = [item for item in terminal.list_devices() if item["id"] in cfg["devices"]]
        states = self.read_states(terminal, devices)
        # 使用采样完成后的时间，避免串行网络查询让新采样被误认为来自未来。
        presence = PresenceInference(cfg).infer_presence(devices, states, old, time.time())
        self.state["presence"] = presence
        self.save_state()
        self.save_presence(presence)
        return presence

    def primary_idle(self):
        """无参数；主人格忙碌或不可用时不发起后台模型判断。"""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:8813/health", timeout=5) as res:
            value = json.load(res)
        return value.get("ok") is True and value.get("busy") is False

    def read_states(self, terminal, devices):
        """terminal/devices为适配器与在线白名单；个别设备失败按未知处理。"""
        states = {}
        for device in devices:
            if device.get("online") and "screen.observe" in device.get("capabilities", []):
                try:
                    states[device["id"]] = terminal.observe_device(device["id"], {"action": "status"})
                except (RuntimeError, OSError, ValueError):
                    continue
        if self.audio_router is not None:
            for key, camera in self.audio_router.store.read_state().get("cameras", {}).items():
                if key in self.audio_router.load_config().get("devices", []):
                    states.setdefault(key, {})["camera"] = camera
        return states

    def tick_once(self, cfg=None):
        """cfg为本轮配置；先检查预算和近期状态，最多观察一台终端，无价值内容保持静默。"""
        cfg = cfg or self.load_config()
        self.status = {"enabled": cfg.get("enabled") is True, "state": "disabled",
                       "lastCheckAt": time.time()}
        if not cfg.get("enabled"):
            return
        now = time.time()
        policy = ScreenPolicy(cfg, self.audio_router)
        day = datetime.fromtimestamp(now, timezone(timedelta(
            minutes=cfg.get("utcOffsetMinutes", 480)))).strftime("%Y-%m-%d")
        if self.state["day"] != day:
            self.state.update(day=day, chats=0)
        self.state["calls"] = [stamp for stamp in self.state["calls"] if now - stamp < 3600]
        self.state["topics"] = {key: stamp for key, stamp in self.state["topics"].items()
                                if now - stamp < 86400}
        terminal = self.terminal or ScreenTerminal(self.root, cfg)
        presence = self.update_presence(cfg, terminal, policy, now)
        self.status["presence"] = presence
        if (policy.is_quiet(now) or self.busy()
                or self.state["chats"] >= cfg["maxChatsPerDay"]
                or now - self.state["lastChat"] < cfg["minChatIntervalSeconds"]
                or len(self.state["calls"]) >= cfg["maxModelCallsPerHour"]):
            self.status["state"] = "quietOrCooldown"
            return
        devices = [item for item in terminal.list_devices() if item["id"] in cfg["devices"]]
        states = self.read_states(terminal, devices)
        active = [key for key, value in states.items() if policy.is_active(value, time.time())]
        self.status.update(state="noActiveDevice", activeDevices=active,
                           chatsToday=self.state["chats"], modelCallsThisHour=len(self.state["calls"]))
        if not active or not self.primary_idle():
            return
        source = min(active, key=lambda key: states[key]["idleSeconds"])
        raw, capture_state = terminal.read_frame(source)
        digest = hashlib.sha256(raw).hexdigest()
        if self.frames.get(source) == digest:
            self.status["state"] = "unchanged"
            return
        self.frames[source] = digest
        def reserve_model_call():
            """无参数；每个真实提供方尝试均占用小时预算，包括失败和回退，不超额请求。"""
            stamp = time.time()
            self.state["calls"] = [value for value in self.state["calls"] if stamp - value < 3600]
            if len(self.state["calls"]) >= cfg["maxModelCallsPerHour"]:
                return False
            self.state["calls"].append(stamp)
            self.save_state()
            return True

        self.model.before_request = reserve_model_call
        decision = self.model.decide_screen(raw, {
            "deviceId": source, "deviceState": capture_state, "otherDeviceStates": states,
            "purpose": "判断是否有值得与主人说的一句话，通常保持静默",
            "recentTopicHashes": list(self.state["topics"]),
        })
        del raw
        self.last_decision = decision
        # 模型或传输耗时后重新取证，不能用几十秒前的位置来决定外放。
        devices = [item for item in terminal.list_devices() if item["id"] in cfg["devices"]]
        states = self.read_states(terminal, devices)
        route = policy.choose_route(decision, source, states, devices, time.time())
        topic = hashlib.sha256(decision["topicKey"].encode()).hexdigest()
        self.status.update(state="observedSilently", suggestedMode=route["mode"])
        self.status["audioRoute"] = route
        if route["mode"] == "silent" or topic in self.state["topics"] or self.busy():
            return
        if cfg.get("dryRun") is True:
            self.status["state"] = "dryRun"
            return
        # 在投递之前先占用预算，进程崩溃或收据不明时不自动重复打扰。
        self.state["lastChat"] = time.time()
        self.state["chats"] += 1
        self.state["topics"][topic] = time.time()
        self.save_state()
        ident = uuid.uuid4().hex
        expires = time.time() + cfg["speechExpiresSeconds"]
        if route["mode"] == "qq" and self.audio_router is not None and route.get("needsTarget"):
            self.status["routeQuestion"] = self.audio_router.ask_target(route, terminal)
        # 判断留在事实层，开口交给消息层：这里只提交一次投递请求，不碰语音流水线与播放。
        delivered = self.deliver({"mode": route["mode"], "text": decision["text"],
                                  "emotion": decision.get("emotion", "neutral"),
                                  "deviceId": source, "ident": ident, "expiresAt": expires,
                                  "route": route}) or {}
        self.status.update(state=str(delivered.get("state") or "delivered"),
                           channel=route["mode"])

    def fresh_route(self, source):
        """source 为观察设备；按当前配置与设备状态重算路由，供播放前复核。"""
        decision = self.last_decision
        if not isinstance(decision, dict):
            return {}
        cfg = self.load_config()
        if not cfg.get("enabled") or self.busy():
            return {}
        terminal = self.terminal or ScreenTerminal(self.root, cfg)
        devices = [item for item in terminal.list_devices() if item["id"] in cfg["devices"]]
        states = self.read_states(terminal, devices)
        return ScreenPolicy(cfg, self.audio_router).choose_route(decision, source, states, devices,
                                                                time.time())
