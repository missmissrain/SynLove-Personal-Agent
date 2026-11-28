/**
 * 终端管理器健康读取：设备心跳归独立服务维护，GUI不再建立第二套SSH设备探活。
 * 参数store为终端管理桥接客户端，interval默认45秒；同一轮未结束不再启动下一轮。
 */
export class RemoteConnectionHeartbeat {
  /** store为探测存储，interval为心跳毫秒；不在构造函数发起网络请求。 */
  constructor(store, interval = 45000) {
    this.store = store
    this.interval = interval
    this.running = false
    this.stopped = false
  }

  /** 无参数；被动验证终端管理器接口，不写入或覆盖设备在线状态。 */
  async check_targets() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      await this.store.refresh_devices()
    } catch {
      // 配置损坏时不猜测目标；旧证据会自然过期，界面不再显示在线。
    } finally { this.running = false }
  }

  /** 无参数；启动一次即时探测和低频轮询；重复调用不会创建第二个定时器。 */
  start_heartbeat() {
    if (this.timer) return
    this.stopped = false
    void this.check_targets()
    this.timer = setInterval(() => { void this.check_targets() }, this.interval)
    this.timer.unref?.()
  }

  /** 无参数；停止新探测；当前有界探测由原执行器按超时收尾。 */
  stop_heartbeat() {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
  }
}
