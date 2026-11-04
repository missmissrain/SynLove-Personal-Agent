/**
 * 单一任务 MCP：同宿主进程的随机回环 HTTP 端口；会话令牌绑定归属，不接收模型提供的用户与回调地址。
 * 参数 runtime 为任务服务；请求上限 64KiB，工具只提交/查询/补充/取消/读取结果，不等待长任务完成。
 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

export class TaskMcpServer {
  server?: Server
  url = ''
  tokens = new Map<string, any>()
  /** runtime 为唯一任务运行器，不能通过请求替换。 */
  constructor(private runtime: any) {}
  /** 无参数；端口由操作系统分配，不增加服务进程或固定端口冲突。 */
  async start_server(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const reply = (status: number, body?: any) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(body === undefined ? undefined : JSON.stringify(body))
      }
      const owner = this.tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!owner || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')
        || req.headers.origin || req.url !== '/mcp/tasks') { reply(403); return }
      if (req.method !== 'POST') { reply(405); return }
      if (!String(req.headers['content-type']).startsWith('application/json')) { reply(415); return }
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of req) {
          size += chunk.length
          if (size > 65536) { reply(413); return }
          chunks.push(Buffer.from(chunk))
        }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (message.id === undefined) { reply(202); return }
        let result: any
        if (message.method === 'initialize') result = {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'synlove-task', version: '1.0.0' },
        }
        else if (message.method === 'ping') result = {}
        else if (message.method === 'tools/list') result = { tools: this.list_tools() }
        else if (message.method === 'tools/call') {
          try {
            const value = await this.runtime.call_tool(owner, message.params?.name, message.params?.arguments ?? {})
            result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
          } catch (error) {
            result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '任务操作失败' }] }
          }
        } else { reply(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported method' } }); return }
        reply(200, { jsonrpc: '2.0', id: message.id, result })
      } catch { reply(400, { error: 'invalid JSON-RPC request' }) }
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}/mcp/tasks`
  }
  /** owner 为宿主提供的会话信息；临时令牌永不进入模型参数。 */
  bind_owner(owner: any): string {
    const token = randomBytes(32).toString('hex')
    this.tokens.set(token, owner)
    return token
  }
  /** token 为已释放主人格的临时能力令牌。 */
  revoke_owner(token: string): void { this.tokens.delete(token) }
  /** 无参数；返回稳定的五个工具，避免每轮工具前缀变化。 */
  list_tools(): any[] {
    const text = { type: 'string', minLength: 1, maxLength: 12000 }
    const id = { type: 'string', minLength: 1, maxLength: 80 }
    const make = (name: string, description: string, properties: any, required: string[] = []) => ({
      name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required },
    })
    return [
      make('task_submit', '把操作或长任务交给独立后台会话，立即返回任务ID。只能用于新建任务；给进行中的任务补充要求要用 task_message，不能用本工具。成功后用自己的自然语气告知用户已经交到后台处理；失败时不得说已开始。不要等待任务结束。', {
        request: text,
        originId: { type: 'string', minLength: 1, maxLength: 512, description: '仅当工具提示本轮有多个通道来源时，从返回的可信候选中选择对应原消息。不能填写用户或回调地址。' },
      }, ['request']),
      make('task_status', '查询真实进度；不填taskId列当前用户近期任务，不要反复轮询等待。', { taskId: id }),
      make('task_message', '给指定进行中的任务补充要求，返回接收状态；不能把普通聊天自动转发过去。', { taskId: id, message: text }, ['taskId', 'message']),
      make('task_cancel', '停止指定后台任务；收到确认前不能说已经停止。多个任务且目标不明确时先问用户。', { taskId: id }, ['taskId']),
      make('task_result', '读取任务保存的最终总结；完整结果分页返回，保留失败、风险、未验证项。', {
        taskId: id, offset: { type: 'integer', minimum: 0 },
      }, ['taskId']),
    ]
  }
  /** 无参数；关闭本运行器的监听并撤销所有临时令牌。 */
  async close_server(): Promise<void> {
    this.tokens.clear()
    if (this.server) await new Promise<void>(resolve => {
      this.server!.close(() => resolve())
      this.server!.closeAllConnections()
    })
  }
}
