# Magpie 网关：WorkBuddy 的 OpenAI 兼容入口

把家机 Windows 上的 WorkBuddy 通过 magpie 网关暴露成 OpenAI 兼容 API，经 VPS 的 nginx 提供 HTTPS 和 Bearer 鉴权。

## 拓扑

- 家机：`magpie serve --web=127.0.0.1:3430`，网关 `127.0.0.1:3425`，插件 `@magpie-community/opencode-workbuddy-auth`，账号 MoYu
- 家机隧道：`C:\frp\frpc-magpie.toml`（计划任务 `FrpClientMagpie`），`3425 -> VPS:21120`，`3430 -> VPS:21121`
- VPS：nginx `21115`（HTTPS + Bearer）反代 `127.0.0.1:21120`；`21121` 仅回环，未对外开放
- 自启：家机计划任务 `MagpieGateway`（运行 `C:\Tools\Magpie\serve.cmd`）与 `FrpClientMagpie`

## 客户端

```
Base URL: https://47.111.64.20:21115/v1
Authorization: Bearer <网关 key>
```

key 存在 VPS 的 `/etc/magpie/gateway.key`（权限 600），不要写进仓库。证书是自签的，客户端需要信任证书或临时跳过校验（例如 `curl -k`）。

可用模型（`GET /v1/models`）：`workbuddy/auto`、`workbuddy/glm-5.3`、`workbuddy/deepseek-v4.1-flash`、`workbuddy/kimi-k3.1-pro` 等 16 个。

## 维护

- 重新登录 WorkBuddy：临时恢复 `magpie-ui.conf`（`listen 21116` 反代 `127.0.0.1:21121`），用 `https://47.111.64.20:21116/?k=<MAGPIE_WEB_KEY>` 打开控制台登录，完成后删除该配置并 `systemctl reload nginx`
- 网关日志：家机 `C:\Tools\Magpie\serve.log`；隧道日志 `C:\frp\frpc-magpie.log`
- 端口与鉴权：只对外开放 `21115`；`21120/21121` 不加入安全组放行
- 注意：magpie 对来自回环的请求不校验 key，所以 key 校验必须留在 VPS nginx 这一层

## 欣爱（SynLove）接入

- `config/modelConfig.json`：新增 `workbuddy` provider，`baseURL` 用本机 `http://127.0.0.1:3425/v1`；默认模型 `workbuddy/workbuddy/glm-5.3`，`failover.order` 为 workbuddy → qwen3.8-flash。
- `config/console.env`：`DSH_MEMORY_ENGINE=cloud`、`DSH_MEMORY_CLOUD_MODEL=workbuddy/workbuddy/glm-5.3`、`DSH_MEMORY_CLOUD_FALLBACK=qwen/qwen3.8-flash`，记忆更新与摘要走同一条链。
- `resolve_cloud_target` 原来按 `/` 全量切分，模型 id 带 provider 前缀时会解析错；已改成只按第一个斜杠切分，`workbuddy/workbuddy/glm-5.3` 能正确解析到 provider=workbuddy、model=workbuddy/glm-5.3。
- 主 Agent 的静默思考与子 Agent 都走默认模型链，因此同样享受 workbuddy → qwen 的静默切换。
