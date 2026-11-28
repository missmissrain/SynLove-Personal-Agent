/**
 * Turn 级回复上下文：把 `session_id + turn` 绑定到产生该 turn 的入站 delivery 与其 context_token。
 *
 * 重构设计文档 §7.1：回复层必须按 turn 查找上下文，而不是读"当前 Session 的最后一条 token"。
 * 旧实现用 Session 级单值 Map，长任务期间连续来消息会让旧 turn 误用新 token。
 *
 * 本模块只是 WeixinStateStore 的语义化包装，保证调用点不直接拼表名。
 * @module dsh-webhook-weixin/turn-context
 */
import type { WeixinStateStore } from './weixinStateStore.ts';
/** 一次 turn 的回复上下文。 */
export interface TurnContext {
    readonly delivery_id: string;
    readonly user_id: string;
    readonly context_token?: string;
}
/** Turn 上下文的读写入口。 */
export declare class TurnContextStore {
    private readonly store;
    /** 绑定到状态库。 */
    constructor(store: WeixinStateStore);
    /** 绑定 `session_id + turn`；同 turn 重复绑定会覆盖为最新。 */
    bind(session_id: string, turn: number, context: TurnContext): void;
    /** 读取 turn 上下文；未绑定返回 undefined（回复层应回退到最近一条，而不是别的 turn 的 token）。 */
    get(session_id: string, turn: number): TurnContext | undefined;
    /**
     * 仅在**尚未绑定**时写入（first-wins）。
     *
     * 这是修复"同一 turn 的回复上下文被后续消息覆盖"的关键原语：
     * 长任务期间用户再发消息时，那条消息属于下一个 turn，
     * 绝不能改写本轮回复应当使用的 delivery / context_token。
     *
     * @returns true = 本次完成绑定；false = 已存在绑定，保持原值不变。
     */
    bind_if_absent(session_id: string, turn: number, context: TurnContext): boolean;
    /**
     * 解析用于回复的上下文：
     * 1. 优先精确命中 `session_id + turn`；
     * 2. 未命中（重启/历史 turn）时回退到该会话最近一条已注入的 delivery；
     * 3. 仍无则返回 undefined —— 此时必须**无 token 发送**或报错，绝不复用其它 turn 的 token。
     */
    resolve(session_id: string, turn: number): TurnContext | undefined;
    /**
     * 该会话最近一次可用的回复上下文（含 context_token）；没有则 undefined。
     *
     * 给"不针对某一轮"的消息（通知/进度）用：它们没有自己的 turn，
     * 但带上最近的 token 才有机会在会话窗口开着时送达。
     */
    latest(session_id: string): TurnContext | undefined;
    /**
     * 该会话最近一次的 context_token，**但只在它足够新鲜时才返回**。
     *
     * 为什么需要"新鲜度"判断：token 会过期，而**过期 token 的发送必然被拒**。
     * 实测教训：给通知类无脑带上"最近一次 token"后，旧 token 被拒 →
     * 被误当成真限流 → 全局熔断冻结整条链路（10 小时发不出消息）。
     * 所以这里只在新入站刚发生（会话窗口还开着）时才带 token，否则宁可不带。
     *
     * @param session_id - 会话。
     * @param max_age_ms - 允许多旧，默认 10 分钟。
     */
    latest_token_if_fresh(session_id: string, max_age_ms?: number): string | undefined;
    /** 一轮结束后清理历史，避免表无限增长。 */
    prune(session_id: string, keep?: number): void;
}
//# sourceMappingURL=turnContextStore.d.ts.map