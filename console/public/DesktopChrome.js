/**
 * 自绘窗口交互模块：绑定最小化、放大和托盘按钮，不调用任何业务接口。
 * 注册参数 bridge：受隔离 preload 提供的窗口桥；默认仅 Electron 启用，普通浏览器保持原布局。
 */
class DesktopChrome {
  /** 参数 bridge：窗口专用窄接口；显示标题栏并绑定动作及拖动区双击。 */
  constructor(bridge) {
    this.bridge = bridge
    document.documentElement.classList.add('desktop-mode')
    document.getElementById('desktop-titlebar').hidden = false
    document.getElementById('window-minimize').addEventListener('click', () => this.run_action('minimize'))
    document.getElementById('window-size').addEventListener('click', () => this.run_action('toggle_size'))
    document.getElementById('window-hide').addEventListener('click', () => this.run_action('hide_window'))
    document.getElementById('desktop-drag').addEventListener('dblclick', () => this.run_action('toggle_size'))
    this.run_action('get_state')
  }

  /** 参数 action：允许的桥接方法名；同步按钮图标和可访问名称，失败时显示简短提示。 */
  async run_action(action) {
    try {
      const state = await this.bridge[action]()
      const button = document.getElementById('window-size')
      button.classList.toggle('is-expanded', state.expanded)
      button.setAttribute('aria-label', state.expanded ? '还原窗口' : '放大窗口')
      document.getElementById('desktop-window-status').textContent = ''
    } catch {
      document.getElementById('desktop-window-status').textContent = '窗口操作失败'
    }
  }
}

if (window.synloveDesktop) new DesktopChrome(window.synloveDesktop)
