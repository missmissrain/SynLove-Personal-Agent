# 语音流水线接口说明

说明本机网关如何接收音频、调用服务器 ASR、LLM、TTS，并返回正文与 TTS 提示词。

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
  "ttsPrompt": "happy",
  "audioPath": "runtime/voice/voice-session-001/output.wav",
  "audioFormat": "wav"
}
```

`reply` 是正文，`ttsPrompt` 仅为本轮情绪代码：neutral、happy、gentle、concerned、sad、excited。模型不能修改声音身份或参考音。非法值回退 neutral。

主人格可以在语音回复末尾追加：

```text
[[TTS_PROMPT]]gentle[[/TTS_PROMPT]]
```

网关移除内部标记并返回 `ttsPrompt`；未返回标记时使用 neutral。

## 固定音色

按 `config/voiceIdentity.example.json` 创建本机 `config/voiceIdentity.json`，填写经人工确认的参考 WAV 路径及逐字对应的 `refText`。示例中的空文本需要填写，不能原样用于生产。

每轮上传相同参考音字节、对应文本、seed 和 cfgScale；只有 instruction 中的情绪发生变化。TTS 服务必须设置 `dialect=breeze`，避免标准协议过滤掉克隆字段。缺少参考声时明确失败，不自动退回描述生成音色。参考声与配置由本地维护，不由模型生成。

固定参考条件用于约束说话人一致性，最终跨情绪的听感仍需在服务器空闲后试听验收。
