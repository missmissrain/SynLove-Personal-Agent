# Backend runtime

本目录为 SynLove 所使用的 DeepSeek Harness 后端运行快照，保留上游包名和许可。
只包含运行闭包的 JavaScript、插件配置及自定义消息插件源码，无需另一个工作区。

原始上游： https://github.com/deepseek-ai/deepseek-harness
长期镜像： https://github.com/missmissrain/SynLove-DeepSeek-Harness-Fork
归档基线：8bd073392eef6f54e921a093b95076248eb08cbb（fork 创建时的上游 master）。
发行快照历史记录中的 `0e3e35b` 目前无法在公开上游提交接口解析，因此不再把它作为可重建基线。
SynLove 扩展包含微信、QQ、记忆、编码工具及调用链记录。
DeepSeek Harness 使用 MIT 许可，见 LICENSE.deepseek-harness。
vendor 中 Cordis 等第三方包分别保留自身 LICENSE。

外部 npm 依赖由 package-lock.json 锁定，通过 npm ci --legacy-peer-deps 安装。
不把 node_modules、上游测试、仓库快照、构建缓存或模型权重放进发行仓库。
