/**
 * 桌面窗口模块：建立无系统边框的透明圆角窗口，以 16:9 切换标准和放大尺寸。
 * 注册参数 electron：主进程 API；url：唯一受信控制台地址；preload：桥接脚本路径；icon：应用图标。
 * 默认 1280×720，小屏按比例缩放；禁用自由拉伸和原生最大化，关闭仍由原托盘逻辑处理。
 */
const { join } = require('node:path')
const { OpeningPlaybackState } = require('./OpeningPlaybackState.js')

class DesktopWindow {
  /** 参数 electron/url/preload/icon：窗口 API 与固定资源；注册只允许主窗口使用的窄 IPC。 */
  constructor({ electron, url, preload, icon, log = () => {} }) {
    this.electron = electron
    this.url = new URL(url).href
    this.preload = preload
    this.icon = icon
    this.log = log
    this.window = null
    this.expanded = false
    this.restore = null
    this.opening = new OpeningPlaybackState({ file: join(electron.app.getPath('userData'), 'OpeningPlaybackState.json') })
    this.openingConsumed = 0
    electron.app.on('before-quit', () => this.opening.record_inactive())
    electron.ipcMain.handle('synlove:window', (event, action) => this.handle_action(event, action))
  }

  /** 参数 area：屏幕工作区；limit：目标宽度，默认 1280；按 64×36 单元取整，适配 Windows 常见的 125%/150%/175% 缩放。 */
  fit_bounds(area, limit = 1280) {
    const unit = Math.max(4, Math.floor(Math.min(limit / 16, (area.width - 32) / 16, (area.height - 32) / 9) / 4) * 4)
    const width = unit * 16
    const height = unit * 9
    return { x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2), width, height }
  }

  /** 无参数；在鼠标所在显示器建立窗口，等页面就绪后由主入口决定显示或后台驻留。 */
  create_window() {
    const { BrowserWindow, screen } = this.electron
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const bounds = this.fit_bounds(display.workArea)
    this.expanded = false
    this.restore = null
    this.window = new BrowserWindow({
      ...bounds,
      title: 'SynLove', icon: this.icon, show: false,
      frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, maximizable: false, fullscreenable: false,
      hasShadow: true, autoHideMenuBar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
        autoplayPolicy: 'no-user-gesture-required' },
    })
    // Windows 显示缩放会对初始外框取整，显式校准客户区，确保严格 16:9。
    this.window.setContentSize(bounds.width, bounds.height)
    this.window.setMenu(null)
    const record_open = () => {
      const state = this.opening.record_open()
      this.window.webContents.send('synlove:opening', state)
    }
    this.window.on('show', record_open)
    this.window.on('restore', record_open)
    this.window.on('hide', () => this.opening.record_inactive())
    this.window.on('minimize', () => this.opening.record_inactive())
    return this.window
  }

  /** 参数 event/action：IPC 来源与动作；校验发送者和主框架 URL 后执行有限的窗口操作。 */
  handle_action(event, action) {
    const win = this.window
    if (!win || win.isDestroyed() || event.sender !== win.webContents
      || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== this.url) {
      throw new Error('拒绝非控制台窗口请求')
    }
    if (!['state', 'opening', 'minimize', 'toggle-size', 'hide'].includes(action)) throw new Error('未知窗口操作')
    this.log('window ipc action:', action)
    if (action === 'opening') {
      const state = this.opening.decision
      const play = state.play && state.requestId > this.openingConsumed
      this.openingConsumed = state.requestId
      return { ...state, play }
    }
    if (action === 'minimize') win.minimize()
    if (action === 'hide') win.close()
    if (action === 'toggle-size') {
      if (this.expanded && this.restore) {
        const area = this.electron.screen.getDisplayMatching(this.restore).workArea
        const bounds = this.restore.width <= area.width && this.restore.height <= area.height
          ? { ...this.restore,
            x: Math.max(area.x, Math.min(this.restore.x, area.x + area.width - this.restore.width)),
            y: Math.max(area.y, Math.min(this.restore.y, area.y + area.height - this.restore.height)) }
          : this.fit_bounds(area)
        win.setBounds(bounds)
        win.setContentSize(bounds.width, bounds.height)
      } else {
        this.restore = win.getBounds()
        const area = this.electron.screen.getDisplayMatching(this.restore).workArea
        const bounds = this.fit_bounds(area, Number.POSITIVE_INFINITY)
        win.setBounds(bounds)
        win.setContentSize(bounds.width, bounds.height)
      }
      this.expanded = !this.expanded
    }
    return { expanded: this.expanded, ...win.getBounds() }
  }
}

module.exports = { DesktopWindow }
