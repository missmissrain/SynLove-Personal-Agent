/**
 * 微信入站传输层：只负责 HTTP 长轮询、协议错误分类、退避与规范化。
 *
 * 重构设计文档 §3.2：WeixinIngress **不**创建 Agent、**不**保存回复上下文、
 * **不**处理工具调用、**不**决定 Session 生命周期；它只把"一批原始消息"变成"一批规范化信封"。
 *
 * 状态归属：本模块只维护 HTTP 重试计数，不写任何持久状态（cursor 由协调器在批次完成后提交）。
 * @module dsh-webhook-weixin/ingress
 */
import type { IlinkClient } from '../api/ilinkClient.ts';
import { MessageNormalizer, type NormalizedWeixinMessage } from '../message/messageNormalizer.ts';
/** 传输层健康状态回调。 */
export interface IngressObserver {
    /** 协议/网络错误（已分类，供协调器决定是否继续）。 */
    on_error?(error: unknown): void;
    /** 状态变化（backoff/auth_required 等）。 */
    on_status?(status: string, detail?: string): void;
}
/** 一轮长轮询的结果。 */
export type IngressResult = {
    readonly kind: 'messages';
    readonly messages: NormalizedWeixinMessage[];
    readonly cursor: string | undefined;
} | {
    readonly kind: 'idle';
    readonly cursor: string | undefined;
} | {
    readonly kind: 'session_timeout';
} | {
    readonly kind: 'auth_required';
    readonly detail: string;
} | {
    readonly kind: 'protocol_error';
    readonly detail: string;
};
/** 构造参数。 */
export interface WeixinIngressOptions {
    readonly client: IlinkClient;
    readonly observer?: IngressObserver;
}
/** iLink getUpdates 的传输封装。 */
export declare class WeixinIngress {
    private readonly normalizer;
    private readonly client;
    private readonly observer;
    /** 绑定协议客户端与观察器。 */
    constructor(options: WeixinIngressOptions);
    /** 通知服务端消费者上线；失败抛出，由协调器决定是否致命。 */
    notify_start(signal?: AbortSignal): Promise<void>;
    /** 通知服务端消费者下线；尽力而为。 */
    notify_stop(signal?: AbortSignal): Promise<void>;
    /**
     * 执行一轮长轮询并规范化消息。
     *
     * 分类而非抛错：把"可继续"（超时/网络抖动）与"必须停止"（鉴权失效/未知协议）
     * 明确区分，交给协调器按设计文档 §10.2 处理，避免无限重试风暴。
     */
    poll(cursor: string, signal?: AbortSignal): Promise<IngressResult>;
    /** 下载媒体（供协调器的分片调度调用，不阻塞轮询）。 */
    download_media(media: Parameters<MessageNormalizer['hydrate_media']>[1] extends (m: infer M) => unknown ? M : never): Promise<Uint8Array>;
    /** 暴露规范化器的媒体补全能力，供协调器在分片任务中使用。 */
    get media_normalizer(): MessageNormalizer;
}
//# sourceMappingURL=weixinIngress.d.ts.map