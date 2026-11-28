/**
 * 显存监视：Gemma 行动前先确认显卡是空闲的。
 *
 * 为什么需要：本地 Gemma（Q4_K_M + 视觉投影器 + 32k 上下文）醒来后要占约 5.3GB，
 * 而这张卡只有 8GB。如果用户正好在跑游戏/训练/另一个模型，硬启动会把两边都拖垮
 * （甚至 OOM）。后台任务**不急**（摘要在空闲时才跑），所以正确做法是
 * **等显存空出来再启动**，而不是抢。
 *
 * 判定用 `nvidia-smi`；查不到就直接放行（不能因为探测失败就永远不跑模型）。
 *
 * @module dsh-webhook-weixin/gpu-monitor
 */
/** 显存快照。 */
export interface GpuMemory {
    readonly used_mb: number;
    readonly total_mb: number;
    readonly free_mb: number;
}
/**
 * 读一次显存占用。
 *
 * @returns 快照；没有 nvidia-smi 或查询失败时返回 undefined（调用方应据此放行）。
 */
export declare function gpu_memory(): GpuMemory | undefined;
/** 等待显存空闲的选项。 */
export interface WaitForVramOptions {
    /** 至少要有这么多空闲显存才认为"可以启动"（MB）。 */
    readonly min_free_mb?: number;
    /** 最多等多久（毫秒），默认 10 分钟。 */
    readonly timeout_ms?: number;
    /** 轮询间隔（毫秒），默认 30 秒。 */
    readonly poll_ms?: number;
    /** 探针用标签。 */
    readonly label?: string;
}
/**
 * 等到显存足够空闲；超时返回 false（调用方应放弃本轮，而不是硬上）。
 *
 * 探测不到显存信息时返回 true（放行）。
 */
export declare function wait_for_free_vram(options?: WaitForVramOptions): Promise<boolean>;
//# sourceMappingURL=gpuMonitor.d.ts.map