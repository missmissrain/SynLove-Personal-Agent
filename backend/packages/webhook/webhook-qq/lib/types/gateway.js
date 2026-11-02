export class QqGateway {
    options;
    socket;
    heartbeat;
    handshake;
    reconnect;
    controller;
    seq = 0;
    sessionId = '';
    stopped = true;
    attempt = 0;
    generation = 0;
    awaiting_ack = false;
    ready = false;
    interval_ms = 30_000;
    kick_times = [];
    cooldown_until = 0;
    constructor(options){
        this.options = options;
    }
    start() {
        if (!this.stopped) return;
        this.stopped = false;
        void this.connect();
    }
    stop() {
        this.stopped = true;
        this.generation++;
        this.clear_connection();
        this.ready = false;
        if (this.reconnect !== undefined) clearTimeout(this.reconnect);
        this.reconnect = undefined;
        this.health('stopped');
    }
    health(phase) {
        this.options.on_health?.({
            phase,
            expires_at: Date.now() + Math.max(30_000, this.interval_ms * 2 + 5_000)
        });
    }
    clear_connection() {
        if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
        if (this.handshake !== undefined) clearTimeout(this.handshake);
        this.heartbeat = undefined;
        this.handshake = undefined;
        this.controller?.abort();
        this.controller = undefined;
        const socket = this.socket;
        this.socket = undefined;
        try {
            socket?.close();
        } catch (error) {
            this.options.log?.(`gateway 关闭失败：${String(error).slice(0, 80)}`);
        }
    }
    fail_connection(gen, reason) {
        if (this.stopped || gen !== this.generation) return;
        this.generation++;
        this.ready = false;
        this.clear_connection();
        this.health('reconnecting');
        const delay = Math.max(this.cooldown_until - Date.now(), Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5)));
        this.options.log?.(`gateway ${reason}，${Math.round(delay / 1000)}s 后重连`);
        if (this.reconnect !== undefined) clearTimeout(this.reconnect);
        this.reconnect = setTimeout(()=>{
            this.reconnect = undefined;
            if (!this.stopped) void this.connect();
        }, delay);
    }
    async connect() {
        if (this.stopped) return;
        const gen = ++this.generation;
        const live = ()=>!this.stopped && gen === this.generation;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.health('connecting');
        this.handshake = setTimeout(()=>this.fail_connection(gen, '握手超时'), this.options.handshake_timeout_ms ?? 30_000);
        try {
            const token = await this.options.token();
            if (!live()) return;
            const response = await fetch(`${this.options.baseUrl ?? 'https://api.bot.qq.com'}/gateway`, {
                headers: {
                    Authorization: `QQBot ${token}`
                },
                signal
            });
            if (!response.ok) throw new Error(`GET /gateway HTTP ${response.status}`);
            const body = await response.json();
            if (!live()) return;
            if (!body.url) throw new Error('GET /gateway 没返回 url');
            const socket = new WebSocket(body.url);
            this.socket = socket;
            socket.addEventListener('open', ()=>{
                if (live()) this.options.log?.('gateway 已连接');
            });
            socket.addEventListener('message', (event)=>{
                if (!live()) return;
                void this.handle_frame(String(event.data), gen).catch((error)=>this.fail_connection(gen, `处理帧失败：${String(error).slice(0, 120)}`));
            });
            socket.addEventListener('close', ()=>this.fail_connection(gen, '断开'));
            socket.addEventListener('error', ()=>this.fail_connection(gen, '连接错误'));
        } catch (error) {
            this.fail_connection(gen, `连接失败：${String(error).slice(0, 120)}`);
        }
    }
    async handle_frame(raw, gen = this.generation) {
        if (this.stopped || gen !== this.generation) return;
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch  {
            return;
        }
        switch(frame.op){
            case 10:
                {
                    const interval = Number(frame.d?.heartbeat_interval ?? 30_000);
                    if (!Number.isFinite(interval) || interval < 1_000) throw new Error('心跳间隔无效');
                    this.interval_ms = interval;
                    await this.identify(gen);
                    return;
                }
            case 11:
                this.awaiting_ack = false;
                this.health(this.ready ? 'healthy' : 'connecting');
                this.options.log?.('gateway 心跳已确认');
                return;
            case 0:
                if (typeof frame.s === 'number') this.seq = frame.s;
                if (frame.t === 'READY' || frame.t === 'RESUMED') {
                    const id = frame.d?.session_id;
                    if (id) this.sessionId = id;
                    if (this.handshake !== undefined) clearTimeout(this.handshake);
                    this.handshake = undefined;
                    this.ready = true;
                    this.attempt = 0;
                    this.start_heartbeat(this.interval_ms, gen);
                    this.health('ready');
                    this.options.log?.('gateway READY');
                } else if (frame.t === 'C2C_MESSAGE_CREATE' || frame.t === 'GROUP_AT_MESSAGE_CREATE') {
                    this.options.on_event({
                        t: frame.t,
                        d: frame.d ?? {}
                    });
                }
                return;
            case 7:
                this.kick_times = this.kick_times.filter((at)=>Date.now() - at < 600_000);
                this.kick_times.push(Date.now());
                if (this.kick_times.length >= 5) {
                    this.cooldown_until = Date.now() + 300_000;
                    this.kick_times = [];
                }
                this.fail_connection(gen, '要求重连（op=7）');
                return;
            case 9:
                this.sessionId = '';
                this.seq = 0;
                this.fail_connection(gen, '会话失效（op=9）');
                return;
            default:
                return;
        }
    }
    start_heartbeat(interval, gen) {
        if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
        this.interval_ms = interval;
        this.awaiting_ack = false;
        const send = ()=>{
            if (this.stopped || gen !== this.generation) return;
            if (this.awaiting_ack) {
                this.fail_connection(gen, '心跳确认超时');
                return;
            }
            try {
                if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('socket 未打开');
                this.socket.send(JSON.stringify({
                    op: 1,
                    d: this.seq
                }));
                this.awaiting_ack = true;
            } catch (error) {
                this.fail_connection(gen, `心跳发送失败：${String(error).slice(0, 80)}`);
            }
        };
        send();
        if (!this.stopped && gen === this.generation) this.heartbeat = setInterval(send, interval);
    }
    async identify(gen) {
        const token = await this.options.token();
        if (this.stopped || gen !== this.generation) return;
        const payload = this.sessionId === '' ? {
            op: 2,
            d: {
                token: `QQBot ${token}`,
                intents: this.options.intents ?? 1 << 25,
                shard: [
                    0,
                    1
                ],
                properties: {}
            }
        } : {
            op: 6,
            d: {
                token: `QQBot ${token}`,
                session_id: this.sessionId,
                seq: this.seq
            }
        };
        this.socket?.send(JSON.stringify(payload));
    }
}
