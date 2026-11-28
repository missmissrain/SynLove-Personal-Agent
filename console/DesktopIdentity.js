/**
 * 桌面身份：统一应用、任务栏与 Windows 通知的 SynLove 名称。
 * 注册参数 app/shell：Electron 对象；root：控制台目录；log：失败记录回调。
 * 默认名称和应用 ID 均为 SynLove；保留原 xinai-console 用户数据目录和单实例状态。
 * 只创建当前用户开始菜单快捷方式，不修改框架二进制或既有开机启动项。
 */
const { existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

class DesktopIdentity {
  /** 参数 app/shell/root/log：Electron 对象、应用目录与诊断回调；初始化桌面身份。 */
  constructor({ app, shell, root, log = () => {} }) {
    this.app = app
    this.shell = shell
    this.root = root
    this.log = log
    this.name = 'SynLove'
    this.id = 'SynLove'
    this.args = process.defaultApp ? `"${root}"` : ''
    this.icon = join(root, 'public', 'assets', 'BrandIcon.ico')
    // productName 会改变默认用户目录，显式保留原目录以免丢失桌面偏好或建立第二个实例。
    app.setPath('userData', join(app.getPath('appData'), 'xinai-console'))
    app.setName(this.name)
    if (process.platform === 'win32') app.setAppUserModelId(this.id)
  }

  /** 无参数；注册当前用户开始菜单名称，失败仅记录，继续启动控制台。 */
  register_shortcut() {
    if (process.platform !== 'win32') return
    const dir = join(this.app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    const file = join(dir, `${this.name}.lnk`)
    try {
      mkdirSync(dir, { recursive: true })
      if (existsSync(file)) {
        const old = this.shell.readShortcutLink(file)
        if (old.target.toLowerCase() !== process.execPath.toLowerCase() || old.args !== this.args) {
          this.log('保留其他程序的同名快捷方式:', file)
          return
        }
        if (old.appUserModelId === this.id && old.description === this.name && old.icon === this.icon) return
      }
      const ok = this.shell.writeShortcutLink(file, 'create', {
        target: process.execPath, args: this.args, cwd: this.root,
        description: this.name, appUserModelId: this.id, icon: this.icon, iconIndex: 0,
      })
      this.log('desktop identity:', this.name, '| shortcut:', ok)
    } catch (error) {
      this.log('desktop identity shortcut failed:', String(error))
    }
  }

  /** 参数 win：新建窗口；为 Windows 任务栏设置名称与匹配的重启命令。 */
  apply_window(win) {
    if (process.platform !== 'win32') return
    win.setAppDetails({
      appId: this.id, relaunchDisplayName: this.name,
      appIconPath: this.icon, appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"${this.args ? ` ${this.args}` : ''}`,
    })
  }
}

module.exports = { DesktopIdentity }
