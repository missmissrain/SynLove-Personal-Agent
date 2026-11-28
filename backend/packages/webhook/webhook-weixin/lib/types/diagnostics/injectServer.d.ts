/**
 * 本机调试注入口 + 管理口：把一条"用户消息"直接塞进真实的入站管线，
 * 并提供几个**只有本进程能做**的维护动作（清空记忆、看记忆体量）。
 *
 * 存在的理由：微信入站只能靠扫码后的 iLink 长轮询，开发和回归测试时每验证一次
 * 都要用真手机发一条微信，效率极低。这个本地端口让调用方（脚本/自动化）绕过 iLink，
 * 但仍走**同一条**下游链路：
 *
 *   delivery 登记 → InboundCoordinator → agent loop → outbox → 微信发送
 *
 * 所以它验证的是真实行为，而不是一个旁路替身。
 *
 * 为什么清空记忆必须走这个进程：`~/.dsh/timeline`、`~/.dsh/graph` 有内存缓存、
 * 会话上下文还被 agent 句柄持有（删文件前必须先 dispose）。外部进程直接删文件
 * 要么留下脏缓存、要么写出坏会话文件——所以这些动作只能由持有它们的进程执行。
 *
 * 安全约束（三道）：
 * 1. 只在显式设置 `DSH_WEIXIN_INJECT_PORT` 时启用，默认完全关闭；
 * 2. 只绑定 `127.0.0.1`，不对外网暴露；
 * 3. 只接受 POST，且请求体必须是 JSON。
 *
 * @module dsh-webhook-weixin/inject-server
 */
import { type Server } from 'node:http';
/** 注入口配置。 */
export interface InjectServerOptions {
    /** 监听端口。 */
    readonly port: number;
    /**
     * 实际注入实现；由连接器提供（它持有真实的 InboundCoordinator）。
     * 抛错会以 4xx/5xx 返回给调用方，便于脚本判断。
     */
    readonly inject: (input: {
        text: string;
        user_id?: string;
    }) => Promise<{
        delivery_id: string;
        session_id?: string;
    }>;
    /**
     * 管理动作（可选）：`POST /admin/<action>`。
     * 不传就不挂管理口，只保留 `/inject`。
     */
    readonly admin?: (action: string, body: Record<string, unknown>) => Promise<unknown>;
}
/**
 * 启动注入口；返回的 Server 需要由调用方在卸载时 close。
 *
 * @param options - 端口与注入/管理实现。
 * @returns 已开始监听的 HTTP server。
 */
export declare function start_inject_server(options: InjectServerOptions): Server;
//# sourceMappingURL=injectServer.d.ts.map