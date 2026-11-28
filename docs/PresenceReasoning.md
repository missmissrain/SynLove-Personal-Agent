# 在场推理：状态刻画 + 漂移触发的临时会话

本文说明「主人现在在哪台设备旁」这套判断是怎么做的、数据从哪来、什么时候才会调用模型，以及如何排查与回滚。

## 1. 为什么不是纯规则

设备侧能拿到的信号很多：三台 Windows 终端的锁屏/亮屏、键鼠空闲、前台应用、音频输出与蓝牙媒体，手机的亮屏/锁屏/电量/充电、前置摄像头是否有人、粗定位，再加上画像里的作息。

规则打分能覆盖常见情况，但「人在电脑前却戴着手机耳机」「手机在包里充电但人已经出门」「深夜作息段但正在加班」这类组合，规则要么写不完，要么互相打架。所以这里把判断交给一次临时会话，规则只作为兜底。

代价是 token 和时延，因此拆成两层：**常驻只采集不算**，**差距足够大才推理**。

## 2. 两层结构

```
每 12 秒（不调用模型）
  采集三台设备状态 ──► 覆写 current.json
        │
        ├─ 与 lastReasoned.json（上次推理时的快照）比较
        ├─ 得到漂移分 0~1 与变化原因
        └─ 漂移 ≥ 0.45 且预算允许？
                 │ 是
                 ▼
      起一次临时会话（无记忆、无工具、store=false）
                 │
                 ├─ 严格校验输出（白名单/在线/字段/长度）
                 ├─ 通过 → 覆写 reasoning.json，决策有效期 600s
                 └─ 失败 → 立即回退规则打分，不重试、不缓存坏结论

每 30 秒
  ListeningRouteService.refresh()
        ├─ 有可用 agent 决策 → 直接采用（reason 以 agent: 开头）
        └─ 没有/已过期        → 原来的规则打分
        └─ 给目标发 listening_start，其余发 listening_stop
```

口径：**同一时刻只有一台设备在监听**。

## 3. 第一层：状态刻画

采集频率与字段：

| 模态 | 字段 | 频率 | 说明 |
|---|---|---|---|
| 在线 | `online` `lastSeenAgoSeconds` | 每轮 | 心跳时间 |
| 屏幕 | `locked` `interactive` `idleSeconds` `foregroundApp` | 每轮 | 三台 Windows 终端的 `screen.observe` |
| 音频 | `audioPrivate` `bluetoothMediaOutput` `bluetoothHeadphonesConnected` | 每轮 | 是否耳机/蓝牙媒体输出 |
| 监听 | `listening` | 每轮 | 该设备是否处于 armed |
| 电量 | `batteryLevel` `charging` | 300s | 手机 `device.probe` |
| 音频路由 | `audioRoute` `bluetoothAudio` `musicActive` `callMode` | 30s | 手机 `audio.route`（speaker/bluetooth/wired/usb） |
| 地点 | `place` `personPlace` | 每轮（定位 180s） | 手机定位 + 已登记地点库 |
| 镜头 | `cameraPresent` `cameraFaces` | 90s | 手机前置摄像头人脸检测，**只回人数，不保存图像** |
| 定位 | `lat` `lon` `accuracy` `ageSeconds` | 600s | 只读系统最近一次定位，坐标保留 4 位小数（约 11 米） |
| 作息 | `scheduleBand` `profileSchedule` | 每轮/10 分钟 | 本地作息段 + 画像图谱作息 |

镜头不是每轮都看：只有手机可能就在人手里（它是当前监听目标，或电脑已安静 ≥180 秒）才采样一次，避免无意义占用摄像头。

落盘只有三个文件，**全部覆写**，不追加历史：

| 文件 | 内容 |
|---|---|
| `runtime/presenceState/current.json` | 最新快照 + `changes`（本轮相对基线的事实变化） |
| `runtime/presenceState/lastReasoned.json` | 上一次推理时的快照（漂移基线） |
| `runtime/voiceRouting/reasoning.json` | 最近一次判定的决策、理由、漂移、耗时 |

## 4. 漂移：怎么比、阈值多少

基线是 `lastReasoned.json`，只在真正触发推理时更新，所以两次推理之间的变化会一直累计在 `current.json.changes` 里，不会被轮询冲掉。

逐项比较（加性，单项直接相加，最后截断到 1.0）：

| 项目 | 判据 | 权重 |
|---|---|---|
| 首次（无基线） | 基线不存在 | 1.00 |
| 在线 | 布尔变化 | 0.50 |
| 能力集 | 集合变化 | 0.25 |
| 锁屏 | 布尔变化 | 0.35 |
| 亮屏/交互 | 布尔变化 | 0.30 |
| 空闲时长 | 跨档 `[30,120,300,900,1800]` 秒 | 0.20 |
| 前台应用 | 字符串变化 | 0.15 |
| 蓝牙媒体输出 | 变化 | 0.25 |
| 私密输出 | 变化 | 0.20 |
| 镜头有人/无人 | 布尔变化 | 0.50 |
| 位置移动 | ≥200m / ≥1000m | 0.60 / 0.90 |
| 监听状态 | 布尔变化 | 0.20 |
| 作息段 | 变化 | 0.25 |
| 基线过旧 | 距上次推理 ≥1800s | 0.30 |

触发条件：`漂移分 ≥ 0.45` 且预算允许（距上次 ≥60s、每小时 ≤20 次）。另外，决策有效期 600s，过期后即使没有变化也会重新判定一次，避免一直沿用旧结论。

## 5. 第二层：临时会话

- 输入：裁剪到 6000 字符以内的结构化快照（`devices` 只含可监听设备，`otherDevices` 为不可开麦的旁证设备）
- 提示词：`prompts/PresenceReasoning.md`
- 调用：复用 `config/modelConfig.json` 登记的模型，`store=false`，单轮、无工具、不写长期记忆
- 输出：严格 JSON（`target` / `confidence` / `activity` / `reasonCode` / `reasoning` / `exclude`）
- 校验：目标必须在 `listenDevices` 内且在线；有目标时 `activity` 只能是 `atDevice`/`nearby`；理由不超过 120 字
- 失败：超时、格式错、越权设备、离线设备一律视为失败，**立即回退规则**，并写 `reasoning.json` 的 `failed` 与 `error`

## 6. 与监听路由的衔接

`ListeningRouteService.resolve()` 的顺序：

1. 有未过期的 agent 决策，且目标在「在线 + 有 `audio.capture` + 在 `listenDevices`」集合内 → 直接采用，`reason` 为 `agent:<reasonCode>`，`source=agent`
2. 决策说 `awayFromComputers` → 判定为 `uncertain`，停掉所有监听
3. 其余情况 → 走原规则打分（`recentInput`、`recentlyUsedKeepListening`、`mobileWhenNoComputerActivity` 等）

`presence.json` 与 `listening.json` 会同步反映当前来源，便于确认到底是谁在决定。

## 7. 排查

| 现象 | 看哪里 |
|---|---|
| 一直没推理 | `current.json.changes` 与 `at`：漂移是否 ≥0.45；`reasoning.json.at` 是否很久没变 |
| 推理失败 | `reasoning.json` 的 `failed` / `errorType` / `error` |
| 推理成功但没切 | `listening.json.reason` 是否 `agent:` 开头；目标是否在线 |
| 频繁推理 | 预算 20 次/小时是否打满；`changes` 里是否同一项反复跳 |

## 8. 上线与回滚

- 上线：重启 `SynLove-VoiceGateway` 计划任务即可，`StateMonitor` 随网关启动
- 关闭：`config/presenceReasoning.json` 里 `enabled=false`（或删掉该文件），路由自动退回规则
- 回滚：`备份/SynLove-Personal-Agentv2.2/` 内有改动前的文件与说明

## 9. 已知限制

- 手机若因中转链路掉线，摄像头与定位两路会缺失；此时推理会明确写「手机离线，不能作为监听目标」
- 单次判定耗时约 2~17 秒（取决于模型），期间路由用规则兜底，不会出现「叫了没反应」，但切设备会慢一拍
- 漂移是加性阈值，强证据与多弱证据叠加不区分；后续如需更细的灵敏度可按 `config/presenceReasoning.json` 的 `weights` 调整
