"""启动欣爱本机语音网关。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.voiceGateway import VoiceGateway


if __name__ == "__main__":
    VoiceGateway().serve_forever()
