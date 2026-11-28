/**
 * 本地 Gemma 的**全局并发闸门**。
 *
 * 为什么需要：时间线摘要、图谱抽取、图片描述是三条独立的后台链路，
 * 各自维护 busy 标志——它们可以**同时**唤醒模型（审计实测并发峰值 2）。
 * 本地 llama-server 只有一份 8GB 显存：并发调用会争显存、触发重复冷启动、
 * 让本可以串行完成的活互相拖慢。
 *
 * 所以把"调用模型"这件事收敛到一个有界闸门里：默认**并发 1**，
 * 排队超过上限就直接拒绝（后台任务宁可这一轮跳过，也不要无限堆积把内存吃满）。
 *
 * @module dsh-webhook-weixin/gemma-gate
 */
/** 闸门选项。 */
export interface GemmaGateOptions {
    /** 同时允许多少个模型调用，默认 1。 */
    readonly concurrency?: number;
    /** 最多排队多少个，默认 20；超过直接拒绝。 */
    readonly max_queue?: number;
    /** 单次等待超时（毫秒），默认 10 分钟；超时抛错，避免永久挂住。 */
    readonly wait_timeout_ms?: number;
    /**
     * 启动前至少要有这么多空闲显存（MB），默认 5200；设为 0 关闭检查。
     *
     * 本地 Gemma 醒来后要占约 5.3GB（Q4 模型 + 视觉投影器 + 32k 上下文），
     * 卡只有 8GB。用户如果在跑游戏/训练，硬启动会把两边一起拖垮——所以先等它空出来。
     */
    readonly min_free_vram_mb?: number;
    /** 等显存最多等多久（毫秒），默认 10 分钟，超时就放弃本轮。 */
    readonly vram_wait_ms?: number;
    /** 显存轮询间隔（毫秒），默认 30 秒。 */
    readonly vram_poll_ms?: number;
    /**
     * 可选的"确保模型服务在跑"钩子：显存空出来之后、真正调用之前执行。
     *
     * 用途：启动器因为当时显存忙而没拉起 llama-server 时，这里可以补拉。
     */
    readonly ensure_ready?: () => Promise<void>;
}
/** 闸门句柄。 */
export interface GemmaGate {
    /** 在闸门里执行一次模型调用。 */
    run<T>(label: string, fn: () => Promise<T>): Promise<T>;
    /** 当前状态（诊断用）。 */
    stats(): {
        active: number;
        queued: number;
    };
}
/**
 * 创建闸门。
 *
 * @param options - 并发与排队上限。
 */
export declare function create_gemma_gate(options?: GemmaGateOptions): GemmaGate;
//# sourceMappingURL=gemmaGate.d.ts.map