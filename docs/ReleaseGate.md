# 发版门槛：记忆与主动研究

发布前必须运行：

```bat
.venv\Scripts\python.exe tools\RunMemoryGate.py
```

门槛覆盖：

- 时间线一千条追加去重、推理字段排除、索引损坏重建、摘要失败保留与恢复。
- 记忆模型鉴权错误、空正文、超时都拒绝假成功。
- 图谱远端失败不推进水位；同毫秒新增记录不会跳过；启动轮结束后再触发手动轮。
- 主动研究冷启动、连续无候选不耗预算、结果新鲜不重复研究、规划超时只快速重试、不适合研究进入七天退避、成功写记事簿并回写画像、预算用完排到次日、重启后读取原状态。

任何一项失败（`GATE_FAIL`）都阻塞发布；修复后重跑，直到 `GATE_PASS`。该门槛不替代微信/QQ 实机链路、后台任务和真实模型验收。

## 干净检出要求

门槛必须在没有 `node_modules` 的干净检出里通过，GitHub Actions 与本地 `tools/RunMemoryGate.py` 使用同一命令。探针 `lib/types/diagnostics/probe.js` 把 `@deepseek-ai/dsh-llm` 当可选依赖：装好时照常写 trace，缺失时只写本地 JSONL，不让导入失败。

node 依次从 `CONSOLE_NODE`、PATH、`G:\runtimes\node24\*\node.exe` 查找；找不到直接 `GATE_FAIL`，不再退回写死的路径。
