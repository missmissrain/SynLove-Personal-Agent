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

控制台「功能开关 → 即时生效」两个开关，保存在独立 `config/taskReport.json`，不写入 Harness 的 meta：

| 键 | 含义 | 默认 |
|---|---|---|
| `codex` | codex 完成汇报推 QQ | 缺省关闭 |
| `opencode` | opencode 完成汇报推 QQ | 缺省关闭 |

改完**下一轮扫描（15 秒）就生效**，不需要重启。

后端原有的 `notify.codex` / `notify.opencode` 是老的"推微信"开关，保持关闭，
两套互不干扰：老开关关着，就不会重复往微信发。

## 三条保守规则

1. **首轮只建基线**：装上或重启后不会把历史任务全播一遍；
2. **只报新鲜任务**：完成超过 2 小时的（停机期间攒下的）不再打扰；
3. **失败重试有上限**：推送失败最多重试 3 轮，避免网络不好时无限重发。

新版 OpenCode 使用 `session_v2/session_message`。只有当前回合的 `idle` 事件确认结束，才读取本轮最终回复；工具等待不算完成。成功、失败、中止分别汇报，使用终态事件 ID 去重，浏览会话不触发重发。旧版表结构继续兼容，升级数据源时先建基线，不重放旧任务。

发送接口必须明确返回 `ok=true` 才记为成功；每轮完成事件分别计算重试次数。发送者持有独占锁，防止多开。报告不追加“能收到消息吗”等收件测试问句；这类话术在模型输出与原文兜底中都会清理。

## 文件

| 文件 | 职责 |
|---|---|
| `runTaskReport.py` | 入口：`--once` 扫一轮 / `--loop` 常驻 / `--dry-run` 只打日志 |
| `model/TaskReport.py` | 一条汇报的数据结构 |
| `config/TaskReportConfig.py` | 开关、模型、轮询间隔、状态文件 |
| `sources/CodexSource.py` | 读 Codex 会话库与 rollout |
| `sources/OpencodeSource.py` | 读 opencode 会话库 |
| `polish/ReportPolisher.py` | 调模型改写成人话，失败退回原文 |
| `polish/NoticeText.py` | 清理收件测试问句，保留任务结果 |
| `push/QqReporter.py` | 复用 `tools/qq_notify.py` 推 QQ，超长自动分段 |
| `runtime/TaskReportWatcher.py` | 轮询、去重、编排 |

## 运行与排查

启动器（`start_stack.py` → `services/StartupServices.py`）会自动拉起 `--loop`，pid 写在
`runtime/task-report.pid`。

```bat
:: 手动扫一轮，不调用模型、不发送、不改去重状态
python taskReport\runTaskReport.py --once --dry-run

:: 看它自己写的结论
type runtime\task-report.log
```

环境变量：`DSH_TASK_REPORT_POLL_MS`（默认 15000）、`DSH_TASK_REPORT_FRESH_MINUTES`（默认 120）。
