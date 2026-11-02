/**
 * 本机远控管理路由：同源校验、有界 JSON 请求及脱敏错误响应。
 * 注册参数 store 为目标配置管理器、port 为本地控制台端口，默认 3082。
 * 不允许外部网页或非本机 Host 读取配置与提交探测；不代理任意远程命令。
 */
export class RemoteConnectionRoutes {
  /** 参数 store/port 为配置管理器和控制台监听端口。 */
  constructor(store, port = 3082) { this.store = store; this.port = port }

  /** 参数 req 为请求；仅接受本机 Host、同源请求和 JSON 写入，防止跨站配置修改。 */
  check_request(req) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]
    if (!hosts.includes(req.headers.host)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) return false
    return req.method === 'GET' || (req.method === 'POST' &&
      /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))
  }

  /** 参数 req/res/url 为 HTTP 对象；匹配远控路由后负责响应并返回 true。 */
  handle_request(req, res, url) {
    if (!url.pathname.startsWith('/api/remote/')) return false
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!this.check_request(req)) { send(403, { error: '只允许从本机控制台配置远程连接' }); return true }
    if (req.method === 'GET') {
      try {
        if (url.pathname !== '/api/remote/targets') send(404, { error: '接口不存在' })
        else send(200, this.store.list_targets())
      } catch { send(400, { error: '远控配置读取失败，请检查本机 JSON 文件' }) }
      return true
    }
    let body = '', size = 0, exceeded = false
    req.setEncoding('utf8')
    req.on('data', text => {
      size += Buffer.byteLength(text)
      if (size > 32768) { exceeded = true; return }
      body += text
    })
    req.on('end', async () => {
      try {
        if (exceeded) throw new Error('配置请求过大')
        const data = JSON.parse(body)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求必须为对象')
        let reply
        if (url.pathname === '/api/remote/targets') reply = this.store.save_target(data)
        else if (url.pathname === '/api/remote/delete') reply = this.store.delete_target(data.id)
        else if (url.pathname === '/api/remote/key') reply = await this.store.probe_target({ action: 'peekKey', host: data.host, port: data.port })
        else if (url.pathname === '/api/remote/probe') reply = await this.store.probe_target({ action: 'probe', target: data.id })
        else { send(404, { error: '接口不存在' }); return }
        send(200, reply)
      } catch (error) {
        send(400, { error: error instanceof SyntaxError ? '本机配置或请求 JSON 格式错误' : error.message })
      }
    })
    return true
  }
}
