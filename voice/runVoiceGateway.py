"""启动欣爱本机语音网关。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.voiceGateway import VoiceGateway
from voice.primaryAgentClient import PrimaryAgentClient
from voice.voicePipeline import VoicePipeline
from voice.voiceServiceRegistry import VoiceServiceRegistry
from screenInitiative.screenInitiative import ScreenInitiative
from voiceRouting.AudioRouteService import AudioRouteService
from voiceRouting.ListeningRouteService import ListeningRouteService
import threading


if __name__ == "__main__":
    pipeline = VoicePipeline(registry=VoiceServiceRegistry(), agent=PrimaryAgentClient())
    active = threading.Event()
    routes = AudioRouteService(Path(__file__).resolve().parents[1])
    listening = ListeningRouteService(Path(__file__).resolve().parents[1], routes)
    def refresh_listening():
        """无参数；持续刷新位置推理，并按结果只让一个终端待命。"""
        while True:
            try:
                if routes.load_config().get("autoListeningMonitor", True):
                    listening.handle_request({"action": "refresh"})
            except Exception:
                pass
            threading.Event().wait(30)
    threading.Thread(target=refresh_listening, daemon=True,
                     name="SynLoveListeningMonitor").start()
    initiative = ScreenInitiative(Path(__file__).resolve().parents[1], pipeline, busy=active.is_set,
                                  audio_router=routes)
    initiative.start_worker()
    VoiceGateway(pipeline=pipeline, activity=active, initiative=initiative,
                 audio_router=routes, listening_router=listening).serve_forever()
