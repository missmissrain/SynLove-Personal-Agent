/**
 * 业务端点只读查询。参数cfg为注册配置、fetcher为HTTP、key为密钥；只允许健康和快照查询。
 * Relay模式走真实任务报文，节点在线不能替代后台协议探活。
 */
export class BusinessEndpoint {
  /** cfg为固定端点；fetcher默认fetch；key只在请求头使用。 */
  constructor(cfg, fetcher = fetch, key = '') {
    this.cfg = cfg
    this.fetcher = fetcher
    this.headers = key ? { Authorization: `Bearer ${key}` } : {}
  }

  /** path为/health或/snapshot；返回业务JSON，拒绝未知身份、HTTP错误及超时。 */
  async read_status(path) {
    if (!['/health', '/snapshot'].includes(path)) throw Error('只允许只读状态查询')
    const request = async (method, url, body) => {
      const res = await this.fetcher(url, {
        method, headers: { ...this.headers, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) { await res.body?.cancel(); throw Error(`HTTP ${res.status}`) }
      return res.json()
    }
    const base = this.cfg.baseURL.replace(/\/$/, '')
    if (this.cfg.transport !== 'relay') return request('GET', base + path)
    const capability = this.cfg.relayCapability
    if (!['crawlerCenter', 'webCollection', 'scheduler', 'video'].includes(capability)) {
      throw Error('未配置业务能力')
    }
    const catalog = await request('GET', base + '/capabilities')
    if (!catalog.capabilities?.some(row => row.name === capability && row.nodes > 0 && row.capacity > 0)) {
      throw Error('远端业务能力尚未上线')
    }
    let task = await request('POST', base + '/tasks', {
      capability, input: { method: 'GET', path: path === '/health' ? '/health' : '/v1/snapshot' },
      timeoutMs: 15000,
    })
    const id = task.id
    if (typeof id !== 'string') throw Error('中转任务协议无效')
    const deadline = Date.now() + 17000
    while (!['done', 'failed', 'expired', 'cancelled'].includes(task.status)) {
      if (Date.now() > deadline) throw Error('远端业务查询超时')
      await new Promise(resolve => setTimeout(resolve, 350))
      task = await request('GET', base + '/tasks/' + encodeURIComponent(id))
    }
    if (task.status !== 'done' || task.payload?.status !== 200) throw Error('远端业务不可用')
    return task.payload.body
  }
}
