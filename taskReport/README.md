# 完成汇报（codex / opencode → 润色 → QQ）

编码助手（Codex CLI、opencode）干完一个任务后，把结果**润色成一段人话**推到主人 QQ。

这个功能以前是"把原始结果直接塞给微信"，口径是给机器看的：项目/任务/结果三段式，还把
markdown 和代码块原样带上。现在改成：先让默认对话模型（qwen3.8-flash）按欣爱的口气改写，
再走 QQ 官方机器人主动消息发出去。

## 链路

```
~/.codex/state_5.sqlite + rollout JSONL ─┐
                                        ├─ 检测"刚完成" → 润色（/chat/completions）→ QQ 主动消息
~/.local/share/opencode/opencode.db ────┘
```

只读本地会话文件，不装 notify 钩子、不新开消费者，所以不会和 harness 抢微信/QQ 的连接。

## 开关

控制台「功能开关 → 即时生效」两个开关，存在状态库 meta 里：

| 键 | 含义 | 默认 |
|---|---|---|
| `report.codex` | codex 完成汇报推 QQ | 关 |
| `report.opencode` | opencode 完成汇报推 QQ | 关 |

改完**下一轮扫描（15 秒）就生效**，不需要重启。

后端原有的 `notify.codex` / `notify.opencode` 是老的"推微信"开关，保持关闭，
两套互不干扰：老开关关着，就不会重复往微信发。

## 三条保守规则

1. **首轮只建基线**：装上或重启后不会把历史任务全播一遍；
2. **只报新鲜任务**：完成超过 2 小时的（停机期间攒下的）不再打扰；
3. **失败重试有上限**：推送失败最多重试 3 轮，避免网络不好时无限重发。

## 文件

| 文件 | 职责 |
|---|---|
| `runTaskReport.py` | 入口：`--once` 扫一轮 / `--loop` 常驻 / `--dry-run` 只打日志 |
| `model/TaskReport.py` | 一条汇报的数据结构 |
| `config/TaskReportConfig.py` | 开关、模型、轮询间隔、状态文件 |
| `sources/CodexSource.py` | 读 Codex 会话库与 rollout |
| `sources/OpencodeSource.py` | 读 opencode 会话库 |
| `polish/ReportPolisher.py` | 调模型改写成人话，失败退回原文 |
| `push/QqReporter.py` | 复用 `tools/qq_notify.py` 推 QQ，超长自动分段 |
| `runtime/TaskReportWatcher.py` | 轮询、去重、编排 |

## 运行与排查

启动器（`start_stack.py` → `services/StartupServices.py`）会自动拉起 `--loop`，pid 写在
`runtime/task-report.pid`。

```bat
:: 手动扫一轮，只打日志不推送
python taskReport\runTaskReport.py --once --dry-run

:: 看它自己写的结论
type runtime\task-report.log
```

环境变量：`DSH_TASK_REPORT_POLL_MS`（默认 15000）、`DSH_TASK_REPORT_FRESH_MINUTES`（默认 120）。
