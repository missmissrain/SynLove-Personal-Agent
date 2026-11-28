# SynLove 轻量观测

更新日期：2026-10-30。

## 采集与界面

控制台的“调用链”支持会话、模型、trace、状态和版本筛选，并展示真实父子关系、延时、用量和失败。“运行趋势”展示自动采集的耗时、错误率、Token 和成本估算，按模型、人格或系统指纹和工具版本比较窗口。

模型成功返回不代表回答正确。统计告警不自动阻止部署，不代表受控 A/B 实验；GUI 不提供人工评分入口。

配置入口为 `config/observationConfig.json`。日志默认位于探针目录的 `observations.jsonl`；没有观测或探针路径时关闭采集。可用 `DSH_OBSERVATION_LOG` 指定路径，`DSH_OBSERVATION_ENABLED=0` 关闭。

每份日志默认约 8 MiB，最多 4 份；查询上限 32 MiB / 50,000 条。保留时间取决于流量。队列溢出、写入失败只影响诊断，不改变业务结果；进程突然退出可能丢失尚未落盘的观测。

评分与中转副本保存在独立 `runtime/observations.sqlite`，不写 Session、outbox 或任务状态。记录不含聊天正文、提示词、工具参数或凭据；原始内容仍应在已有日志与会话界面查看。评分备注由操作者主动输入。

## 本机与远端启用

1. 安装本仓库的 Harness 覆盖层并构建，按原流程启动 Harness 和控制台。控制台使用支持内置 SQLite 的 Node 24。
2. 新请求生成后可检索真实 trace；可运行 `node console/observation/ImportHistoricalProbe.mjs` 补录旧版 `runtime/llm-probe.log` 中的可核实用量与终态。旧日志没有的会话、工具执行和版本关联不会补造；重复运行替换同一派生副本。
3. 远端需更新配套 `synlove-relay` 的 Hub 和节点。将 `relay.enabled` 改为 true，并填写 Hub `/v1` API 基址。
4. 默认鉴权环境变量为 `RELAY_TOKEN`；也可通过已有服务端密钥配置解析。凭据不得提交到 Git。
5. 控制台运行时每 15 秒导入一次远端元数据；旧 Hub 的 404、缓存缺口和查询截断会显式呈现。

Hub 保留 4096 条易失观测。控制台长时间离线可能错过记录。未知的历史 outbox 关联不猜测；外部 Codex/OpenCode 的内部执行及不传播追踪头的工具不保证有内部片段。

系统指纹来自实际模型输入。独立人格只有原文确实出现在实际系统文本中才标记生效；启动器将 `DSH_PERSONA_FILE` 指向包内 `prompts/XinAi.md`。

## 验证

本次使用假模型和隔离 HTTP/WebSocket 服务，未消耗真实模型 token 或发送微信：

- Harness 构建通过，4 个定向回归文件共 84 项通过。
- 观测存储及真实 HTTP 路由共 14 项通过，覆盖 256 路并发、轮转、写入失败、评分、版本隔离和成本计算。
- relay 追踪测试 2 项通过，含 24 个并发 trace；原有冒烟 24 项通过。
- 实际浏览器 GUI 8 项检查通过，无 JavaScript/CSP 错误。

从 `console` 运行观测测试：

```powershell
node --test observation/tests/ObservationStore.test.mjs observation/tests/ObservationRoutes.test.mjs
```

发布仓库的存储测试直接引用附带的 Harness 覆盖层，不依赖本机运行目录。浏览器冒烟脚本 `ObservationUiSmoke.mjs` 接受 Playwright 包路径、浏览器路径和截图目录。

桌面名称保留原 `xinai-console` 用户目录与包名；产品显示名为 SynLove。Windows 启动时注册当前用户的 SynLove 开始菜单快捷方式和应用 ID，不修改 Electron 二进制或已有开机启动项。
