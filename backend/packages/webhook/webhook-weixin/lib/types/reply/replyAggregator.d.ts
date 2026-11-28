/**
 * 回复聚合器：只负责"把一个 turn 的流式文本切成可发送段落"，不做任何发送。
 *
 * 重构设计文档 §7.2：保留文本分段与代码围栏处理，删除独立发送语义。
 * 发送顺序、重试、持久化全部交给 OutboundCoordinator。
 *
 * 同时持有本轮累计的思考摘要（reasoning），供"摘要即心跳"的进度推送使用。
 * @module dsh-webhook-weixin/reply-aggregator
 */
/** 单轮回复的文本聚合器。 */
export declare class ReplyAggregator {
    private pending;
    private reasoning;
    private suppressed;
    private finished;
    /** 本轮已经切出去的段数（用于 MAX_SEGMENTS_PER_TURN 限流保护）。 */
    private emitted;
    /**
     * 接收一个正文分片，返回应立刻发送的段落列表。
     * 命中"工具调用外壳"时整轮静默，避免把内部结构泄露给用户。
     */
    accept_chunk(text: string): string[];
    /** 累计思考摘要（不发送）。 */
    accept_reasoning(text: string): void;
    /**
     * 取出一段思考摘要并清空。
     * 摘要推送后应调用 `mark_visible()`，因为它本身就是一次"用户可见输出"。
     */
    take_reasoning_excerpt(limit: number): string | undefined;
    /** 结束本轮，返回尚未发送的尾段。 */
    finish(): string | undefined;
    /** 是否已被判定为工具调用外壳（整轮静默）。 */
    get is_suppressed(): boolean;
    /** 按句子标点切出可发送段落。 */
    private extract;
}
//# sourceMappingURL=replyAggregator.d.ts.map