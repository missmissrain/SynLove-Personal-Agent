# ModelHub：本机统一模型入口

ModelHub 是服务器上的模型中枢：管理本地模型权重与显存，同时把云端模型（私有网关、公共模型服务、订阅网关）注册成统一的 OpenAI 兼容入口。欣爱只连本机 ModelHub，不再直接保存云端地址与密钥。

## 端口与接口

- 管理/转发：`http://127.0.0.1:<modelhub-port>`
- 健康：`GET /health`
- 模型目录：`GET /v1/models`
- 用量：`GET /v1/usage`（按模型汇总请求数、输入/输出 token、平均耗时、失败数，默认保留 30 天）
- 云端状态：`GET /v1/cloud/status`
- 云端转发：`POST /<provider>/v1/<path>`，例如
  - `POST /gateway-a/v1/responses`
  - `POST /qwen/v1/chat/completions`
  - `POST /gateway-b/v1/chat/completions`

`<provider>` 来自 `config/modelHub.json` 的 `cloud.providers`，请求原样转发，密钥由 ModelHub 注入，客户端不需要也不应该持有。

## 配置

```json
{
  "cloud": {
    "enabled": true,
    "timeoutSeconds": 900,
    "usageRetentionDays": 30,
    "providers": {
      "gateway-a": {"baseURL": "https://your-provider.example.com/v1"},
      "qwen": {"baseURL": "https://your-provider.example.com/compatible-mode/v1"},
      "gateway-b/": {"baseURL": "http://127.0.0.1:<gateway-port>/v1"}
    }
  }
}
```

密钥放在 `config/modelHubSecrets.json`（不入库）：

```json
{"providers": {"gateway-a": {"apiKey": "..."}, "qwen": {"apiKey": "..."}, "gateway-b/": {"apiKey": "..."}}}
```

## 用量统计

每次转发都会往 `runtime/modelHub/usage.jsonl` 追加一条记录，字段包括 provider、model、状态码、耗时、输入/输出 token、是否流式。`GET /v1/usage` 返回：

- `today`：当天请求数与 token
- `models`：按 `provider/model` 汇总，含平均耗时与失败数
- `days`：按天汇总

## 欣爱侧

- `config/modelConfig.json` 的 `gateway-a`、`qwen`、`gateway-b/` 三个 provider 的 `baseURL` 都指向 `http://127.0.0.1:<modelhub-port>/<provider>/v1`
- `config/secrets.json` 里不再保存云端 key
- 用途分工：主对话与主动研究用私有网关（回退公共模型服务）；记忆/知识图谱用 订阅网关 免费 <model>；自主行动用 订阅网关 <model>
