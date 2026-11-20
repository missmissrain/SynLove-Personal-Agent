# Magpie 网关：WorkBuddy 的本地模型入口

Magpie 把 WorkBuddy 的订阅模型包装成 OpenAI 兼容接口，供本机的 ModelHub 统一调用。**只监听回环地址，不对公网暴露。**

## 组成

- `magpie serve --web=127.0.0.1:3430`：网关 `127.0.0.1:3425`，控制台 `127.0.0.1:3430`
- 插件 `@magpie-community/opencode-workbuddy-auth`，登录 WorkBuddy 账号后可列出 16 个模型
- 计划任务 `MagpieGateway`：登录后自启，日志在 `C:\Tools\Magpie\serve.log`
- 账号凭证由 magpie 自己保存；多账号时由插件按额度轮换

## 接入方式

由本机 ModelHub 转发，不直接对外：

```
POST http://127.0.0.1:8810/workbuddy/v1/chat/completions
Authorization: Bearer <ModelHub 客户端 key>
{"model": "workbuddy/glm-5.3", "messages": [...]}
```

## 维护

- 重新登录：`magpie plugin login workbuddy`，选择浏览器登录，5 分钟内完成
- 插件登录窗口可用 `SIGN_IN_MS` 调整（默认 5 分钟）
- 常见错误：`11217` 表示仍在等待浏览器登录；`10085/11128/11133` 先升级插件
- 只在需要加账号时临时打开控制台，用完关闭，不要暴露到公网
