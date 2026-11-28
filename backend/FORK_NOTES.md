# SynLove Backend Fork Notes

本文档记录 `backend/` 当前 vendored 的上游基线、SynLove 改动边界和可复现方式。

## 当前结论

- 上游基线来自 DeepSeek Harness `0.1.6-alpha.1`，包目录仍使用 `@deepseek-ai/dsh-*` 包名；`backend/package.json` 只是把工作区根包名改为 `synlove-backend`。
- 已建立长期 fork：`https://github.com/missmissrain/SynLove-DeepSeek-Harness-Fork`。
- fork 创建时上游 `master` 的可验证提交为 `8bd073392eef6f54e921a093b95076248eb08cbb`。发行快照旧记录中的短 SHA `0e3e35b` 当前无法由公开 GitHub 提交接口解析，不再用于重建定位。
- `backend/` 不是一个完整的上游源码 checkout。核心包（例如 `packages/core/agent`、`packages/llm/llm`）主要保留 `lib/` 编译产物、声明文件和包元数据，缺少对应的上游 `src/`。
- 仓库当前约有 1,897 个 `.js`、134 个 `.ts` 和 55 个 `.d.ts` 文件（不含 `backend/node_modules`）。这些数字是文件形态，不代表 1,897 个文件都是 SynLove 修改。
- 根 `backend/package.json` 当前只有 `start` 脚本，没有完整的 TypeScript 构建脚本。仓库外的 `tools/BuildWebhook.mjs` 只能把 SynLove 保留的 webhook TypeScript 转为 JS，不能重建整个 Harness。

因此，批评中的核心风险成立：**核心 vendored 产物不能仅凭本仓库完整重编译**。但“仓库里只有编译产物”不成立，因为 SynLove 的集成层仍保留了源码。

## SynLove 改动边界

相对最初引入 vendored Harness 的提交，当前主要改动集中在以下包：

| 包 | 作用 |
| --- | --- |
| `packages/webhook/webhook-weixin` | 微信连接器、主/子 Agent 任务运行时、结果润色、记忆工具、通知与会话桥接 |
| `packages/webhook/webhook-qq` | QQ 出站队列、远程状态队列、单消费者与发送链路 |
| `packages/webhook/tool-codex` | Codex 连接器适配 |
| `packages/webhook/tool-opencode` | OpenCode 连接器适配 |
| `packages/llm/llm` | 调用观测与请求关联字段 |
| `packages/mcp/mcp-client` | MCP 连接行为的兼容调整 |
| 根配置与启动层 | `config/agentTaskConfig.json`、提示词、`start_stack.py`、GUI 和服务解耦配置 |

`webhook-weixin`、`webhook-qq` 的关键改动有 `.ts` 源文件和生成后的 `lib/` 产物；核心 Harness 包的改动通常只有 `lib/` 产物，因为上游源码没有随本发行仓库保留。

## 依赖与运行

要求：

- Node.js `>=24`；
- 使用仓库内 `backend/package-lock.json`；
- 使用已有依赖目录时，直接运行 `npm ci --ignore-scripts`；需要联网时才执行。生产机不应把 `backend/node_modules` 提交到 Git；
- 启动入口是 `npm start`，等价于 `node apps/cli/lib/bin.js`；
- SynLove 的微信/QQ增量构建需要仓库根目录的 Node 工具：`node tools/BuildWebhook.mjs webhook-weixin webhook-qq`。

构建微信/QQ连接器时，`BuildWebhook.mjs` 使用 Node 内置 `stripTypeScriptTypes`，不安装 TypeScript，也不重建其他上游包：

```powershell
node tools/BuildWebhook.mjs webhook-weixin webhook-qq
```

## 完整重建边界

要重建 `packages/core/*`、`packages/llm/*` 或整个 Harness，需要：

1. 获取长期 fork，而不是依赖原始上游仍然在线：
   `https://github.com/missmissrain/SynLove-DeepSeek-Harness-Fork`；
2. 固定到 `8bd073392eef6f54e921a093b95076248eb08cbb`，或固定到后续经过验证的 fork 提交；
3. 把本仓库记录的 SynLove 改动逐项移植到上游源码；
4. 按上游 workspace 的构建方式生成新的 `lib/`；
5. 再用 SynLove 的测试和生产冒烟测试核对产物。

不能把 `npm run build` 写进当前根包就宣称完成全量重建；当前包内没有足够的核心 TypeScript 源码支持这种做法。

## 维护规则

- 升级上游版本前，先记录上游 commit/tag、Node/npm 版本和 lockfile 变化。
- 修改 `src/` 后必须重新生成对应 `lib/`，并运行 `tests/` 中的 Harness/Agent 回归测试。
- 修改只有 `lib/` 的上游包时，必须在提交说明里注明“无对应源文件，来自上游编译产物”。
- 不把 `backend/node_modules`、运行时数据库、密钥、服务器地址或真实会话提交到仓库。
