# 本地运行库说明

本目录保存人物展示所需的固定版本运行库，运行时只从本程序读取，不访问 CDN。

| 文件 | 来源与版本 | 许可 |
| --- | --- | --- |
| pixi.min.js | npm pixi.js 6.5.10 的 dist/browser | MIT，见 PixiLicense.txt |
| unsafe-eval.min.js | npm @pixi/unsafe-eval 6.5.10 的 dist/browser | MIT，见 UnsafeEvalLicense.txt |
| cubism4.min.js | npm pixi-live2d-display 0.4.0 的 dist | MIT，见 DisplayLicense.txt |
| live2dcubismcore.min.js | Live2D 官方 Cubism Core Web 发行文件，2026-11-10 获取 | 文件头所列 Live2D Proprietary Software License Agreement |

Cubism Core 是官方可再分发运行文件，并非 MIT 组件。其文件头保留原始版权及许可协议地址。修改发行包时请保留原始版权声明，并按各自许可发布；本目录不包含 Cubism 编辑器。

模型使用标准 model3.json 与 MOC3。升级运行库时必须重新核验模型装载、透明纹理、遮罩、绘制顺序和待机动作，不能只检查脚本语法。

`unsafe-eval.min.js` 是 Pixi 官方用于禁用动态代码生成环境的适配层。名称不表示开启 `unsafe-eval`；本页面继续维持 `script-src 'self'`。
