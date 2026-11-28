# 新闻摘要（newsDigest）

每天抓一次新闻 + 热搜 → 去重 → 本机 Gemma 筛选改写 → QQ 主动推送。

## 一图流

```
本机 RSSHub :1200（/chinanews）        无浏览器，HTTP 拉 RSS
        ↓
newsDigest/sources/hotSource.py        微博热搜 + B站热搜（公开 API）
                                       + 知乎/36氪/酷安热榜（RSSHub）
        ↓
newsDigest/store/newsStore.py          SQLite 去重（runtime/newsDigest.db）
        ↓ 新出现的条目
newsDigest/filter/gemmaFilter.py       llama-server :8080（gemma-4-E4B）
        ↓
newsDigest/push/qqPush.py              QQ 主动消息（失败自动 is_wakeup 召回重试）
        ↓
runtime/news-digest.log                每次运行都有记录
```

> 已关闭浏览器采集：新闻走 RSSHub `/chinanews`，热点走公开 API + RSSHub。
> 微博/B站热搜在 RSSHub 里是 Playwright 路由，这里改用它们背后的公开 API（仍无浏览器）。

## 怎么用

| 场景 | 命令 |
|---|---|
| 手动跑一次 | `newsDigest\runDigest.cmd`（前台，能看到每一步） |
| 只生成不推送 | `newsDigest\runDigest.cmd --dry-run` |
| 临时多抓一些 | `newsDigest\runDigest.cmd --limit=80` |
| 定时（已注册） | 计划任务 **SynLoveNewsDigest**，每天 **08:55**（默认推 QQ） |

## 配置

`newsDigest/config/newsDigest.json`

- `interest`：关注画像（决定挑哪几条），改这里即可换口味；
- `maxItems` / `maxChars`：一条消息写几条、多少字；
- `sources`：列表页地址与抓取条数（默认中国新闻网滚动新闻，免登录）；
- `push.userOpenid`：QQ 收件人；
- `browser.profileDir`：**必须和 harness 的 browser-profile 分开**，否则两个进程会抢同一个浏览器 profile。

## 已知行为

- Gemma 空闲 120 秒会卸载模型（`--sleep-idle-seconds`，为了不长期占显存），
  **每天第一次跑要多等约 30 秒**，之后 1~3 秒；
- 没有新链接时**不推送**（避免重复打扰）；
- 推送失败会先退到 `is_wakeup`（长期静默时 QQ 官方的召回通道），仍失败就只记日志。
