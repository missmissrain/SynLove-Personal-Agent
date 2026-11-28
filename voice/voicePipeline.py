"""欣爱语音会话流水线。

职责是把设备音频依次交给 ASR、人格化 LLM 和 TTS，并返回结构化结果。
该类不持有麦克风、不判断用户位置、不绑定某个设备，方便未来扩展多终端。
"""

from pathlib import Path
import time
import io
import wave

from services.ServiceClient import ServiceClient
from services.ServiceRegistry import ServiceRegistry
from voice.voiceAudioStore import VoiceAudioStore
from voice.voicePrompt import VoicePrompt
from voice.ttsPrompt import TtsPrompt
from voice.voiceIdentity import VoiceIdentity
from voice.wakeWordDetector import WakeWordDetector
from voice.wakeReplyCache import WakeReplyCache
from voice.LatencyProbe import LatencyProbe
from voice.ReplySegmenter import ReplySegmenter
from concurrent.futures import ThreadPoolExecutor
import threading


class VoicePipeline:
    """编排单轮唤醒、识别、理解和语音回复。"""

    def __init__(self, registry=None, detector=None, prompt=None, store=None, tts_prompt=None, identity=None, agent=None, cache=None):
        """各依赖可注入；identity固定音色，cache仅复用同一音色的固定唤醒应答。"""
        self.registry = registry or ServiceRegistry()
        self.detector = detector or WakeWordDetector()
        self.prompt = prompt or VoicePrompt()
        self.store = store or VoiceAudioStore()
        self.tts_prompt = tts_prompt or TtsPrompt()
        self.identity = identity or VoiceIdentity()
        self.agent = agent
        self.cache = cache if cache is not None else WakeReplyCache()
        self.wake_replies = self.cache.catalog
        self.segmenter = ReplySegmenter()

    def _wav_frames(self, path, chunk_ms=600):
        """path 为 WAV 文件；返回 (采样率, 帧生成器)，非 16k 单声道时返回 (0, None)。"""
        try:
            import wave
            handle = wave.open(str(path), "rb")
        except Exception:
            return 0, None
        rate = handle.getframerate()
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2 or rate != 16000:
            handle.close()
            return 0, None
        frames_per_chunk = max(1, int(rate * chunk_ms / 1000))

        def frames():
            """无参数；逐块产出 PCM 字节，结束后关闭文件。"""
            try:
                while True:
                    data = handle.readframes(frames_per_chunk)
                    if not data:
                        break
                    yield data
            finally:
                handle.close()

        return rate, frames

    def _transcribe(self, path, cfg):
        """path 为音频文件，cfg 为 ASR 配置；最终文本优先 whisper，流式只作回退。

        流式 14M 模型对短词/唤醒词准确率不足（实测把“欣爱”听成“恩儿”），
        因此完整上传的音频先走 18881 的 whisper；流式仅在 whisper 不可用时兜底。
        """
        if bool(cfg.get("streamingEnabled")) and cfg.get("streamingURL"):
            try:
                from services.StreamingAsrClient import StreamingAsrClient
                client = StreamingAsrClient(
                    cfg["streamingURL"],
                    timeout_seconds=float(cfg.get("streamingTimeoutSeconds") or 60))
                if client.available():
                    rate, frames = self._wav_frames(path)
                    if frames is not None:
                        result = client.transcribe(frames(), sample_rate=rate)
                        text = str(result.get("text") or "").strip()
                        if text:
                            return {"text": text, "streaming": True}, True
            except Exception:
                pass
        return ServiceClient(cfg).transcribe(path, language="zh"), False

    def process_audio(self, audio_path, session_id="default", device_id="local",
                      follow_up=False, on_event=None):
        """audio_path 为设备音频路径；返回唤醒状态、文本、回复和 TTS 文件路径。"""
        path = Path(audio_path)
        if not path.is_file():
            raise FileNotFoundError("语音输入不存在：" + str(path))
        probe = LatencyProbe("voice_turn")
        probe.mark("recording_uploaded")
        start = time.monotonic()
        asr_cfg = self.registry.get_service("asr")
        asr, asr_streaming = self._transcribe(path, asr_cfg)
        probe.mark("asr_final")
        timings = {"asrSeconds": round(time.monotonic() - start, 3),
                   "asrStreaming": asr_streaming}
        transcript = str(asr.get("text") or "").strip()
        wake = self.detector.detect(transcript)
        if follow_up:
            wake = {"wake": True, "keyword": wake["keyword"],
                    "command": wake["command"] if wake["wake"] else transcript}
        result = {
            "ok": True,
            "deviceId": str(device_id),
            "sessionId": str(session_id),
            "transcript": transcript,
            "wake": bool(wake["wake"]),
            "keyword": wake["keyword"],
            "command": wake["command"],
            "timings": timings,
        }
        if not wake["wake"]:
            result["state"] = "waiting_for_wake_word"
            result["latencyProbe"] = probe.snapshot()
            return result
        probe.mark("wake_accepted")
        command = wake["command"]
        tts_config = self.registry.get_service("tts")
        if tts_config.get("dialect") != "breeze":
            raise ValueError("固定音色克隆要求 TTS 服务配置 dialect=breeze")
        # 先验证参考声，避免缺配置时仍占用 LLM 或服务器显卡。
        self.identity.build_options(self.tts_prompt.DEFAULT)
        tts_client = ServiceClient(tts_config)
        # 健康请求与主人格请求并行，先把TTS连接和服务状态预热，不生成错误音频。
        prewarm = None
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="SynLoveVoice") as pool:
            if hasattr(tts_client, "health"):
                prewarm = pool.submit(tts_client.health)
            if not command:
                selected = self.wake_replies.select_reply(device_id)
                reply = selected["text"]
                tts_prompt = selected["emotion"]
                timings["agentSeconds"] = 0
            else:
                mark = time.monotonic()
                answer = self._ask_agent(command, session_id, on_ack=(
                    lambda event, elapsed: self._handle_agent_ack(
                        event, elapsed, session_id, device_id, probe, on_event)))
                timings["agentSeconds"] = round(time.monotonic() - mark, 3)
                reply = answer["text"]
                tts_prompt = answer["ttsPrompt"]
            probe.mark("agent_reply_ready")
            if prewarm is not None:
                try:
                    prewarm.result(timeout=3)
                    probe.mark("tts_prewarm", "ok")
                except Exception:
                    probe.mark("tts_prewarm", "fallback")
        spoken = self.process_reply_segments(
            {"text": reply, "ttsEmotion": tts_prompt},
            session_id, device_id, probe=probe,
        )
        timings.update(spoken.pop("timings"))
        result.update(spoken)
        timings["gatewaySeconds"] = round(time.monotonic() - start, 3)
        result["latencyProbe"] = probe.snapshot()
        return result

    def process_reply_segments(self, reply, session_id="default", device_id="local", probe=None):
        """reply为主人格下行；按自然句合成并返回首段路径与全部音频段。"""
        answer = self.tts_prompt.parse(reply)
        parts = self.segmenter.split(answer["text"]) or [answer["text"]]
        paths = []
        segment_results = []
        started = time.monotonic()
        for index, part in enumerate(parts):
            item = self.process_reply(
                {"text": part, "ttsEmotion": answer["ttsPrompt"]},
                session_id, device_id,
                probe=probe,
            )
            paths.append(item["audioPath"])
            segment_results.append({
                "index": index,
                "text": part,
                "audioPath": item["audioPath"],
                "audioFormat": item["audioFormat"],
            })
            if probe and index == 0:
                probe.mark("tts_first_segment")
        if probe:
            probe.mark("tts_all_segments")
        return {
            **segment_results[0],
            "ok": True,
            "deviceId": str(device_id),
            "sessionId": str(session_id),
            "state": "replied",
            "reply": answer["text"],
            "ttsEmotion": answer["ttsPrompt"],
            "ttsPrompt": answer["ttsPrompt"],
            "audioPath": paths[0],
            "audioPaths": paths,
            "audioSegments": segment_results,
            "timings": {
                "ttsSeconds": round(time.monotonic() - started, 3),
                "segmentCount": len(segment_results),
            },
        }

    def process_reply(self, reply, session_id="default", device_id="local", probe=None):
        """reply 为主人格下行；session_id、device_id 标识会话与终端；只按本机固定声线合成。"""
        answer = self.tts_prompt.parse(reply)
        reply = answer["text"]
        tts_prompt = answer["ttsPrompt"]
        tts_config = self.registry.get_service("tts")
        if tts_config.get("dialect") != "breeze":
            raise ValueError("固定音色克隆要求 TTS 服务配置 dialect=breeze")
        options = self.identity.build_options(tts_prompt)
        mark = time.monotonic()
        cached = self.cache.cache_path(reply, tts_prompt, options)
        audio = self.cache.read_audio(cached)
        hit = audio is not None
        fmt = "wav"
        if not hit:
            if tts_config.get("streamingEnabled") is True:
                audio, fmt = self._synthesize_stream_to_wav(
                    ServiceClient(tts_config), reply, options, probe=probe)
            else:
                audio, fmt = ServiceClient(tts_config).synthesize(reply, **options)
            if fmt == "wav":
                try:
                    self.cache.save_audio(cached, audio)
                except OSError:
                    pass  # 可选缓存写入失败仍交付真实合成音频。
        output = self.store.save_output(audio, session_id, "." + fmt)
        return {
            "ok": True,
            "deviceId": str(device_id),
            "sessionId": str(session_id),
            "state": "replied",
            "reply": reply,
            "ttsEmotion": tts_prompt,
            "ttsPrompt": tts_prompt,
            "audioPath": str(output),
            "audioFormat": fmt,
            "timings": {"ttsSeconds": round(time.monotonic() - mark, 3), "wakeCacheHit": hit},
        }

    def _synthesize_stream_to_wav(self, client, text, options, probe=None):
        """client为支持流式的TTS客户端；把PCM增量封装成兼容现有播放器的WAV。"""
        chunks = []
        def on_chunk(chunk):
            """chunk为TTS服务返回的一段PCM字节；首次收到时记录真正的首块探针。"""
            if probe is not None and not chunks:
                probe.mark("tts_first_chunk")
            chunks.append(chunk)
        result = client.synthesize_stream(text, on_chunk=on_chunk, **options)
        pcm = b"".join(chunks)
        sample_rate = int(result.get("sampleRate") or 24000)
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(sample_rate)
            writer.writeframes(pcm)
        return output.getvalue(), "wav"

    def _ask_agent(self, command, session_id, on_ack=None):
        """command为去掉唤醒词的用户指令；on_ack接收主人格首个确认事件。"""
        if self.agent is not None:
            if on_ack and hasattr(self.agent, "ask_agent_stream"):
                return self.tts_prompt.parse(
                    self.agent.ask_agent_stream(command, session_id, on_ack=on_ack))
            return self.tts_prompt.parse(self.agent.ask_agent(command, session_id))
        payload = {
            "messages": [
                {"role": "system", "content": self.prompt.load()},
                {"role": "user", "content": command},
            ],
            "temperature": 0.7,
            "max_tokens": 512,
            "stream": False,
            "metadata": {"channel": "voice", "sessionId": str(session_id)},
        }
        response = ServiceClient(self.registry.get_service("llm")).chat(payload)
        choices = response.get("choices") or []
        if not choices:
            raise ValueError("LLM 没有返回 choices")
        message = choices[0].get("message") or {}
        content = str(message.get("content") or "").strip()
        if not content:
            raise ValueError("LLM 没有返回文本")
        return self.tts_prompt.parse(content)

    def _handle_agent_ack(self, event, elapsed, session_id, device_id, probe, on_event=None):
        """event为主人格确认事件；异步把确认文本转为TTS，不阻塞主人格继续处理。"""
        text = str(event.get("reply") or event.get("text") or event.get("message") or "").strip()
        if not text:
            return
        if probe:
            probe.mark("agent_ack_received")
        if on_event:
            on_event({
                "type": "ack",
                "text": text,
                "ttsEmotion": event.get("ttsEmotion", "gentle"),
                "elapsedSeconds": elapsed,
            })
        def synthesize_ack():
            """无参数；后台合成主人格首个确认语音。"""
            try:
                item = self.process_reply(
                    {"text": text, "ttsEmotion": event.get("ttsEmotion", "gentle")},
                    session_id, device_id, probe=probe)
                if probe:
                    probe.mark("agent_ack_tts_ready")
                if on_event:
                    on_event({
                        "type": "ack_tts_ready",
                        "text": text,
                        "ttsEmotion": item.get("ttsEmotion"),
                        "audioPath": item.get("audioPath"),
                        "audioFormat": item.get("audioFormat"),
                    })
            except Exception:
                if probe:
                    probe.mark("agent_ack_tts_failed", "fallback")
                if on_event:
                    on_event({"type": "ack_tts_failed", "text": text})

        threading.Thread(target=synthesize_ack, daemon=True,
                         name="SynLoveAgentAckTts").start()
