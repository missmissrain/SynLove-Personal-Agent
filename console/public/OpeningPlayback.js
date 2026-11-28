/**
 * 开屏调度模块：接收主进程依据窗口时间生成的播放请求，按请求编号去重。
 * 注册参数 bridge：桌面隔离桥接；root：开屏容器；不自行计时，不修改窗口时间状态。
 */
class OpeningPlayback {
  /** 参数 bridge/root：主进程时间策略接口和开屏容器；先订阅再读取，避免错过首次显示。 */
  constructor(bridge, root) {
    this.root = root
    this.bridge = bridge
    this.last = 0
    this.current = null
    bridge.on_opening(() => this.read_request())
    this.read_request()
  }

  /** 无参数；向主进程领取一次性播放请求，刷新页面不会再次领取已消费的开屏。 */
  read_request() {
    this.bridge.get_opening().then(state => this.accept_request(state)).catch(() => {
      // 时间策略 IPC 异常时不遮挡正常界面。
    })
  }

  /** 参数 state：主进程播放决定；忽略过期或重复编号，仅播放明确要求重播的请求。 */
  accept_request(state) {
    if (!Number.isInteger(state?.requestId) || state.requestId <= this.last) return
    this.last = state.requestId
    if (!state.play) return
    this.current?.finish_opening()
    this.current = new OpeningScreen(this.root, state.source)
  }
}

if (window.synloveDesktop?.on_opening && window.synloveDesktop?.get_opening) {
  new OpeningPlayback(window.synloveDesktop, document.getElementById('opening-screen'))
}
