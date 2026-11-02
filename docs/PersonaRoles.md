# 主人格与后台执行提示词

“人格与工具”提供两个独立编辑框。

| 编辑框 | 职责 | 保存后何时生效 |
| --- | --- | --- |
| 欣爱 · 主人格 | 聊天、接待、任务委派、读取总结后组织回复 | 重启 Agent 内核 |
| 执行 Agent · 任务提示词 | 独立任务中的操作、验证、自纠错和正式总结 | 下一次创建任务；不改变正在运行的任务 |

主人格沿用 `config/weixinDoubaoProfile.patch.yml` 的 `personaPrefix`，避免同时维护两份运行源。发行版初次初始化从 `prompts/XinAi.md` 填入默认主人格。执行提示词来自 `prompts/TaskExecution.md`，每个新任务创建独立会话时读取，不继承主人格的聊天风格。

GUI 的 `GET /api/persona?role=presenter|worker` 与 `POST /api/persona` 使用固定角色白名单。保存正文为 `{ "role": "worker", "text": "..." }`；旧调用省略 role 时仍指主人格。保存会备份源文件，再原子替换，避免后台读取半份正文。

`prompts/PresenterProtocol.md` 和 `prompts/WorkerProtocol.md` 是宿主协议，不出现在人格编辑框。前者规定任务接单与结果表达，后者规定执行权限、结果状态和正式总结格式。可编辑提示词不替代代码中的工具权限限制。

后台终态先持久化，通知桥等待主人格空闲，把总结作为结果数据交给主人格。只有主人格正常完成的最终正文才能进入原通道队列；润色失败、空回复或超时不会透传执行原文，而是保留待办，按 30 秒至 5 分钟的退避间隔重试。已生成正文但通道入队失败时，复用保存的正文，避免重复生成。退避计数保存在进程内，重启后从持久待办继续处理。

旧版提示词可使用 `node tools/SeparatePersonaPrompts.mjs` 预览迁移范围，显式加 `--apply` 才会备份并剥离旧底层操作章节。脚本保留已有性格与聊天章节，重复运行不会继续追加规则。

验证：

- `node --test tests/PersonaStoreTests.mjs tests/AgentTaskTests.mjs`
- `node tests/PersonaUiSmoke.mjs <现有Playwright模块> <现有Chromium可执行文件>`

回归使用临时存储、真实 Harness 与可控模型，不向微信或 QQ 发测试消息。
