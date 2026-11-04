/**
 * 终端设备GUI路由：同源校验、有界请求，代理独立管理器的固定接口。
 * 参数store为终端桥接客户端，port默认3082；接入文件仅显式生成时返回且禁止缓存。
 */
export class TerminalConnectionRoutes {
  /** store/port为桥接客户端与GUI本机端口。 */
  constructor(store, port = 3082) { this.store = store; this.port = port }

  /** req为请求；拒绝非本机Host、跨站Origin及非JSON写请求。 */
  check_request(req) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]
    return hosts.includes(req.headers.host) && req.headers['sec-fetch-site'] !== 'cross-site' &&
      (!req.headers.origin || hosts.some(host => req.headers.origin === `http://${host}`)) &&
      (req.method === 'GET' || (req.method === 'POST' &&
        /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')))
  }

  /** req/res/url为HTTP对象；仅处理终端设备固定路由，不开放任意地址或命令代理。 */
  handle_request(req, res, url) {
    if (!url.pathname.startsWith('/api/remote/')) return false
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (!this.check_request(req)) { send(403, { error: '只允许从本机控制台管理设备' }); return true }
    if (req.method === 'GET') {
      if (!['/api/remote/devices', '/api/remote/targets'].includes(url.pathname)) send(404, { error: '接口不存在' })
      else this.store.list_devices().then(value => send(200, value))
        .catch(() => send(503, { error: '终端管理器未连接' }))
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
        if (exceeded) throw new Error('请求过大')
        const data = JSON.parse(body)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求必须为对象')
        let result
        if (url.pathname === '/api/remote/device') result = await this.store.save_device(data)
        else if (url.pathname === '/api/remote/pair') result = await this.store.register_device(data, true)
        else if (url.pathname === '/api/remote/reserve') result = await this.store.register_device(data, false)
        else if (url.pathname === '/api/remote/probe') result = await this.store.probe_device(data.id)
        else { send(404, { error: '接口不存在' }); return }
        send(200, result)
      } catch { send(400, { error: '设备操作未成功，请检查登记信息及终端管理器状态' }) }
    })
    return true
  }
}
