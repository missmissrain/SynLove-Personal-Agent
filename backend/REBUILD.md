# Backend 重建与依赖说明

## 开箱运行

在 `backend/` 目录执行：

```powershell
npm ci --ignore-scripts
npm start
```

Node.js 版本要求 `>=24`。`package-lock.json` 已锁定 workspace 依赖；生产环境优先复用已验证的 Node 和 `node_modules`，避免无必要地重新下载依赖。

## SynLove 集成层增量构建

在生产仓库根目录执行：

```powershell
node tools/BuildWebhook.mjs webhook-weixin webhook-qq
```

该命令只编译：

- `backend/packages/webhook/webhook-weixin/src/**/*.ts`
- `backend/packages/webhook/webhook-qq/src/**/*.ts`

输出到对应的 `lib/types/`。它不会重建上游 Harness 核心包。

## 完整 Harness 重建

当前发行仓库没有包含完整上游 TypeScript 源码，因此不能在这里独立完成核心包的全量编译。完整重建必须准备：

- `SynLove-DeepSeek-Harness-Fork` 中保存的 DeepSeek Harness 完整 monorepo；
- 上游 workspace 的源码、构建工具和锁文件；
- 当前仓库的 `backend/FORK_NOTES.md` 中列出的 SynLove 补丁；
- Node.js `>=24` 和与上游匹配的 npm 版本。

建议流程：

1. 在隔离目录 clone 长期 fork，并固定到已验证的提交：

   ```powershell
   git clone https://github.com/missmissrain/SynLove-DeepSeek-Harness-Fork.git
   cd SynLove-DeepSeek-Harness-Fork
   git checkout 8bd073392eef6f54e921a093b95076248eb08cbb
   ```

   如果该提交已经通过后续 fork 提交替换，必须把新的提交写入 `FORK_NOTES.md` 后再继续。
2. 应用 SynLove 补丁或将当前 `src/` 集成层复制到对应 workspace。
3. 按上游脚本构建全部 workspace。
4. 将生成的 `lib/` 作为候选产物放入隔离测试目录。
5. 先运行 Agent/任务/MCP 回归测试，再切换生产目录。

不要直接在生产 `backend/` 目录执行未知的上游升级或 `npm update`；这会改变锁定版本并可能重新引入第二个 Harness 实例。
