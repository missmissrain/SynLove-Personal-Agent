/**
 * QQ 本机管理口：只接受回环请求，把网关生成的回复按被动消息发出。
 * 参数：port 为监听端口，send 为实际发送实现（带 msg_id 时走被动回复）。
 */
import { createServer, type Server } from 'node:http'

export interface QqAdminOptions {
  readonly port: number
  readonly send: (text: string, target: unknown, msgId?: string) => Promise<{ ok: boolean; error?: string }>
}

export function start_qq_admin_server(options: QqAdminOptions): Server {
  const server = createServer((request, response) => {
    const reply = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload)
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(body)
    }
    if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== '/send') {
      reply(404, { ok: false, error: 'only POST /send is supported' })
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      } catch {
        reply(400, { ok: false, error: 'body must be JSON' })
        return
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '' || body.target === undefined) {
        reply(400, { ok: false, error: 'text and target are required' })
        return
      }
      const msgId = typeof body.msgId === 'string' && body.msgId !== '' ? body.msgId : undefined
      options.send(text, body.target, msgId).then(
        (result) => reply(result.ok ? 200 : 502, result),
        (error) => reply(500, { ok: false, error: String(error).slice(0, 200) }),
      )
    })
  })
  server.listen(options.port, '127.0.0.1')
  return server
}
