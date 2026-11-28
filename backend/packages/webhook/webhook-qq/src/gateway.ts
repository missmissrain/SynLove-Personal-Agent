/**
 * QQ WebSocket 网关：管理连接代次、握手超时、心跳确认和退避重连。
 * 参数：token 取令牌，on_event 处理业务，on_health 报告活性；
 * baseUrl 默认官方地址，intents 默认群与私聊，handshake_timeout_ms 默认 30000。
 */
export interface QqGatewayEvent {
  readonly t: string
  readonly d: Record<string, unknown>
}
export interface QqGatewayOptions {
  readonly token: () => Promise<string>
  readonly intents?: number
  readonly baseUrl?: string
  readonly on_event: (event: QqGatewayEvent) => void
  readonly log?: (message: string) => void
  readonly handshake_timeout_ms?: number
  readonly on_health?: (state: { phase: string; expires_at: number }) => void
}

export class QqGateway {
  private socket: WebSocket | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private handshake: ReturnType<typeof setTimeout> | undefined
  private reconnect: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private seq = 0
  private sessionId = ''
  private stopped = true
  private attempt = 0
  private generation = 0
  private awaiting_ack = false
  private ready = false
  private interval_ms = 30_000
  private kick_times: number[] = []
  private cooldown_until = 0

  /** options 指定鉴权和事件处理；构造不联网。 */
  constructor(private readonly options: QqGatewayOptions) {}

  /** 无参数；幂等启动一个连接生命周期。 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.connect()
  }

  /** 无参数；取消资源并使旧异步回调失效。 */
  stop(): void {
    this.stopped = true
    this.generation++
    this.clear_connection()
    this.ready = false
    if (this.reconnect !== undefined) clearTimeout(this.reconnect)
    this.reconnect = undefined
    this.health('stopped')
  }

  /** phase 为阶段；以实际心跳周期计算健康证据有效期。 */
  private health(phase: string): void {
    this.options.on_health?.({ phase, expires_at: Date.now() + Math.max(30_000, this.interval_ms * 2 + 5_000) })
  }

  /** 无参数；释放连接资源，不负责重连。 */
  private clear_connection(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.handshake !== undefined) clearTimeout(this.handshake)
    this.heartbeat = undefined
    this.handshake = undefined
    this.controller?.abort()
    this.controller = undefined
    const socket = this.socket
    this.socket = undefined
    try { socket?.close() } catch (error) { this.options.log?.(`gateway 关闭失败：${String(error).slice(0, 80)}`) }
  }

  /** gen 为连接代次，reason 为原因；当前连接最多安排一个重连。 */
  private fail_connection(gen: number, reason: string): void {
    if (this.stopped || gen !== this.generation) return
    this.generation++
    this.ready = false
    this.clear_connection()
    this.health('reconnecting')
    const delay = Math.max(this.cooldown_until - Date.now(), Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5)))
    this.options.log?.(`gateway ${reason}，${Math.round(delay / 1000)}s 后重连`)
    if (this.reconnect !== undefined) clearTimeout(this.reconnect)
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      if (!this.stopped) void this.connect()
    }, delay)
  }

  /** 无参数；令牌、取地址、WebSocket 握手共用同一取消与超时边界。 */
  private async connect(): Promise<void> {
    if (this.stopped) return
    const gen = ++this.generation
    const live = (): boolean => !this.stopped && gen === this.generation
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.health('connecting')
    this.handshake = setTimeout(() => this.fail_connection(gen, '握手超时'), this.options.handshake_timeout_ms ?? 30_000)
    try {
      const token = await this.options.token()
      if (!live()) return
      const response = await fetch(`${this.options.baseUrl ?? 'https://api.bot.qq.com'}/gateway`, {
        headers: { Authorization: `QQBot ${token}` }, signal,
      })
      if (!response.ok) throw new Error(`GET /gateway HTTP ${response.status}`)
      const body = await response.json() as { url?: string }
      if (!live()) return
      if (!body.url) throw new Error('GET /gateway 没返回 url')
      const socket = new WebSocket(body.url)
      this.socket = socket
      socket.addEventListener('open', () => { if (live()) this.options.log?.('gateway 已连接') })
      socket.addEventListener('message', event => {
        if (!live()) return
        void this.handle_frame(String(event.data), gen).catch(error => this.fail_connection(gen, `处理帧失败：${String(error).slice(0, 120)}`))
      })
      socket.addEventListener('close', () => this.fail_connection(gen, '断开'))
      socket.addEventListener('error', () => this.fail_connection(gen, '连接错误'))
    } catch (error) {
      this.fail_connection(gen, `连接失败：${String(error).slice(0, 120)}`)
    }
  }

  /** raw 为协议帧，gen 为连接代次；确认和业务事件只作用于当前连接。 */
  private async handle_frame(raw: string, gen = this.generation): Promise<void> {
    if (this.stopped || gen !== this.generation) return
    let frame: { op?: number; d?: unknown; s?: number; t?: string }
    try { frame = JSON.parse(raw) as typeof frame } catch { return }
    switch (frame.op) {
      case 10: {
        const interval = Number((frame.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 30_000)
        if (!Number.isFinite(interval) || interval < 1_000) throw new Error('心跳间隔无效')
        // Hello 尚未完成鉴权；此时发心跳可能得不到 ACK，导致每个周期都误断线。
        // READY/RESUMED 携带的最新序号才是首次心跳的依据。
        this.interval_ms = interval
        await this.identify(gen)
        return
      }
      case 11:
        this.awaiting_ack = false
        this.health(this.ready ? 'healthy' : 'connecting')
        this.options.log?.('gateway 心跳已确认')
        return
      case 0:
        if (typeof frame.s === 'number') this.seq = frame.s
        if (frame.t === 'READY' || frame.t === 'RESUMED') {
          const id = (frame.d as { session_id?: string })?.session_id
          if (id) this.sessionId = id
          if (this.handshake !== undefined) clearTimeout(this.handshake)
          this.handshake = undefined
          this.ready = true
          this.attempt = 0
          this.start_heartbeat(this.interval_ms, gen)
          this.health('ready')
          this.options.log?.('gateway READY')
        } else if (frame.t === 'C2C_MESSAGE_CREATE' || frame.t === 'GROUP_AT_MESSAGE_CREATE') {
          this.options.on_event({ t: frame.t, d: (frame.d ?? {}) as Record<string, unknown> })
        }
        return
      case 7:
        this.kick_times = this.kick_times.filter(at => Date.now() - at < 600_000)
        this.kick_times.push(Date.now())
        if (this.kick_times.length >= 5) {
          this.cooldown_until = Date.now() + 300_000
          this.kick_times = []
        }
        this.fail_connection(gen, '要求重连（op=7）')
        return
      case 9:
        this.sessionId = ''
        this.seq = 0
        this.fail_connection(gen, '会话失效（op=9）')
        return
      default:
        return
    }
  }

  /** interval 为心跳周期，gen 为连接代次；确认超时立即废弃旧连接。 */
  private start_heartbeat(interval: number, gen: number): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.interval_ms = interval
    this.awaiting_ack = false
    const send = (): void => {
      if (this.stopped || gen !== this.generation) return
      if (this.awaiting_ack) { this.fail_connection(gen, '心跳确认超时'); return }
      try {
        if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('socket 未打开')
        this.socket.send(JSON.stringify({ op: 1, d: this.seq }))
        this.awaiting_ack = true
      } catch (error) { this.fail_connection(gen, `心跳发送失败：${String(error).slice(0, 80)}`) }
    }
    send()
    if (!this.stopped && gen === this.generation) this.heartbeat = setInterval(send, interval)
  }

  /** gen 为所属连接代次；取令牌后再核验代次，防止 stop 后复活。 */
  private async identify(gen: number): Promise<void> {
    const token = await this.options.token()
    if (this.stopped || gen !== this.generation) return
    const payload = this.sessionId === ''
      ? { op: 2, d: { token: `QQBot ${token}`, intents: this.options.intents ?? 1 << 25, shard: [0, 1], properties: {} } }
      : { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq } }
    this.socket?.send(JSON.stringify(payload))
  }
}
