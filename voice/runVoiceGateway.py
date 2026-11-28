"""启动欣爱本机语音网关。"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.voiceGateway import VoiceGateway
from voice.primaryAgentClient import PrimaryAgentClient
from voice.voicePipeline import VoicePipeline
from voice.voiceServiceRegistry import VoiceServiceRegistry
from screenInitiative.screenInitiative import ScreenInitiative
from voiceRouting.AudioRouteService import AudioRouteService
from voiceRouting.ListeningRouteService import ListeningRouteService
from presenceState.StateMonitor import StateMonitor
import threading


if __name__ == "__main__":
    pipeline = VoicePipeline(registry=VoiceServiceRegistry(), agent=PrimaryAgentClient())
    active = threading.Event()
    routes = AudioRouteService(Path(__file__).resolve().parents[1])
    listening = ListeningRouteService(Path(__file__).resolve().parents[1], routes)
    # 第一层常驻状态刻画：只采集与算漂移，漂移够大才让 agent 起临时会话。
    presence_config_path = Path(__file__).resolve().parents[1] / "config/presenceReasoning.json"
    presence_config = (json.loads(presence_config_path.read_text("utf-8-sig"))
                       if presence_config_path.is_file() else {})
    presence = StateMonitor(Path(__file__).resolve().parents[1], routes,
                            config=presence_config)
    presence.start()
    listening.decision_provider = presence.decision
    def refresh_listening():
        """无参数；持续刷新位置推理，并按结果只让一个终端待命。"""
        while True:
            try:
                if routes.load_config().get("autoListeningMonitor", True):
                    listening.handle_request({"action": "refresh"})
            except Exception as error:
                # 不做降级：只记录最后一次失败，由健康检查暴露问题。
                try:
                    path = Path(__file__).resolve().parents[1] / "runtime/logs/voiceGatewayLastError.json"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({"at": time.time(), "stage": "refreshListening",
                                                "errorType": type(error).__name__,
                                                "message": str(error)[:200]},
                                               ensure_ascii=False), "utf-8")
                except OSError:
                    pass
            threading.Event().wait(30)
    threading.Thread(target=refresh_listening, daemon=True,
                     name="SynLoveListeningMonitor").start()
    initiative = ScreenInitiative(Path(__file__).resolve().parents[1], pipeline, busy=active.is_set,
                                  audio_router=routes)
    # 主动观察复用统一路由的在场结论，避免两套判断互相覆盖。
    initiative.presence_source = listening
    initiative.start_worker()
    VoiceGateway(pipeline=pipeline, activity=active, initiative=initiative,
                 audio_router=routes, listening_router=listening).serve_forever()
