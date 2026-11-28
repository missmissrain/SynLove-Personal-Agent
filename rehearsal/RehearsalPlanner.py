"""预演提示词组装（使用画像版）：把本轮要预演的软件清单、设备、红线与产出要求拼成一条指令。

参数 root 为仓库根目录；config 为预演配置；targets 为本轮软件列表；profile_text 为画像摘要。
"""
from pathlib import Path

PROTOCOL = """你是欣爱，现在做一次**静默预演**：只为摸清流程，不替主人做决定。

## 硬性红线（违反即失败）

- 绝不执行不可逆动作：{forbid}。
- 一旦屏幕出现上述按钮或页面，**立即停手**，截图并记录“停在这里的原因”，不要点。
- 不输入手机号、验证码、支付密码、身份证号；遇要输入就停下记录。
- 不领券、不开会员、不绑卡、不改真实地址、不删除任何数据。

## 允许操作的设备

{devices}

规则：软件登记在哪台设备就在哪台操作；不能用就跳过这个软件并记录原因，不要换设备硬凑。

## 找软件的方式（必须遵守）

- 找软件、包名、安装位置，**一律先用 shell 或专用接口**，不要用 GUI 去翻桌面/应用列表：
  - Android：`adb shell pm list packages`、`adb shell pm path <包名>`、`adb shell dumpsys package <包名>`；
    已知包名直接用 `adb shell monkey -p <包名> 1` 或 `am start` 启动。
  - Windows：`where.exe <名字>`、`Get-Command`、`Get-ChildItem` 常见安装目录、注册表 `App Paths`。
- GUI（截图/控件树/点击）**只用于流程本身的界面操作**；不得用 GUI 找软件或确认是否安装。
- 设备上 adb 不通时，先用 `android_shell`/`android_gui_action` 的可用通道；仍不通就如实记录，不要靠 GUI 硬翻。

## 本轮要预演的软件（按顺序，最多 {limit} 个）

{targets}

对每一个软件：
1. 先确认设备可用（安卓先解锁：截图全黑或控件树为空时按 `android-unlock` 技能处理）。
2. 打开软件，截图认页面，记录首页结构与主要入口。
3. 走一个**最典型**的流程到倒数第二步（商品详情、确认订单、路线规划、播放页等），把价格/数量/规则读出来。
4. 停在任何不可逆动作之前，截图留证。
5. 走完回到桌面或退出，别把设备留在弹窗页。

## 产出

每个软件写一份 skill：`{skill_root}/rehearsal-app-<拼音或英文短名>/SKILL.md`，用中文，包含：
- 软件名、所在设备、包名（拿得到就写）、启动方式
- 首页结构、主要入口、关键坐标（分辨率/方向一并记）
- 典型流程步骤表：第几步、做什么、预期看到什么、失败怎么办
- 安全停点：哪些按钮绝对不能点
- 数据快照：本轮读到的价格/规则，标注时间

**只写这个预演技能库**，不要写 `runtime/dsh/skills`——那是真实任务沉淀的库。

## 收尾

一段话总结：每个软件走到哪、停在哪、产出了哪个 skill。**不要给主人发任何消息**。
"""


def build_app_prompt(root, config, targets, profile_text=""):
    """root为仓库根目录，config为预演配置，targets为软件列表，profile_text为画像；返回提示词。"""
    root = Path(root)
    forbid = "、".join(config.get("forbidActions") or ["支付", "提交订单", "删除"])
    devices = config.get("devices") or {}
    device_lines = "\n".join("- `%s`（%s）：%s" % (name, (item or {}).get("kind", "windows"),
                                                  (item or {}).get("note", ""))
                            for name, item in devices.items()) or "- 未登记设备"
    target_lines = []
    for index, item in enumerate(targets, 1):
        target_lines.append(
            "%d. **%s** ｜ 设备 `%s` ｜ 典型流程：%s ｜ 近 %d 次提及" % (
                index, item["name"], item["device"], item.get("flow") or "自行选择最有代表性的流程",
                int(item.get("hits") or 0)))
    skill_root = root / str(config.get("skillRoot") or "runtime/dsh/rehearsalSkills")
    text = PROTOCOL.format(forbid=forbid, devices=device_lines,
                           targets="\n".join(target_lines),
                           limit=int(config.get("maxAppsPerRound") or 2),
                           skill_root=str(skill_root))
    if profile_text:
        text += "\n## 主人的画像（只用来选路径）\n" + profile_text[:1200] + "\n"
    return text
