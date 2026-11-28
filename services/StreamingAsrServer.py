"""流式 ASR 服务：基于 sherpa-onnx 的 WebSocket 实时识别服务。

功能：
- 监听本机 WebSocket 端口（默认 127.0.0.1:10095），接收 16kHz 单声道 16bit PCM 帧；
- 用 sherpa-onnx 流式模型做增量解码，边收边返回 partial 文本；
- 收到 `{"is_speaking": false}` 或检测到句尾时返回 final 文本，并重置本轮会话；
- 不保存原始音频，不改变模型权重。

注册参数（均来自 config/voiceConfig.json 或命令行）：
- host：监听地址，默认 127.0.0.1；
- port：监听端口，默认 10095；
- modelDir：模型目录，默认 PRODUCTION_ROOT/models/asrStreaming；
- threads：解码线程数，默认 2；
- endpointSilence：句尾静音秒数，默认 1.2。

协议：
1. 客户端可先发一条 JSON（内容忽略，兼容 FunASR 的 init 消息）；
2. 之后发送二进制 PCM 帧；
3. 服务端返回 {"text": "...", "mode": "2pass-online", "is_final": false}；
4. 句尾返回 {"text": "...", "mode": "2pass-final", "is_final": true}。
"""

import json
import os
import threading
import time

import numpy as np
import sherpa_onnx


class StreamingAsrServer:
    """sherpa-onnx 流式识别服务，支持多连接共用一份模型。"""

    def __init__(self, host="127.0.0.1", port=10095, model_dir=None, threads=2,
                 endpoint_silence=1.2, sample_rate=16000):
        """host/port 为监听地址；model_dir 为模型目录；threads 为解码线程；
        endpoint_silence 为句尾静音秒数；sample_rate 固定 16000。"""
        self.host = str(host)
        self.port = int(port)
        self.model_dir = str(model_dir or r"PRODUCTION_ROOT/models/asrStreaming")
        self.threads = int(threads)
        self.endpoint_silence = float(endpoint_silence)
        self.sample_rate = int(sample_rate)
        self.lock = threading.Lock()
        self.build_lock = threading.Lock()
        self.recognizer = None

    def _file(self, prefix):
        """prefix 为文件前缀；返回模型目录下匹配的唯一文件名。"""
        names = [name for name in os.listdir(self.model_dir)
                 if name.startswith(prefix) and name.endswith(".onnx")]
        if not names:
            raise FileNotFoundError("模型文件缺失：%s*" % prefix)
        names.sort(key=lambda name: ("int8" not in name, name))
        return os.path.join(self.model_dir, names[0])

    def _build(self):
        """无参数；加载流式 zipformer 模型并返回识别器。"""
        tokens = os.path.join(self.model_dir, "tokens.txt")
        if not os.path.isfile(tokens):
            raise FileNotFoundError("模型缺少 tokens.txt：" + self.model_dir)
        return sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tokens,
            encoder=self._file("encoder"),
            decoder=self._file("decoder"),
            joiner=self._file("joiner"),
            num_threads=self.threads,
            sample_rate=self.sample_rate,
            feature_dim=80,
            decoding_method="greedy_search",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=max(2.4, self.endpoint_silence + 1.2),
            rule2_min_trailing_silence=self.endpoint_silence,
            rule3_min_utterance_length=300,
        )

    def ensure_model(self):
        """无参数；按需加载流式模型，首次唤醒时才占用内存/CPU。"""
        if self.recognizer is not None:
            return self.recognizer
        with self.build_lock:
            if self.recognizer is None:
                started = time.monotonic()
                self.recognizer = self._build()
                print("streaming-asr model loaded in %.1fs" % (time.monotonic() - started),
                      flush=True)
        return self.recognizer

    def new_stream(self):
        """无参数；创建一条独立识别流。"""
        return self.ensure_model().create_stream()

    def feed(self, stream, pcm):
        """stream 为识别流；pcm 为 int16 小端字节；返回当前文本。"""
        if not pcm:
            return ""
        self.ensure_model()
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        with self.lock:
            stream.accept_waveform(self.sample_rate, samples)
            while self.recognizer.is_ready(stream):
                self.recognizer.decode_stream(stream)
            return self.recognizer.get_result(stream)

    def finish(self, stream):
        """stream 为识别流；补尾并返回最终文本。"""
        self.ensure_model()
        with self.lock:
            stream.input_finished()
            while self.recognizer.is_ready(stream):
                self.recognizer.decode_stream(stream)
            text = self.recognizer.get_result(stream)
            return text

    def endpoint(self, stream):
        """stream 为识别流；返回是否到达句尾。"""
        self.ensure_model()
        with self.lock:
            return bool(self.recognizer.is_endpoint(stream))

    def reset(self, stream):
        """stream 为识别流；清空本轮状态。"""
        self.ensure_model()
        with self.lock:
            self.recognizer.reset(stream)

    def serve_forever(self):
        """无参数；启动 WebSocket 服务并阻塞运行。"""
        from websockets.sync.server import serve

        with serve(self._handle, self.host, self.port, max_size=4 * 1024 * 1024) as server:
            print("streaming-asr listening ws://%s:%d model=%s (lazy)"
                  % (self.host, self.port, self.model_dir), flush=True)
            server.serve_forever()

    def _handle(self, ws):
        """ws 为单条连接；按协议收发帧，单连接一次只处理一轮会话。"""
        try:
            self.ensure_model()
            ws.send(json.dumps({"ready": True}, ensure_ascii=False))
        except Exception as error:
            print("streaming-asr load failed:", type(error).__name__, str(error)[:120],
                  flush=True)
            try:
                ws.close()
            except Exception:
                pass
            return
        stream = self.new_stream()
        last = ""
        try:
            for message in ws:
                if isinstance(message, str):
                    try:
                        event = json.loads(message)
                    except ValueError:
                        continue
                    if event.get("is_speaking") is False:
                        # 句尾必须回一条 final，即使文本与最后一个 partial 相同。
                        text = self.finish(stream)
                        ws.send(json.dumps({"text": text or "", "mode": "2pass-final",
                                            "is_final": True}, ensure_ascii=False))
                        self.reset(stream)
                        last = ""
                    continue
                text = self.feed(stream, message)
                if text != last:
                    last = text
                    ws.send(json.dumps({"text": text, "mode": "2pass-online",
                                        "is_final": False}, ensure_ascii=False))
                if self.endpoint(stream):
                    final = self.recognizer.get_result(stream)
                    if final and final != last:
                        ws.send(json.dumps({"text": final, "mode": "2pass-final",
                                            "is_final": True}, ensure_ascii=False))
                    self.reset(stream)
                    last = ""
        except Exception as error:  # 单连接异常不影响服务本身
            print("streaming-asr connection error:", type(error).__name__, str(error)[:120],
                  flush=True)
        finally:
            try:
                ws.close()
            except Exception:
                pass
