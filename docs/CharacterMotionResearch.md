# 角色动作与局部资产修缮

## 参考项目与适用边界

调研日期：2026-11-04。下面结论来自项目 README 和实际源码，不代表已完成动作素材移植。

| 项目 | 核实的机制 | SynLove 的用法 |
| --- | --- | --- |
| AIRI | README 列出 VRM 动画、自动眨眼、自动注视和待机眼动 | 参考分离角色自主行为与交互手势，避免整个人物只用一个循环 |
| Live2D Cubism Web Samples / Framework | 官方示例将呼吸、注视、眨眼、表情、物理、口型交给独立 updater；动作队列有淡入淡出权重 | 预载动作，使用进入、保持、收势和中断平滑；不引入 Live2D runtime |
| pixiv three-vrm | SpringBoneJoint 使用惯性、阻尼、刚度、重力约束；three-vrm-animation 提供 VRM Animation 支持 | 保留轻量头发惯性；未来接 VRMA 前需给当前模型做骨架映射 |

原始资料：

- https://github.com/moeru-ai/airi
- https://github.com/Live2D/CubismWebSamples/blob/develop/Samples/TypeScript/Demo/src/lappmodel.ts
- https://github.com/Live2D/CubismWebFramework/blob/develop/src/motion/cubismmotionqueueentry.ts
- https://github.com/Live2D/CubismWebFramework/blob/develop/src/effect/cubismbreath.ts
- https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm-springbone/src/VRMSpringBoneJoint.ts
- https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm-animation

这些项目不等于一套能直接套用到任意骨架的动作素材包。Live2D 是二维参数模型，
VRMA 针对 VRM 规范；当前欣爱是自定义蒙皮格式，不能直接播放而跳过重定向验收。
本轮只参考机制，自行实现少量关键姿态，没有复制第三方代码或引入不明许可证动作。

## 2026-11-05 刘海与眉眼分层修正

用户指出的局部深色来自两个问题：既有发束补色只在闭眼时生效，
以及目标发梢附近一小段睫毛补面向上突出。原型增加 `FringeCleanup`：
仅对指定发束的原UV取样区域独立补色，将发梢略向前避开睫毛，
并将独立UV范围内突出的睫毛脊线压回轮廓。睫毛局部修正在闭眼时退出，
不改变既有闭眼形态。没有重新生成整张脸或覆盖原始贴图。

`tools/characterRepair/FringeCleanupCheck.cjs` 在相同相机下切换修正开关，
输出补色关闭对照、修后、半闭眼、闭眼、左右转头六张截图及验证JSON；
结果位于 `artifacts/characterRepair`。

## 2026-11-05 发尾尖端补齐

`FringeRefiner` 从派生资产中独立提取目标刘海的47个三角面与邻近发束
的181个三角面，局部细分三轮。根部边界保留原位，原始脸部顶点、
嘴眼形态与骨架保持。用户确认主要问题是缺少发尾尖端，因此沿原发束
方向补出3毫米尖梢，逐渐收拢截面，避免保留平直断口。

该独立头发分岛清除误带的眼皮肤色补色属性，避免闭眼时头发被染成肤色。
原型的局部前移由4.5毫米减为2毫米，并保留轻微纵向明暗，减轻纯白挡片感。
所有修改仅作用于原型派生资产与原型材质。原始模型和生产人物资源不覆盖。

修前资产与局部图保存在工作区 `备份/SynLoveCharacterRepairV1.1`。
补色开关截图只对比材质，不能当作几何修改前后的证据；几何修前图使用
该备份中的 `刘海修前.png`。

用户进一步指出尖端旁的右缘仍缺一角。`FringeCornerBuilder` 使用两条
二次曲线连接发束右缘和既有尖端，增加376个局部三角面补齐缺口，
复用原头发取样和蒙皮。没有继续延长尖端。补面使用单一末端顶点封口，
并检查睁眼、半闭眼、闭眼与小幅左右转头。对应的直接修前图为
`artifacts/characterRepair/缺角修补前.png`，最终图为 `刘海去污染后.png`。
补面使用独立横向标记绘制暖粉色右缘线，描边随截面收细到尖端；
颜色由原型材质统一调色，避免直接使用纯黑线条。

## 2026-11-05 眼线浅色缺角修复

用户明确缺口位于刘海下方的深红眼线。源贴图对应眼线UV存在浅色残片，
先前将眼线压至0.876米的局部修正也造成上缘截断。现在由独立
`EyeLineRepair` 管理该区域，将上缘限制调整为0.8775米，并从相邻眼线
取样修补指定UV椭圆与空间范围内的浅色。刘海几何和描边不变。

修补在闭眼时退出，保留原眨眼形态。浏览器验收额外对比开关像素：
睁眼局部应有变化，完全闭眼的同一区域应像素一致。实际修前图为
`眼线缺角修补前.png`，最终特写为 `眼线缺角修补后特写.png`。

## 已确认的问题

原贴图为 8192×8192 RGBA，alpha 全为255，透明边缘抗锯齿不能修复破碎发束。
主体有601个顶点的UV为(0,0)，该位置采到黑色；这会使补面显示黑线。
两处细发束有碎三角、低点数轮廓。全局饱和度1.90进一步放大了粉色描边。

## 本轮处理

在 `console/public/prototype/character-driven/assets` 输出独立派生资产：

- 无效UV投影到附近有效表面，保留纹理原图；
- 删除头部外侧突兀的孤立发丝；下方保留的细发梢用连续样条管面修缮，排除脸与头发主体；
- 原脸型、嘴眼形态增量、骨架和原始二进制保持；
- 原型调色减少过饱和，不添加光照；
- 原型使用预制动作、保持段、五次平滑包络与四元数连续过渡；
- 保留呼吸、眨眼、头部视线与轻量发梢惯性各自的时间轴。

这仍是程序修缮的原型资产，不能替代整个人物的人工拓扑和美术精修。
花饰、蕾丝与大范围头发仍保留原生成网格。未宣称已转成VRM或达到成品角色质量。

## 复现

已有Python环境需提供NumPy、SciPy；不需要Blender重新导出，原图路径保持。

```powershell
D:/py39/python.exe -X utf8 tools/characterRepair/AssetRefiner.py console/public/Avatar/assets console/public/prototype/character-driven/assets
```

浏览器验证使用已有 Playwright，路径可通过 `SYNLOVE_PLAYWRIGHT` 指定；
`CharacterRepairCheck.cjs` 覆盖资源加载、无效UV、600秒模拟、中断切换、
三张卡片交互、宽窄屏截图和真实动作录屏。它不调用模型、不使用正式token。
