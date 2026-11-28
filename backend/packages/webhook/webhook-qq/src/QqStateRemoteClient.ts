/**
 * QQ 状态远程客户端：通过统一 HTTP/MCP RPC 访问 qqstate 微服务。
 * 参数：base_url、api_key、timeout_ms；默认读取 SYNLOVE_QQSTATE_* 环境变量。
 * 本类不连接 QQ，不保存本地 outbox 或租约副本。
 */

type Json = Record<string, unknown>

function normalize_row(row: Json): Json {
  return {
    ...row,
    ...(typeof row.msg_id === 'string' ? { msgId: row.msg_id } : {}),
    ...(Array.isArray(row.sent_parts) ? { sent_parts: row.sent_parts } : { sent_parts: [] }),
  }
}

export class QqStateRemoteClient {
  private readonly base_url: string
  private readonly api_key: string
  private readonly timeout_ms: number

  /** 读取环境配置并创建远程状态客户端。 */
  constructor(options: { base_url?: string; api_key?: string; timeout_ms?: number } = {}) {
    this.base_url = (options.base_url ?? process.env.SYNLOVE_QQSTATE_BASE_URL
      ?? 'http://127.0.0.1:8799/v1').replace(/\/+$/, '')
    this.api_key = options.api_key ?? process.env.SYNLOVE_QQSTATE_API_KEY ?? ''
    this.timeout_ms = Math.max(1_000, Math.min(120_000, options.timeout_ms ?? 30_000))
  }

  /** 调用 qqstate 服务工具，必要时等待异步操作完成。 */
  private async call(name: string, arguments_: Json = {}): Promise<Json> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout_ms)
    try {
      const response = await fetch(`${this.base_url}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` }),
        },
        body: JSON.stringify({
          requestId: `qqstate-${crypto.randomUUID()}`,
          message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } },
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`qqstate 服务 HTTP ${response.status}`)
      let operation = await response.json() as Json
      while (operation.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 100))
        const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(String(operation.requestId ?? ''))}`, {
          headers: this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` },
          signal: controller.signal,
        })
        operation = await status.json() as Json
      }
      if (operation.state !== 'done') throw new Error(`qqstate 服务任务状态 ${String(operation.state)}`)
      const outer = (operation.result as Json | undefined) ?? {}
      const rpc = (outer.result as Json | undefined) ?? outer
      if (rpc.isError === true) throw new Error(String(rpc.content ?? 'qqstate 服务调用失败'))
      return (rpc.structuredContent as Json | undefined) ?? {}
    } finally {
      clearTimeout(timer)
    }
  }

  /** 幂等加入 QQ outbox。 */
  async enqueue(reply: Json): Promise<Json> {
    return normalize_row((await this.call('qq_enqueue', { reply })).outbox as Json)
  }
  /** 读取待发送 QQ outbox。 */
  async list_pending(limit = 1024): Promise<Json[]> {
    const rows = (await this.call('qq_list_pending', { limit })).outbox
    return Array.isArray(rows) ? rows.map(row => normalize_row(row as Json)) : []
  }
  /** 记录分段已发送。 */
  async mark_part_sent(id: string, index: number): Promise<void> {
    await this.call('qq_mark_part_sent', { id, index })
  }
  /** 标记消息成功并从队列删除。 */
  async mark_sent(id: string): Promise<void> { await this.call('qq_mark_sent', { id }) }
  /** 标记失败并设置下次重试时间。 */
  async mark_failed(id: string, error: string, next_at: number, terminal: boolean): Promise<void> {
    await this.call('qq_mark_failed', { id, error, nextAt: next_at, terminal })
  }
  /** 原子获取 QQ 网关租约。 */
  async acquire_lease(input: Json): Promise<boolean> {
    return (await this.call('qq_acquire_lease', input)).acquired === true
  }
  /** 续租 QQ 网关租约。 */
  async heartbeat_lease(owner_id: string): Promise<boolean> {
    return (await this.call('qq_heartbeat_lease', { ownerId: owner_id })).updated === true
  }
  /** 释放 QQ 网关租约。 */
  async release_lease(owner_id: string): Promise<void> {
    await this.call('qq_release_lease', { ownerId: owner_id })
  }
}
