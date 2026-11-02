/**
 * 远控连接心跳：只检查已保存、启用且有凭据的电脑，复用固定SSH/CMD探测，不执行任意指令。
 * 参数store为现有配置管理器，interval默认45秒；同一轮未结束不再启动下一轮。
 */
export class RemoteConnectionHeartbeat {
  /** store为探测存储，interval为心跳毫秒；不在构造函数发起网络请求。 */
  constructor(store, interval = 45000) {
    this.store = store
    this.interval = interval
    this.running = false
    this.stopped = false
  }

  /** 无参数；顺序探测已授权目标，单个失败由原存储记灰，不阻断其他目标。 */
  async check_targets() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      const targets = this.store.list_targets().targets.filter(item => item.enabled && item.hasCredential)
      for (const target of targets) {
        if (this.stopped) break
        try { await this.store.probe_target({ action: 'probe', target: target.id }) } catch {}
      }
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
