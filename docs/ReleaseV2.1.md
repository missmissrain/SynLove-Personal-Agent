# v2.1 增量说明

日期：2026-11-20。配套清单见 `docs/ReleaseCompatibility.md`。

## 主动研究与记忆回归

- 主动研究改为明确状态机：无候选、无需研究、跳过、临时失败、成功分开处理；只有成功消耗当天预算。
- 无候选、无需要、预算耗尽都会显式安排下一次检查，`next_research_at` 不再停在过去。
- 规划模型临时超时只安排 1 小时快速重试，不再把可研究主题跳过七天；空结果也不再按七天退避。
- 记事簿结果还新鲜时跳过同一推断；重启后读取原状态，不到期不重复研究。
- 新增 `tests/ProactiveResearchTests.mjs` 覆盖冷启动、连续无候选、记事簿去重、规划超时、跳过、成功、预算、重启恢复。
- 图谱回归先 `await scheduler.ready()` 等启动轮结束，再验证模型恢复和同毫秒增量；并发触发改为共享当前轮，不再直接丢一次。
- 发版门槛 `tools/RunMemoryGate.py`：12 项记忆与主动研究回归全部通过才允许发布。

## release-gate 失败修复

- 首轮 Actions 失败原因是干净检出没有 `node_modules`：`diagnostics/probe.js` 顶层静态导入 `@deepseek-ai/dsh-llm`，导入即报 `ERR_MODULE_NOT_FOUND`。
- 探针改为 `createRequire` 按需加载该包：可用时照常写 trace，缺失时只写 JSONL；生产环境行为不变。
- 门槛补上 node 定位顺序与缺文件提示；工作流补 `actions/setup-node@v5`（Node 24），并把 checkout/setup-python 升到 v5/v6。
- 主动研究回归原先写死 `PRODUCTION_ROOT/...` 提示词路径，Runner 上文件不存在会让假模型走错分支；改为从 `import.meta.url` 取仓库内提示词，并按请求内容（是否带搜索正文）区分规划与摘要。
- 门槛失败时把“失败用例名 + 断言行”写进注解，不用登录也能在 Actions 页面看到原因。
- 已用干净浅克隆复跑：12 项通过、`GATE_PASS`。

## 跨仓与维护

- `docs/ReleaseCompatibility.md` 固定主程序、后台服务、Relay、出站节点和远控的版本/提交/入口/回滚。
- 家庭服务器出站节点唯一发布源为 `SynLove-Backend-Service/relayNode`；`synlove-relay/dist/nodes` 为历史副本，禁止双向改。
- 新增 `.github/workflows/release-gate.yml`，push/PR 自动跑记忆与主动研究门槛。
- 夜间维护按改动前缀追加 `scopeChecks`；默认待审，只有 `autoApplyPrefixes` 内的低风险改动且全部回归通过才自动应用。
- 维护文档改为“每 3 天一次、全部已登记仓库”，与当前配置一致。

## 验收结果

- `python tools/RunMemoryGate.py`：12 项通过，`GATE_PASS`。
- `NightlyMaintenanceTests.py`：4 项通过。
- `RunNightlyMaintenance.py --check`：4 个仓库与 CLI 识别正常。

## 回滚

主程序回退到 `f3bd9ed`（v2.1 上一提交）或上一发布 tag；后台服务回退到 `792cd9b`；出站节点只回退 `relayNode`，不要动 `synlove-relay` hub/client。回滚后重跑 `RunMemoryGate.py` 与夜间维护检查。
