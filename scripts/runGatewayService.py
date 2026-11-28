"""启动三通道消息网关微服务。参数：无。由计划任务 SynLove-MessageGateway 调用。"""

import json
import threading
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.LogBus import bind, capture_stdio, install_excepthook  # noqa: E402
LOG = bind("message", ROOT)
capture_stdio("message", ROOT)
install_excepthook(LOG)
LOG.info("服务启动 runGatewayService.py")
sys.path.insert(0, str(ROOT.parent / "terminal-pc"))

from channels.AgentBridge import AgentBridge  # noqa: E402
from channels.GatewayService import GatewayService  # noqa: E402
from channels.QqSender import QqSender  # noqa: E402
from channels.TestSender import TestSender  # noqa: E402
from channels.VoiceInbound import VoiceInbound  # noqa: E402
from channels.VoiceSender import VoiceSender  # noqa: E402
from channels.WeixinSender import WeixinSender  # noqa: E402
from voice.voiceGateway import VoiceGateway  # noqa: E402
from voice.primaryAgentClient import PrimaryAgentClient  # noqa: E402
from voice.voicePipeline import VoicePipeline  # noqa: E402
from voice.voiceServiceRegistry import VoiceServiceRegistry  # noqa: E402
from channels.InitiativeExecutor import InitiativeExecutor  # noqa: E402
from voiceRouting.AudioRouteService import AudioRouteService  # noqa: E402
from voiceRouting.ListeningRouteService import ListeningRouteService  # noqa: E402


def load(name):
    """name为配置文件名；返回字典，缺失返回空。"""
    path = ROOT / "config" / name
    if not path.is_file():
        return {}
    return json.loads(path.read_text("utf-8-sig"))


def main():
    """无参数；按配置装配发送器与入站适配器后常驻。"""
    config = load("channels.json")
    terminal = load("terminalConnection.json")
    audio_router = config.get("audioRouteURL", "http://127.0.0.1:8812")
    weixin_admin = config.get("weixinAdminURL", "http://127.0.0.1:3081")
    senders = {
        "qq": QqSender(terminal.get("adminURL", "http://127.0.0.1:17864"),
                       terminal.get("adminToken", ""),
                       config.get("qqAdminURL", "http://127.0.0.1:3083")),
        "voice": VoiceSender(audio_router),
        "weixin": WeixinSender(weixin_admin),
        "test": TestSender(str(ROOT)),
    }
    routes = AudioRouteService(ROOT)
    listening = ListeningRouteService(ROOT, routes)
    pipeline = VoicePipeline(registry=VoiceServiceRegistry(), agent=PrimaryAgentClient())
    active = threading.Event()
    # 判断在事实层（8802），这里只保留投递执行器。
    initiative = InitiativeExecutor(ROOT, pipeline, audio_router=routes)
    voice = VoiceGateway(pipeline=pipeline, activity=active, initiative=initiative,
                         audio_router=routes, listening_router=listening)
    threading.Thread(target=voice.serve_forever, daemon=True,
                     name="SynLoveVoiceInMessageService").start()
    service = GatewayService(ROOT, host=config.get("host", "127.0.0.1"),
                             port=int(config.get("port", 8805)),
                             senders=senders, agent=AgentBridge())
    service.gateway.voice_inbound = VoiceInbound(audio_router)
    service.initiative = initiative
    service.activity = active
    print("message gateway on %s:%d" % (service.host, service.port), flush=True)
    service.serve_forever()


if __name__ == "__main__":
    main()
