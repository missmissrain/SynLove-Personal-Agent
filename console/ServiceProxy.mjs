/**
 * GUI与远端核心API的代理。ServiceProxy(project) 默认本机模式；external只请求远程，不操作本机状态。
 * 配置来自serviceConfig.json及SYNLOVE_CORE_*环境变量，密钥不下发浏览器。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class ServiceProxy {
  /** project为链路根目录；测试可传env替换进程环境。 */
  constructor(project, env = process.env) {
    const path = env.SYNLOVE_SERVICE_CONFIG || join(project, 'config', 'serviceConfig.json')
    const data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    const cfg = data.services?.core ?? {}
    this.mode = env.SYNLOVE_CORE_MANAGEMENT
      || (env.SYNLOVE_CORE_BASE_URL ? 'external' : cfg.management) || 'managed'
    this.url = (env.SYNLOVE_CORE_BASE_URL || cfg.baseURL || 'http://127.0.0.1:8790/v1').replace(/\/$/, '')
    const url = new URL(this.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('核心服务地址非法')
    }
    this.key = env[cfg.apiKeyEnv || 'SYNLOVE_CORE_API_KEY'] || ''
    this.timeout = Math.min(240, Number(cfg.timeoutSeconds ?? 240)) * 1000
  }

  /** req/res为本机HTTP连接，url为已解析路径；返回true表示由远端核心接管。 */
  handle(req, res, url) {
    if (this.mode !== 'external' || !url.pathname.startsWith('/api/')) return false
    void this.forward(req, res, url)
    return true
  }

  /** req/res为客户端连接，url只允许原始API路径，拒绝重定向和超限正文。 */
  async forward(req, res, url) {
    const headers = { 'Content-Type': 'application/json' }
    if (this.key) headers.Authorization = `Bearer ${this.key}`
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new Error('不支持的请求方法')
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) throw new Error('请求超过1MiB')
        chunks.push(chunk)
      }
      const response = await fetch(`${this.url}/core?path=${encodeURIComponent(url.pathname + url.search)}`, {
        method: req.method, headers, redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      })
      const reader = response.body.getReader()
      const parts = []
      let total = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          total += value.length
          if (total > 8 * 1024 * 1024) throw new Error('响应超过8MiB')
          parts.push(Buffer.from(value))
        }
      } finally { await reader.cancel().catch(() => {}) }
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(Buffer.concat(parts))
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '远端核心服务不可用，未执行本机替代操作' }))
    }
  }
}
