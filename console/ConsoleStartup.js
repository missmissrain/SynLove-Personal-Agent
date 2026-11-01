/**
 * GUI启动协调器：完整打开程序时请求启动后台，重复请求合并，托盘恢复不触发。
 * 注册参数 url：本机控制台地址；fetcher：请求实现，默认fetch；log：只记录状态的回调。
 */
class ConsoleStartup {
  /** 参数url/fetcher/log为固定控制台及依赖；不在这里管理模型或消息消费者。 */
  constructor({ url, fetcher = fetch, log = () => {} }) {
    this.url = url
    this.fetcher = fetcher
    this.log = log
    this.pending = null
  }

  /** 无参数；只请求统一启动入口，返回已接受而不冒充后端已就绪。 */
  request_start() {
    if (this.pending) return this.pending
    this.pending = this.fetcher(`${this.url}/api/service`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }), signal: AbortSignal.timeout(10_000),
    }).then(async response => {
      const data = await response.json()
      if (!response.ok || data.error) throw new Error('startup request rejected')
      this.log('后台启动请求已接收；以实际连接状态为准')
      return true
    }).catch(() => {
      this.log('后台启动请求失败，请查看控制台启动日志')
      return false
    }).finally(() => { this.pending = null })
    return this.pending
  }
}

module.exports = { ConsoleStartup }
