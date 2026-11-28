# 欣爱语音链路流式优化技能

## 用途

本技能负责检查和维护“端侧 KWS、流式 ASR、主人格确认、流式 TTS、音频回传”的低延迟语音链路。
保持已确认的 Breeze TTS 音色基线，不替换参考音频、参考文本、seed、cfgScale 或情绪提示词。

## 标准流程

1. 待命阶段只运行端侧 KWS 和低成本 VAD，不上传完整音频，不调用完整 ASR。
2. KWS 命中后立即保留环形预录音、启动后续录音，并发出 `wake_accepted` 探针。
3. 同时预热 ASR 连接，向流式 ASR 按 600ms 左右的 PCM 块发送音频。
4. ASR partial 结果只用于显示和提前判断，最终结果才提交给主人格。
5. 主人格返回确认文本时，立即转为同一轮情绪的 TTS；主人格继续执行原任务。
6. 主人格最终回复优先按自然句分段；流式 TTS 直接播放 PCM，非流式服务按首段优先合成。
7. 每轮返回延迟探针：KWS 命中、录音开始、ASR 首包、ASR 最终、主人格提交、主人格确认、主人格最终、TTS 预热、TTS 首块、首播和整轮完成。

确认文本通过 `POST /v1/voice/turn/stream` 的 NDJSON 返回，事件顺序允许为
`ack` → `ack_tts_ready` → `final`。收到 `ack` 后不得等待最终任务才播放；
`ack_tts_ready` 携带同一轮固定 Breeze 音色的音频，主人格任务在后台继续执行。

## 服务协议

- 流式 ASR 首选 FunASR `paraformer-zh-streaming` WebSocket。
- 旧 faster-whisper 文件上传接口只做回退，不得伪装成流式。
- Breeze 本地运行时使用 `FastBreezeStreamingRuntime.iter_audio_chunks`。
- 流式 TTS 返回 24kHz、单声道、16-bit PCM；播放器负责边收边播。
- 旧 `/v1/audio/speech` 完整 WAV 保留作为兼容回退。

## 探针约束

- 只记录阶段名、耗时、状态、模型能力和回退原因。
- 不记录原始音频、完整转写、Authorization、API key 或参考音频内容。
- 服务在线不等于模型已经加载；需要同时检查健康字段和首块耗时。
- 任何流式失败都必须保留可审计的回退状态，不能静默重复提交同一轮任务。
