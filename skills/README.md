# 技能自动沉淀（skill review）

把"欣爱和用户的真实对话"每隔 N 小时复盘一次，自动沉淀成可复用的技能，
默认写入当前实例的 `runtime/dsh/skills/<name>/SKILL.md`，由执行内核加载。设置 `DSH_HOME` 或自定义技能目录时按配置使用。

## 设计（照抄 Hermes Agent 的复盘闭环）

| 环节 | 做法 |
|---|---|
| 触发 | 每天 03:00 跑一次（计划任务 `SynLoveSkillReview`）；水位存 `runtime/skill-review-state.json` |
| 素材 | 上次水位 → 现在的对话（用户/欣爱/工具调用摘要），太长时保留最近 14000 字 |
| 模型 | 默认 qwen3.8-flash；降级 Gemma 复用统一服务配置，可连接远端 |
| 循环 | 临时 agent loop：`list_skills → read_skill → save_skill → finish`，最多 8 轮 |
| 产出 | 类级别技能（不是具体歌名/日期/一次性任务）；单次最多 3 个 |
| 写入 | 新技能直接落盘；修改已有技能只暂存待审（实例技能目录的 `.pending/`） |
| 校验 | 固定格式：frontmatter（name/description/version/metadata.hermes.tags/category）+ 四段正文 |
| 通知 | 有新增/待审时用 QQ 推一条摘要 |

## 固定格式

```markdown
---
name: <kebab-case 类级别名称>
description: <一句话，≤120 字>
version: 1.0.0
metadata:
  hermes:
    tags: [tag1, tag2]
    category: <分类>
---

# <标题>

## 何时使用
## 步骤
## 坑
## 验证
```

## 模型选型实测（酷狗音乐素材）

| 模型 | 用时 | 结果 |
|---|---|---|
| Gemma 4 E4B（本地） | 51.7s | 格式对，但步骤是空话，漏掉核心教训，沉淀价值低 |
| qwen3.8-flash（云端） | 35.5s | 给出可跑 PowerShell、VK 码、验证方式与真实坑 |

以上为旧提示词下的单次结果，不能代表模型的普遍能力。2026-11-03 版本为无工具降级请求增加明确的纯文本输出约束，已用人工素材验证远程 Gemma 生成并保存完整中文技能。默认仍使用云端模型；格式通过不等于内容质量得到保证。

## v2.0 复盘链路

会话目录按照 Harness 的完整路径协议精确匹配，支持中文、连字符和 UTF-16 编码，避免跨工程读取。素材由多个 Zstandard 帧组成；优先使用现有 Python `zstandard`，缺失时复用 Node 24 与 Harness 自带帧扫描器，不在运行时安装依赖。读取或写入失败保留水位，等待后续复盘。

## 文件

```
skills/
├── config/skillReview.json        # 间隔、模型、上限、通知开关、应跑时刻/冷却/锁
├── config/configLoader.py         # 配置加载与校验
├── store/skillStore.py            # 技能读写 + 固定格式校验 + 待审暂存
├── store/durableFile.py           # 写文件重试 + 降级副本（被占用也不崩）
├── store/runLock.py               # 单实例锁（判活看进程启动时刻，能自动回收死锁）
├── review/transcriptBuilder.py    # 会话 → 复盘素材
├── review/llmClient.py            # 主模型 + 降级模型
├── review/reviewTools.py          # 复盘 agent 的工具集
├── review/skillReviewer.py        # 提示词 + 临时 agent loop
├── skillReviewService.py          # 入口（--once / --loop / --dry-run）
└── runSkillReview.cmd             # 计划任务用的包装（UTF-8 + 独立 console 日志）
```

## 崩了怎么办（v1.3.5）

2026-10-29 03:00 那轮在写 `runtime/skill-review.log` 时撞上文件被占用（启动脚本把 stdout 也重定向进了同一份日志），
`PermissionError` 直接崩掉整轮。现在的四层保险：

| 层 | 机制 |
|---|---|
| 写文件 | `durableFile`：重试 6 次 → 转存 `*.locked-<时间戳>-<pid>.bak`，永不抛异常 |
| 日志 | 程序结论进 `skill-review.log`，进程输出进 `skill-review.console.log`（不同文件） |
| 单实例 | `runLock`：计划任务与巡检不会并排跑；死锁/坏锁/pid 回收都能自动回收 |
| 复活 | `tools/guardService.py` 每 60 秒看水位，03:00 后十分钟还没成功就补跑（30 分钟冷却） |

```bat
python skills\skillReviewService.py --once --since-hours 30    :: 手动补一段更长的窗口
python skills\skillReviewService.py --once --dry-run           :: 只校验不落盘
```

模型报错时**不推进水位**（只记 `last_error`），所以失败的那段素材下一轮还会被重新复盘，不会丢。

## 常用命令

```bat
python skills\skillReviewService.py --once                 :: 立刻跑一次
python skills\skillReviewService.py --once --dry-run       :: 只校验不落盘
python skills\skillReviewService.py --once --since-hours 48
python skills\skillReviewService.py --loop                 :: 常驻（按 intervalHours）
```

## 待审更新

`~/.dsh/skills/.pending/<name>-<时间>.json` 里是"对已有技能的修改提案"。
看完内容后，手工把 `content` 覆盖到 `~/.dsh/skills/<name>/SKILL.md` 即可；
不认同就删掉该文件。

## 计划任务

`SynLoveSkillReview`：每天 **03:00** 执行一次 `skills\runSkillReview.cmd`（只跑一次，不常驻）。
