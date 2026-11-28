/**
 * 时间线摘要的**低频**定时器。
 *
 * 刻意独立于 iLink 轮询：
 * - 轮询（~15s）是**接收**通道，属于微信协议的一部分；
 * - 这里的检查是**纯本地**操作（读索引/记录文件），一个微信接口都不调。
 * 两者解耦后，"摘要调度"再怎么改也不会影响微信链路。
 *
 * 频率也不需要高：触发条件是"某个日期已空闲 ≥3 小时"，所以每 5 分钟看一眼，
 * 最多只会让摘要晚 5 分钟，完全够用。
 *
 * @module dsh-webhook-weixin/timeline-scheduler
 */
import type { TimelineStore } from './timelineStore.ts';
import type { TimelineSummarizer } from './timelineTypes.ts';
/** 构造参数。 */
export interface TimelineSchedulerOptions {
    readonly store: TimelineStore;
    readonly summarizer: TimelineSummarizer;
    /** 检查间隔（毫秒），默认 5 分钟（`DSH_TIMELINE_CHECK_MINUTES`）。 */
    readonly interval_ms?: number;
    /** 每次实际更新了摘要时回调（便于探针/日志）。 */
    readonly on_update?: (dates: readonly string[]) => void;
}
/** 调度器句柄。 */
export interface TimelineScheduler {
    /** 立即检查一次；返回被更新摘要的日期。 */
    run_once(now?: number): Promise<string[]>;
    /** 停止定时器（幂等）。 */
    stop(): void;
}
/**
 * 启动摘要调度器。
 *
 * @param options - 存储与摘要器。
 * @returns 句柄；调用方负责在卸载时 `stop()`。
 */
export declare function start_timeline_scheduler(options: TimelineSchedulerOptions): TimelineScheduler;
//# sourceMappingURL=timelineScheduler.d.ts.map