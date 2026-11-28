/**
 * 观测 HTTP 接口：只暴露查询和人工评分，与服务控制、模型调用及业务队列分离。
 * 注册参数 store：ObservationStore；origin：本机控制台来源地址。
 * 默认评分正文上限 8192 字节；所有异常仅转成当前请求的错误响应。
 */
export class ObservationRoutes {
  /** 参数 store/origin：观测数据访问对象和允许写入的页面来源。 */
  constructor(store, origin) {
    this.store = store
    this.origins = new Set([origin, origin.replace('127.0.0.1', 'localhost')])
  }

  /** 参数 res/status/body：HTTP 响应、状态码、JSON；未发送响应时写入一次。 */
  send(res, status, body) {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** 参数 req/res/url：HTTP 请求、响应、解析地址；返回是否属于本模块的接口。 */
  handle(req, res, url) {
    if (!['/api/observations', '/api/observations/detail', '/api/observations/trends', '/api/observations/score'].includes(url.pathname)) return false
    const send = data => this.send(res, 200, data)
    const fail = error => this.send(res, 400, { error: error instanceof Error ? error.message : '观测请求失败' })
    if (req.method === 'GET' && url.pathname !== '/api/observations/score') {
      const read = async () => {
        if (url.pathname === '/api/observations/detail') return this.store.detail(url.searchParams.get('traceId') ?? '')
        await this.store.sync_remote()
        return url.pathname === '/api/observations/trends'
          ? this.store.trends(url.searchParams.get('days'))
          : this.store.list(Object.fromEntries(url.searchParams))
      }
      void read().then(send, fail)
      return true
    }
    if (req.method !== 'POST' || url.pathname !== '/api/observations/score') {
      this.send(res, 405, { error: '此观测接口不支持该方法' })
      return true
    }
    if (req.headers.origin && !this.origins.has(req.headers.origin)) {
      this.send(res, 403, { error: '不接受其他站点提交的评分' })
      return true
    }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      this.send(res, 415, { error: '需要 JSON 请求' })
      return true
    }
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > 8192) {
        if (!rejected) this.send(res, 413, { error: '评分内容超过上限' })
        rejected = true
        chunks.length = 0
      } else if (!rejected) chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      try { void this.store.set_score(JSON.parse(Buffer.concat(chunks).toString('utf8'))).then(send, fail) } catch (error) { fail(error) }
    })
    req.on('error', () => { /* 客户端断开时不写评分。 */ })
    return true
  }
}
