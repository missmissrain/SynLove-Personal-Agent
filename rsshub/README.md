# 本机 RSSHub（新闻/热榜数据源）

每天 08:55 的新闻摘要不再用浏览器抓页面，改成读**本机 RSSHub**（默认端口 1200）。
好处：没有验证码、没有登录态、解析稳定，一天几十次请求也不需要浏览器。

## 路的目录约定

```
rsshub/
├── install.py     # 一次性安装：clone 上游 + pnpm install + pnpm build
├── README.md
└── RSSHub/        # 上游开源项目（MIT），不进仓库，由 install.py 生成
    └── dist/index.mjs   # start_stack.py / guardService.py 认这个入口
```

## 安装

```bat
D:\py39\python.exe rsshub\install.py
```

脚本做三件事：`git clone`（已有则 `git pull`）→ `pnpm install` → `pnpm build`。
要求本机有 Node 20+ 与 pnpm（`npm i -g pnpm`）。国内网络不稳时可设置代理再跑。

## 跑起来

`start_stack.py` 启动时会调 `ensure_rsshub()`：端口 1200 没在监听、且
`rsshub/RSSHub/dist/index.mjs` 存在，就后台拉起（日志 `runtime/rsshub.log`，pid 记在 `runtime/rsshub.pid`）。
`tools/guardService.py` 每 60 秒复查一次，掉了就补。

手动启动：

```bat
cd rsshub\RSSHub
set PORT=1200
set NODE_ENV=production
node dist\index.mjs
```

## 新闻摘要用到的路由

| 路由 | 内容 |
|---|---|
| `/chinanews` | 中新网滚动新闻（日报主源） |
| `/zhihu/pin/hotlist` | 知乎热榜 |
| `/36kr/hot-list` | 36 氪热榜 |
| `/coolapk/hot` | 酷安热榜 |
| `/bilibili/popular/all` | B 站热门（也直接读官方公开 API） |

微博热搜、B 站热搜在 `newsDigest/sources/hotSource.py` 里走**官方公开 API**，不经过 RSSHub。

## 说明

- 只监听 `127.0.0.1`，不要暴露到公网；
- 上游是第三方项目，规则随平台改版会失效；某条路由 404 时新闻会跳过它并继续，
  不会把整份日报拖死（降级顺序见 `newsDigest/sources/rsshubSource.py`）。
