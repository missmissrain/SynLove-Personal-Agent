# 语音流水线接口说明

说明本机网关如何接收音频、调用端侧KWS、流式ASR、LLM、流式TTS，并返回正文与 TTS 提示词。

# 语音流水线接口

本机网关默认监听 `127.0.0.1:8812`。

## 请求

```text
POST /v1/voice/turn
Content-Type: audio/wav
X-Device-Id: tianxuan
X-Session-Id: voice-session-001
X-Audio-Name: input.wav
```

请求体是原始音频字节。网关只负责当前轮处理，不判断用户所在位置。

## 返回

唤醒词未命中时：

```json
{
  "ok": true,
  "state": "waiting_for_wake_word",
  "deviceId": "tianxuan",
  "sessionId": "voice-session-001",
  "transcript": "嗯 我在",
  "wake": false,
  "keyword": "",
  "command": "嗯 我在"
}
```

唤醒词命中并完成回复时：

```json
{
  "ok": true,
  "state": "replied",
  "deviceId": "tianxuan",
  "sessionId": "voice-session-001",
  "transcript": "欣爱 帮我记住今天开会",
  "reply": "好呀，我记住啦。",
  "ttsEmotion": "happy",
  "ttsPrompt": "happy",
  "audioPath": "runtime/voice/voice-session-001/output.wav",
  "audioFormat": "wav"
}
```

`reply` 是正文，`ttsPrompt` 仅为本轮情绪代码：neutral、happy、gentle、concerned、sad、excited。模型不能修改声音身份或参考音。非法值回退 neutral。

主人格每轮最终回复必须同时提供正文与本轮情绪：

```json
{"text": "好呀，我记住啦。", "ttsEmotion": "happy"}
```

`VoicePipeline.process_reply(reply, session_id, device_id)` 接受这份下行对象，直接进行固定声线合成，不再调用一次 LLM。生产语音入口通过回环8813的`VoiceTurnBridge`提交到现有主人格共享会话，复用其工具、记忆及模型通道；语音回合不再通过微信或QQ重复推送。结果返回 `ttsEmotion`，保留同值的 `ttsPrompt` 兼容旧终端。情绪缺失或非法时按 neutral 合成，任何声线覆盖字段都会被忽略。

## 流式链路

待命终端只运行端侧 `KeywordSpotter`，不再用完整ASR猜测唤醒词。KWS 命中后保留约1.2秒环形预录音，立即通知上层预热ASR并继续录音；句尾才提交最终音频。

服务器ASR配置 `asrStreamingURL` 后使用 FunASR WebSocket 2-pass 会话，默认块大小约600ms；partial只用于显示和提前判断，最终文本才进入主人格。未配置或连接失败时回退旧的文件上传ASR。

Breeze服务的 `/v1/audio/speech` 支持在请求体加入 `stream=true` 和 `stream_format=audio`，返回 24kHz、单声道、16-bit PCM。`ServiceClient.synthesize_stream`负责边收边处理；播放器不支持PCM时，`VoicePipeline`封装为WAV回退。

主人格若返回 `ack`/`accepted`事件，`PrimaryAgentClient`会先把确认文字交给TTS，后台继续等待主人格最终任务结果。最终回复按自然句分段，返回`audioSegments`供终端按顺序播放。

## 延迟探针

每轮结果带`latencyProbe`，只含阶段名、耗时和状态，不含原始音频、完整转写或令牌。阶段包括：

`recording_uploaded`、`wake_accepted`、`asr_final`、`agent_ack_received`、`agent_reply_ready`、`tts_prewarm`、`tts_first_segment`、`tts_all_segments`。

探针用于区分KWS、ASR、主人格、模型加载、TTS首块和传输问题；服务在线但模型未加载时，以首块耗时和`tts_prewarm`状态为准。

情绪选择规则位于`prompts/VoiceInteraction.md`，六种实际合成表达位于`prompts/TtsDelivery.json`。选择依据是欣爱本轮的表达，而不是直接复制用户的心情；例如安慰低落的用户通常使用gentle。固定参考声参数保持不变。

仅唤醒时从`prompts/WakeReplies.json`读取六种简短应答，使用gentle，并通过`WakeReplyCache`保留各句已合成WAV。`WakeReplyCatalog`为每个收音设备分别打乱轮换，每轮覆盖清单，跨轮也避免连续重复；进程重启后重新开始轮换。部署时应先按生产固定音色预生成全部应答，确认缓存完整再刷新入口，避免用户首次唤醒等待生成。

缓存键包含完整声线与表达输入，配置变化后自动失效；普通对话不缓存。返回的`timings`区分ASR、主人格、TTS耗时及唤醒缓存命中状态，中继另行添加上传、排队和电脑路由计时。缓存命中速度不能当作普通问答的生成速度。

旧版主人格在语音回复末尾追加的以下格式仍兼容：

```text
[[TTS_PROMPT]]gentle[[/TTS_PROMPT]]
```

网关移除内部标记并返回 `ttsPrompt`；未返回标记时使用 neutral。

## 固定音色

按 `config/voiceIdentity.example.json` 创建本机 `config/voiceIdentity.json`，填写经人工确认的参考 WAV 路径及逐字对应的 `refText`。示例中的空文本需要填写，不能原样用于生产。

每轮上传相同参考音字节、对应文本、seed 和 cfgScale；只有 instruction 中的情绪发生变化。TTS 服务必须设置 `dialect=breeze`，避免标准协议过滤掉克隆字段。缺少参考声时明确失败，不自动退回描述生成音色。参考声与配置由本地维护，不由模型生成。

固定参考条件用于约束说话人一致性，最终跨情绪的听感仍需在服务器空闲后试听验收。
### 主人格确认与后台任务

终端需要尽快得到“收到/正在处理”等确认语音时，使用 `POST /v1/voice/turn/stream`。
网关以 NDJSON 逐行返回事件：

- `ack`：主人格已接收任务，包含确认文本和情绪；
- `ack_tts_ready`：确认文本已经使用固定 Breeze 音色合成，包含 `audioBase64`；
- `final`：主人格继续处理后的最终回复，包含原有 `audioBase64` / `audioSegments`；
- `error`：本轮失败信息。

`ack` 和 `ack_tts_ready` 到达后，主人格线程仍会继续运行，不会因为先播报确认语音而取消原任务。
旧的 `/v1/voice/turn` 保留，用于不支持流式 HTTP 的终端。

