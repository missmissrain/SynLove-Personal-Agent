/**
 * 桌面隔离桥接：只暴露窗口状态与三个窗口操作，不暴露 Node、文件或任意 IPC。
 * 注册参数：由 BrowserWindow 的 preload 加载；默认只连接 synlove:window。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('synloveDesktop', Object.freeze({
  /** 无参数；读取窗口尺寸与放大状态。 */
  get_state: () => ipcRenderer.invoke('synlove:window', 'state'),
  /** 无参数；读取主进程判定的最新开屏请求。 */
  get_opening: () => ipcRenderer.invoke('synlove:window', 'opening'),
  /** 参数 callback：开屏请求回调；只订阅固定事件，返回取消订阅函数。 */
  on_opening: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('synlove:opening', listener)
    return () => ipcRenderer.removeListener('synlove:opening', listener)
  },
  /** 无参数；将窗口最小化到任务栏。 */
  minimize: () => ipcRenderer.invoke('synlove:window', 'minimize'),
  /** 无参数；在标准和屏幕适配的 16:9 尺寸之间切换。 */
  toggle_size: () => ipcRenderer.invoke('synlove:window', 'toggle-size'),
  /** 无参数；触发原有关闭逻辑，收起到托盘。 */
  hide_window: () => ipcRenderer.invoke('synlove:window', 'hide'),
}))
