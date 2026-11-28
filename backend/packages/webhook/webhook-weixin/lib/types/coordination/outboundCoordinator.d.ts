/**
 * 出站协调器：微信链路唯一的发送队列。
 *
 * 重构设计文档 §7：所有对外消息（正式回复、控制回执、进度、心跳、错误）都进入同一条
 * durable outbox，按 `session_id + sequence` 有序发送；发送失败留下可见状态并可恢复。
 *
 * 心跳策略（按用户要求调整）：**思考摘要本身即心跳**。只有当"距上次输出思考摘要的时间"
 * 超过阈值时，才补发一条心跳；不再固定间隔刷屏。
 * @module dsh-webhook-weixin/outbound-coordinator
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
import type { TurnContextStore } from '../state/turnContextStore.ts';
import type { TimelineEntry } from '../memory/timelineTypes.ts';
/** 发送函数：由连接器注入（真实 iLink 或测试替身）。 */
export type OutboxSender = (input: {
    user_id: string;
    text: string;
    client_id: string;
    context_token?: string;
}) => Promise<void>;
/** 发送失败是否可重试；由 iLink 错误分类决定。 */
export type RetryClassifier = (error: unknown) => boolean;
/** 构造参数。 */
export interface OutboundCoordinatorOptions {
    readonly store: WeixinStateStore;
    readonly turn_context: TurnContextStore;
    readonly sender: OutboxSender;
    readonly classify_retryable: RetryClassifier;
    /** 把"最终回复"写进长期记忆（时间线）；不注入则完全不记录。 */
    readonly record_entry?: (entry: TimelineEntry) => void;
    /** 无 context_token 的消息被拒后推迟多久再试（毫秒），默认 5 分钟。 */
    readonly no_token_defer_ms?: number;
    /**
     * 通知类结果停放多久（毫秒），默认 6 小时。
     *
     * 窗口关闭时结果发不出去，但内容有用（"你让我做的事做完了"），所以停放一段时间
     * 等用户主动询问（由工具返回）；超过就丢，避免无限堆积。
     */
    readonly parked_retention_ms?: number;
    /** 最大尝试次数，超过转 failed_terminal。 */
    readonly max_attempts?: number;
    /** 重试退避基数（毫秒）。 */
    readonly retry_base_ms?: number;
    /**
     * 相邻两次发送的最小间隔（毫秒，同一会话）。
     * iLink 对突发发送会限流（实测连续发第 4 条起全部 `prepare failed`），
     * 所以必须节流，不能把队列一次性泵出去。
     * 可用 DSH_WEIXIN_SEND_MIN_GAP_MS 调整。
     */
    readonly send_min_gap_ms?: number;
    /** 每次泵出最多发送多少条（进一步压制突发）。 */
    readonly send_batch_limit?: number;
    /** 思考摘要心跳阈值（毫秒）；距上次摘要超过此值才补发心跳。0 = 关闭。 */
    readonly heartbeat_idle_ms?: number;
    /** 每个会话一轮内最多补发几条心跳，防止刷屏。 */
    readonly heartbeat_max_per_turn?: number;
    /**
     * 触发限流（`ret=-2`）后的整链路冷却基数（毫秒），默认 30 秒，连续限流按 2 倍递增。
     *
     * 关键：限流是**全局**信号，必须整条链路一起退避。若只按"单条重试"处理，
     * 重试本身就会持续制造限流，队列永远排空不了——实测曾因此连续 11 小时发不出任何消息。
     * 可用 DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MS 调整。
     */
    readonly rate_limit_cooldown_ms?: number;
    /**
     * 冷却上限（毫秒），默认 10 分钟。
     *
     * 实测证据：把重试间隔压到 ≤2 分钟持续试探时，平台会**连续 40+ 分钟全部拒绝**
     * （1453 拒 / 89 成）；而长时间安静之后再发往往能通过。所以持续试探不但没用，
     * 还很可能在不断"续期"这个限制——退避必须足够长，给对面真正的恢复空间。
     */
    readonly rate_limit_cooldown_max_ms?: number;
}
/** 微信出站协调器。 */
export declare class OutboundCoordinator {
    private readonly store;
    private readonly turn_context;
    private readonly sender;
    private readonly classify_retryable;
    /** 把"最终回复"记进长期记忆；由连接器注入，失败也不影响发送。 */
    private readonly record_entry;
    private readonly max_attempts;
    private readonly retry_base_ms;
    private readonly heartbeat_idle_ms;
    private readonly heartbeat_max_per_turn;
    private readonly send_min_gap_ms;
    private readonly send_batch_limit;
    /** 每个会话上次发送的时间，用于节流。 */
    private readonly last_send_at;
    /** 全局上次发送时间：不同会话也压制一下总速率。 */
    private last_send_any_at;
    private readonly progress;
    private draining;
    private stopped;
    /** 限流熔断：在此时间戳之前整条链路暂停发送（见 options.rate_limit_cooldown_ms）。 */
    private paused_until;
    /** 熔断期间唯一的唤醒定时器；避免并发 drain 累积出定时器/日志风暴。 */
    private pause_timer;
    /** 上次打印 drain.paused 的时间；熔断期间按秒级降噪。 */
    private pause_logged_at;
    /** 连续限流次数，用于指数加大冷却；发送成功即清零。 */
    private rate_limit_streak;
    private readonly rate_limit_cooldown_ms;
    private readonly rate_limit_cooldown_max_ms;
    /** 无 context_token 的消息被拒后，推迟多久再试（默认 5 分钟）。 */
    private readonly no_token_defer_ms;
    /** 通知类结果停放多久（默认 6 小时）。 */
    private readonly parked_retention_ms;
    /** 绑定状态库与发送实现。 */
    constructor(options: OutboundCoordinatorOptions);
    /** 入队一条正式回复（转级上下文由 turn 决定）。 */
    enqueue_assistant(input: {
        session_id: string;
        user_id: string;
        turn: number;
        text: string;
    }): void;
    /** 入队控制回执 / 错误 / 进度。 */
    enqueue_notice(input: {
        session_id: string;
        user_id: string;
        /** assistant 用于 Codex 远程桥的"由模型执行"的正式输出 */
        kind: 'control_ack' | 'progress' | 'heartbeat' | 'error' | 'assistant';
        text: string;
        context_token?: string;
        turn?: number;
    }): void;
    /**
     * 泵出所有会话的可发送消息。
     * - 不同 Session 并发；同一 Session 严格按 sequence。
     * - 单条失败不阻塞其它会话。
     */
    drain(): Promise<void>;
    /**
     * 发送某会话当前队首；成功后继续推进该会话。
     *
     * 关键防护：记录本次已处理过的 outbound_id，禁止在同一次泵出里重复发送同一条。
     * 否则"终态失败 → 入队 error → error 也失败 → 再入队 error"会变成无限循环。
     */
    private send_head;
    /** 发送前等待，保证最小间隔（会话级 + 全局级）。 */
    private throttle;
    /** 发送单条；返回是否应继续推进该会话队列。 */
    private send_one;
    /** 一轮开始：记录进度状态并启动"摘要超时"检查。 */
    begin_turn(session_id: string, turn: number): void;
    /**
     * 标记"刚有可见输出"。
     *
     * 思考摘要与正文分段都会调用这里——**摘要本身就是心跳**，
     * 所以它同时把 last_visible_at 推后，从而抑制额外的固定心跳。
     */
    note_visible(session_id: string): void;
    /** 一轮结束：停止检查。 */
    end_turn(session_id: string): void;
    /** 距上次可见输出超过阈值才补发心跳。 */
    private maybe_heartbeat;
    /** 入队一条思考摘要（进度）：它既是进度也是心跳。 */
    enqueue_progress(session_id: string, text: string): void;
    /** 清理某会话的进度状态。 */
    private clear_progress;
    /** 停止出站泵；幂等。 */
    stop(): void;
    /** 启动时恢复 pending outbox（设计文档 §10.3）。 */
    recover_pending(): Promise<number>;
}
//# sourceMappingURL=outboundCoordinator.d.ts.map