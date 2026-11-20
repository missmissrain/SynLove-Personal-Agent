# 发布兼容清单（v2.1）

本清单固定一套可复装的组合。发布前以本表为准，不按单个仓库的最新提交各自发版。

| 组件 | 仓库/路径 | 版本 | 固定提交 | 部署入口 | 回滚 |
| --- | --- | --- | --- | --- | --- |
| 主程序 | `SynLove-Personal-Agent` | v2.1 | `56b06d7` | `server/agent-run.cmd` / `start_stack.py` | 回退到上一版 tag 或上一提交 |
| 后台服务 | `SynLove-Backend-Service` | 2026.11 | `792cd9b` | `server/backend-boot.ps1` / `businessRuntime` | 回退到上一提交并重跑 `GpuResidencyTests.py` |
| VPS Relay（hub/client） | `synlove-relay` | 1.0.0 | 工作副本，无 git 历史 | `deploy/synlove-relay.service` | 保留 `备份/TtsRelayRepairv1.1` |
| 家庭服务器出站节点 | `SynLove-Backend-Service/relayNode` | 1.1.0 | `792cd9b` | `relayNode/dist/tools/startNode.js` | 回退 `relayNode` 到上一提交 |
| 远控 CMD | `Remote-CMD-Control` | 2026.11 | `d0aee3a` | `deploy` 下对应启动脚本 | 回退到上一提交 |

## 出站节点唯一发布源

- 家庭服务器出站节点的唯一发布源是 `SynLove-Backend-Service/relayNode`，它包含 `BusinessHttpAdapter`、观测链和业务服务注册。
- `synlove-relay/dist/nodes` 是历史副本，不再作为发布源，也不要在两台机器上同时改节点代码；`synlove-relay` 只负责 hub/client 与 VPS 部署。
- 已知漂移：`dist/common/configLoader.js`、`dist/nodes/localClients.js`、`dist/nodes/nodeAgent.js` 三份内容不同。下一次节点发版前，只能从 `relayNode` 向 `synlove-relay` 单向同步，并重跑本清单验收；禁止反向覆盖。

## 干净 Windows 验收

本机模式：

1. 干净 Windows 安装 Node 24、Python 3.12，复制 `SynLove-Personal-Agent` 与 `SynLove-Backend-Service`。
2. 跑 `python tools/RunMemoryGate.py`，必须 `GATE_PASS`。
3. 启动 `server/backend-boot.ps1` 与 `start_stack.py`，确认 3080/3081、8080、8810 就绪。
4. 提交一个会超时的后台任务，确认超时后保存产物、结果回执可达、没有重复通知。
5. 同一请求重复提交两次，确认只产生一个任务与一条完成回执。
6. 上传一段音频到 ASR/TTS，核对返回字节与内容类型，确认网关不把音频塞进聊天正文。
7. 触发一次任务结果整理，确认主人格回复 2-4 句、120 字内，原始报告可查。

VPS 转发模式：

1. 启动 `synlove-relay` hub 与 node，按 `deploy/relay.env.example` 配置证书和令牌。
2. 从家庭服务器发起 `probe`/`doctor`，确认节点注册、能力清单、心跳和结果回执。
3. 重复第 4-7 步，额外确认断线重连后不重复执行已经回执的任务。

## GitHub 发布

- `.github/workflows/release-gate.yml` 在 push/PR 时运行记忆与主动研究门槛。
- 发布时先跑 `python tools/RunMemoryGate.py`，再创建 tag（例如 `v2.1.1`）和 GitHub Release；没有通过门槛不得打 tag。
