"""启动流式 ASR 服务的进程入口。

功能：读取 config/voiceConfig.json 中的流式 ASR 配置，加载模型并阻塞运行 WebSocket 服务。
注册参数：无（全部来自配置或环境变量）。
默认：127.0.0.1:10095，模型目录 G:/SynLove-models/asrStreaming。
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.LogBus import bind, capture_stdio, install_excepthook  # noqa: E402
LOG = bind("asr", Path(__file__).resolve().parents[1])
capture_stdio("asr", Path(__file__).resolve().parents[1])
install_excepthook(LOG)
LOG.info("服务启动 runStreamingAsr.py")

from services.StreamingAsrServer import StreamingAsrServer


def load_config(root):
    """root 为项目根目录；返回语音配置字典，缺失时返回空字典。"""
    path = Path(root) / "config" / "voiceConfig.json"
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


if __name__ == "__main__":
    project = Path(__file__).resolve().parents[1]
    voice = load_config(project)
    relative_model = os.path.expandvars(voice.get("asrStreamingModel") or "")
    if relative_model and not os.path.isabs(relative_model):
        relative_model = str((project / relative_model).resolve())
    server = StreamingAsrServer(
        host=voice.get("asrStreamingHost", "127.0.0.1"),
        port=int(voice.get("asrStreamingPort", 10095)),
        model_dir=relative_model,
        threads=int(voice.get("asrStreamingThreads", 2)),
        endpoint_silence=float(voice.get("asrStreamingEndpointSilence", 1.2)),
    )
    print("model loaded:", server.model_dir, flush=True)
    server.serve_forever()
