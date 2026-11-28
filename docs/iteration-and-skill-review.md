# 自动迭代与技能沉淀

这份文档说明两条自动化流水线怎么跑、产物在哪、以及主人要怎么批准。

## 一、自动迭代代码（夜间维护）

### 流程

1. `tools/RunNightlyMaintenance.py` 由计划任务在每天 03:00 触发，配置读 `config/nightlyMaintenance.json`（默认每 3 天真正跑一轮）。
2. 每轮对登记的仓库做一次：隔离快照 → 调 Codex 改代码 → 静态检查 → 跑验收命令。
3. 验收通过后**不再直接改生产**，而是把补丁提交到独立分支：`auto/iter/<轮次>`，例如 `auto/iter/20261126-033002`。
4. 轮次档案写到 `runtime/nightlyMaintenance/rounds/<轮次>.json`，待确认标记写到 `runtime/nightlyMaintenance/pending.json`。
5. 同时通过 QQ 汇报“改了哪些仓库、哪些文件、改了什么”，并询问是否更新实例。

### 主人的两种回复

| 回复 | 动作 |
|---|---|
| 更新实例 | 应用补丁到生产 → 提交 `main` → 推送 GitHub → 重启栈 |
| 不要 | 删除本轮分支，生产保持不动 |

### 执行命令

```powershell
# 看待确认轮次与分支
python tools\ApplyIteration.py --list

# 应用最新待确认轮次（应用 + 提交 main + 推 GitHub + 重启）
python tools\ApplyIteration.py --apply

# 只应用不重启
python tools\ApplyIteration.py --apply --no-restart

# 丢弃本轮
python tools\ApplyIteration.py --discard
```

### 安全边界

- 单轮单仓库最多 20 个文件、补丁不超过 2MiB，超出保留隔离区等人工看。
- `config/`、密钥、`.env`、`Pairing.json`、`.cmd/.ps1` 一律不进补丁。
- `__pycache__`、`*.pyc` 在生成补丁前自动剔除，不再因为字节码让整轮失败。
- 应用前逐个文件校验哈希，生产文件在维护期间被改过就取消应用。
- 推送失败时分支保留，`pending.json` 不清，可稍后重跑 `--apply`。

## 二、技能沉淀（Skill Review）

### 流程

1. `skills/skillReviewService.py --loop` 常驻，按 `skills/config/skillReview.json` 的 `intervalHours`（默认 72）判定是否到点。
2. 间隔基准是 **`last_ok_at`（上次真正复盘成功的时间）**，不是“上次启动时间”。失败或素材不足不会占掉整个窗口。
3. `tools/guardService.py` 每 30 分钟巡检：发现 `last_ok_at` 已超期且距上次兜底启动超过冷却时间，就补跑一轮。
4. 复盘产出写 `runtime/dsh/skills`，状态写 `runtime/skill-review-state.json`，日志写 `runtime/skill-review.log`。

### 排障要点

- `last_run_at`：每次启动都会更新，**不能**用来判断节奏。
- `last_ok_at`：只有真正看过素材并产出结果才更新，是唯一可信的节奏基准。
- `last_error_at`：模型侧失败时间；有值但水位没推进，说明下一轮会自动重试。
