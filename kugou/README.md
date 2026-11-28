# 酷狗音乐控制（KuGouMusicApi + 点播）

使用 `KuGouMusicApi` 搜索和解析曲目，通过 SynLove-Terminal-Connection 在指定设备播放。服务器维护曲目队列，终端维护播放器进程与音频设备。

## 服务器控制指定电脑播放

酷狗解析与扬声器可以分处两台设备。服务器运行音乐 MCP，被控电脑安装 SynLove-Terminal-Connection 客户端，通过 VPS 的签名终端协议接收播放操作，不需要运行 SynLove 主程序或 GUI。

将 `kugou/config/playback.example.json` 复制为私有 `config/musicPlayback.json`，配置：

| 字段 | 含义 |
| --- | --- |
| `mode` | 兼容已有配置；实际播放统一通过终端接口 |
| `target` | 设备管理或 `terminal_devices` 返回的已配对设备 ID |
| `transport` | 使用 `terminal`，通过主程序私有桥接配置访问终端管理器 |
| `volume` | 播放音量，0至100，默认35 |

未填写 `target` 时使用桥接配置的 `serverDeviceId`，仍经终端接口播放；目标设备需要运行终端客户端。终端配置缺失时搜歌和登录工具仍可加载，播放控制明确返回失败。私有配置不提交仓库，修改后需重新加载音乐MCP。

服务器仍负责歌单和逐首取地址，本机接收器统一维护播放器进程及实际播放状态。控制使用播放ID核对归属；目标离线明确失败，不自动在服务器出声。音乐MCP会等待本机音频时钟前进再报告正在播放；超时提示先查状态，避免重复点播。

长歌单自动连播需要服务器音乐MCP保持运行；服务器MCP退出不会自动终止本机已开始的歌曲，但后续逐首解析不会继续。电脑未登录、关机或休眠时不保证播放。接入细节及默认回环端口见远控仓库说明。

## 目录

```
kugou/
├── KuGouMusicApi/          # 上游开源项目（MIT，需自行 clone + npm install，不进仓库）
├── config/kugou.json       # API 端口、音质、限速、缓存、冷却
├── config/auth.example.json# 登录凭据模板（token/userid/mid）
├── config/auth.json        # 真实凭据，扫码后自动生成（.gitignore 已挡）
├── client/kugouApi.py      # API 客户端：串行限速、TTL 缓存、失败冷却、dfid 持久化
├── client/MusicQueue.py    # 服务器曲目队列与补页
├── client/RemoteMusicPlayback.py # 独立终端API适配器
├── tools/kugouLogin.py     # 扫码登录助手
├── mcp/kugouMcp.py         # 给欣爱的工具（MCP stdio）
└── README.md
```

## 安装上游 API

```bat
cd kugou
git clone https://github.com/MakcRe/KuGouMusicApi.git
cd KuGouMusicApi
npm install
```

播放设备需要 `ffplay`（FFmpeg 提供），在终端仓库的私有配置中设置可执行路径或加入该设备的 `PATH`。音乐MCP所在服务器不需要音频设备。

## 启动

API 由 `kugouApi.ensure_server()` 懒启动（第一次调用工具时自动拉起，端口 3001）。
手动启动：

```bat
cd kugou\KuGouMusicApi
set PORT=3001
set HOST=127.0.0.1
node app.js
```

## 登录（一次性）

VIP/付费歌需要登录才能取到播放地址；音乐包账号（is_vip=0）同样可用。运行：

```bat
python kugou\tools\kugouLogin.py --qr
```

二维码保存到 `runtime\kugou-login-qr.png`，用酷狗 App 扫码确认后，
`token/userid` 自动写到 `kugou\config\auth.json`（之后热重载，不用重启）。

也可以手动导入：

```bat
python kugou\tools\kugouLogin.py --cookie "token=...; userid=..."
```

## 给欣爱的工具

| 工具 | 用途 |
|---|---|
| `kugou_search` | 搜歌（歌名/歌手/hash） |
| `kugou_play` | 点歌并立即播放 |
| `kugou_playlists` | 查看登录账号的歌单 |
| `kugou_playlist_tracks` | 查看歌单里有哪些歌 |
| `kugou_play_playlist` | 播放整个歌单（逐首取地址、自动连播） |
| `kugou_control` | play / pause / next / prev / stop |
| `kugou_status` | 服务、登录、当前曲目 |
| `kugou_login` | 生成登录二维码 |

## 反风控（参考 N.E.K.O）

- 请求串行 + 最小间隔 1 秒；
- 搜索结果缓存 60 秒、播放地址缓存 10 分钟；
- 失败进入 30 分钟冷却，避免反复打接口；
- `dfid`（设备指纹）持久化；遇到"本次请求需要验证"自动刷新并重试一次；
- 去重（同歌名+歌手只留一条）；
- 登录凭据按文件 mtime 热重载；
- **cookie 必须原样拼进 URL（不能 URL 编码）**：服务端按 `;` 切分，编码后会报"本次请求需要验证"；
- **取地址默认 `quality=flac`（无损）**；`album_audio_id` 必须传 `0` 才会返回真 flac，
  传搜索里的 Audioid 会被降级成 mp3（实测）；
- flac 不可用时自动降级 `320 → 128`，回复里会标注实际格式（无损 / mp3）。

## 说明

- 歌单播放是**逐首**请求 `/song/url`（每首间隔 ≥1 秒、按页补充），不会批量请求；
- 上游 API 是**元数据/播放地址**服务，不能命令酷狗桌面客户端播放指定歌曲；
  所以"点歌"用 API 取地址 + 本地播放器播放（ffplay），"切歌/暂停"由欣爱管理队列。
- 酷狗客户端里正在播放时，也可以用媒体键技能做传输控制（`windows-media-key-playback-control`）。
- 已移除 GUI 截图点击路线，避免路由冲突。
