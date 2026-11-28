# 流式 ASR 与端侧 KWS 链路

## 一、链路总览

```text
终端麦克风
  → KeywordSpotter（sherpa-onnx 关键词检测，只在命中“欣爱”后录音）
  → ListeningStandby（保留 1.2s 预录，句尾静音结束）
  → 语音网关 http://127.0.0.1:8812/v1/voice/turn
  → VoicePipeline._transcribe
      ├─ 优先：ws://127.0.0.1:10095（sherpa-onnx 流式 ASR，2-pass）
      └─ 回退：http://127.0.0.1:18881/v1（whisper 文件上传）
  → 主人格 / TTS
```

## 二、流式 ASR 服务

- 端口：`127.0.0.1:10095`
- 入口：`scripts/runStreamingAsr.py`
- 实现：`services/StreamingAsrServer.py`
- 客户端：`services/StreamingAsrClient.py`（服务端）、`terminalConnection/client/StreamingAsrClient.py`（终端）
- 模型：`G:/SynLove-models/asrStreaming`（流式 zipformer zh 14M，int8）
- 计划任务：`SynLove-StreamingAsr`（SYSTEM，开机启动）

协议：

1. 客户端先发一帧 JSON（`mode=2pass`、`audio_fs=16000`）；
2. 之后发送 16kHz 单声道 16bit PCM 二进制帧；
3. 服务端返回 `{"text": "...", "mode": "2pass-online", "is_final": false}`；
4. 客户端发送 `{"is_speaking": false}`，服务端返回 `{"text": "...", "mode": "2pass-final", "is_final": true}`。

配置项（`config/voiceConfig.json`）：

```json
{
  "asrStreamingEnabled": true,
  "asrStreamingURL": "ws://127.0.0.1:10095",
  "asrStreamingModel": "G:/SynLove-models/asrStreaming",
  "asrStreamingHost": "127.0.0.1",
  "asrStreamingPort": 10095,
  "asrStreamingThreads": 2,
  "asrStreamingEndpointSilence": 1.2,
  "asrStreamingTimeoutSeconds": 60
}
```

流式失败不会挡住本轮语音：`VoicePipeline._transcribe` 会回退到 18881 的 whisper，并只在 `timings.asrStreaming` 标记是否走了流式。

## 三、端侧 KWS

- 实现：`terminalConnection/client/KeywordSpotter.py`
- 后端：sherpa-onnx `KeywordSpotter`（CPU，单线程）
- 模型目录：`G:/SynLove-models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`
- 关键词文件：同目录 `keywords.txt`

```text
x īn ài @欣爱
x iǎo ài @小爱
```

终端配置（`config/TerminalConfig.json`）：

```json
{
  "microphoneEnabled": true,
  "kws": {
    "wakeWord": "欣爱",
    "modelPath": "G:/SynLove-models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01",
    "threshold": 0.25,
    "preRollSeconds": 1.2,
    "silenceSeconds": 0.6,
    "cooldownSeconds": 1.5,
    "pauseSystemAudio": true
  }
}
```

没有模型或没有 `sherpa-onnx` 时，`kwsAvailable=false`、`kwsBackend=unconfigured`，终端明确报告未配置，不会偷偷回退成连续 ASR。

## 四、安卓端

- 依赖：`com.github.k2-fsa.sherpa-onnx:sherpa-onnx:v1.13.5`（JitPack）
- 模型：`app/src/main/assets/kws/`（int8 三个 onnx + tokens + keywords）
- 实现：`KeywordSpotter.java` 包装 `com.k2fsa.sherpa.onnx.KeywordSpotter`
- `VoiceSession` 在待命阶段只跑 KWS；命中后才进入 1.2s 预录与完整句录音，再提交网关。

## 五、验收

```text
1. 10095 监听：netstat -ano | findstr 10095
2. 流式自检：python scripts/runStreamingAsr.py（另开窗口）后用测试 wav 调 StreamingAsrClient
3. 终端状态：listening_status 应返回 kwsAvailable=true、kwsBackend=sherpa
4. 语音回合：timings.asrStreaming=true 表示走了流式
```


## 六、统一在场决策

`voiceRouting/ListeningRouteService.resolve()` 每轮把在场推理写进
`runtime/voiceRouting/presence.json`，同一份结论同时决定三件事：

| 字段 | 含义 |
|---|---|
| `listenTarget` | 哪台终端进入 KWS/ASR 待命 |
| `ttsTarget` | TTS 推到哪台设备；为空表示不推语音 |
| `speak` / `channel` | 是否推语音；`tts` 走设备外放，`qq` 走文字 |
| `state` | `resolved` / `uncertain` / `away` |

`AudioRoutePolicy.choose_route(..., presence=...)` 优先采用该结论：
`speak=true` 且目标在线可播放 → `tts`；否则 `qq`；`away` 不再追问设备。
主动观察（`ScreenPolicy`）和文字通道都走同一个入口，因此不会出现
“手机在听、声音却推到笔记本”这类分叉。

手机端实现 `audio.playback`：服务器按 16KB 分块推送 WAV，
`AudioSink` 写入私有缓存、同步播放并在结束后删除，只有真实 `played`
回执才算投送成功。
