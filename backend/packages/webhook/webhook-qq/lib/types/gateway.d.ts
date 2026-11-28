/**
 * QQ WebSocket 网关：管理连接代次、握手超时、心跳确认和退避重连。
 * 参数：token 取令牌，on_event 处理业务，on_health 报告活性；
 * baseUrl 默认官方地址，intents 默认群与私聊，handshake_timeout_ms 默认 30000。
 */
export interface QqGatewayEvent {
    readonly t: string;
    readonly d: Record<string, unknown>;
}
export interface QqGatewayOptions {
    readonly token: () => Promise<string>;
    readonly intents?: number;
    readonly baseUrl?: string;
    readonly on_event: (event: QqGatewayEvent) => void;
    readonly log?: (message: string) => void;
    readonly handshake_timeout_ms?: number;
    readonly on_health?: (state: {
        phase: string;
        expires_at: number;
    }) => void;
}
export declare class QqGateway {
    private readonly options;
    private socket;
    private heartbeat;
    private handshake;
    private reconnect;
    private controller;
    private seq;
    private sessionId;
    private stopped;
    private attempt;
    private generation;
    private awaiting_ack;
    private ready;
    private interval_ms;
    private kick_times;
    private cooldown_until;
    /** options 指定鉴权和事件处理；构造不联网。 */
    constructor(options: QqGatewayOptions);
    /** 无参数；幂等启动一个连接生命周期。 */
    start(): void;
    /** 无参数；取消资源并使旧异步回调失效。 */
    stop(): void;
    /** phase 为阶段；以实际心跳周期计算健康证据有效期。 */
    private health;
    /** 无参数；释放连接资源，不负责重连。 */
    private clear_connection;
    /** gen 为连接代次，reason 为原因；当前连接最多安排一个重连。 */
    private fail_connection;
    /** 无参数；令牌、取地址、WebSocket 握手共用同一取消与超时边界。 */
    private connect;
    /** raw 为协议帧，gen 为连接代次；确认和业务事件只作用于当前连接。 */
    private handle_frame;
    /** interval 为心跳周期，gen 为连接代次；确认超时立即废弃旧连接。 */
    private start_heartbeat;
    /** gen 为所属连接代次；取令牌后再核验代次，防止 stop 后复活。 */
    private identify;
}
//# sourceMappingURL=gateway.d.ts.map