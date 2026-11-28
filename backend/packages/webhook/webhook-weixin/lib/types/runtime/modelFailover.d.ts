/**
 * 模型故障转移：某个 API 失活（额度用完 / key 失效 / 模型下线）时，
 * 自动换到系统里配置的**另一个** API 继续干活。
 *
 * ## 为什么需要
 *
 * 实测踩过：中转站的 key 用满 7 天额度后，每一次模型调用都 429，这一轮直接失败——
 * 用户看到的是"一直处理中"然后什么都没有。系统里明明还配着豆包、千问的 key，
 * 却只能靠人手动去控制台换。这个模块就是让"换"自动发生。
 *
 * ## 怎么换（不丢上下文、不重启）
 *
 * harness 的 `sessionController.selectModel({sessionId, provider, model})` 会把选择装到
 * **下一个请求**上，并顺手保存成默认值——所以同一段对话可以无缝换模型。
 * 本模块只负责"判断该不该换、换成谁、多久内别再试它"，副作用由连接器执行。
 *
 * ## 判定
 *
 * 只有**重试也没用**的错误才换：额度/限流、鉴权失败、模型不存在。
 * 网络抖动、5xx 这类交给 harness 自己的重试策略（llm-retry），我们不要抢着换。
 *
 * @module dsh-webhook-weixin/model-failover
 */
/** 失活原因。 */
export type FailoverReason = 'quota' | 'rate_limit' | 'auth' | 'model_missing';
/**
 * 找到模型配置文件的真实路径。
 *
 * 它在**工作区的 `config/` 子目录**下（`<工作区>/config/modelConfig.json`）。
 * 早先按 `<工作区>/modelConfig.json` 找过——读不到就静默变成空配置，
 * 表现是"故障转移明明配了却说没有候选模型"（2026-09-22 实测踩过）。
 *
 * @param workspace - 工作区目录（连接器里的 PROJECT_CONFIG_DIR）。
 * @returns 存在的那个路径；都不存在返回 undefined。
 */
export declare function find_model_config(workspace: string): string | undefined;
/** 一个候选模型。 */
export interface ModelCandidate {
    readonly provider: string;
    readonly model: string;
}
/** 解析后的故障转移配置。 */
export interface FailoverConfig {
    readonly enabled: boolean;
    /** 候选顺序（含当前默认模型；按顺序找第一个"活着"的）。 */
    readonly order: readonly ModelCandidate[];
    /** 额度类失活的冷却时间（毫秒）；鉴权/模型不存在固定更长。 */
    readonly cooldown_ms: number;
}
/**
 * 判断一条模型错误是不是"这个 API 不能用了"。
 *
 * @param message - 错误文本（含 HTTP 状态码与上游 message）。
 * @returns 失活原因；不是致命错误就返回 undefined（交给 harness 重试）。
 */
export declare function classify_llm_failure(message: string): FailoverReason | undefined;
/** 冷却时间：限流最短、额度类用配置值、鉴权/模型缺失最长。 */
export declare function cooldown_ms(reason: FailoverReason, config: FailoverConfig): number;
/** 从 modelConfig.json 的内容解析故障转移配置。 */
export declare function parse_failover_config(config: {
    providers?: Record<string, {
        apiKey?: string;
        models?: Array<{
            id?: string;
        }>;
    }>;
    failover?: {
        enabled?: boolean;
        order?: Array<{
            provider?: string;
            model?: string;
        }>;
        cooldownMs?: number;
    };
    defaultModel?: {
        provider?: string;
        model?: string;
    };
}): FailoverConfig;
/** 下一个候选：从 `current` 之后顺着找，跳过失活的（不回头，避免来回横跳）。 */
export declare function next_alive_candidate(order: readonly ModelCandidate[], current: ModelCandidate | undefined, is_dead: (candidate: ModelCandidate) => boolean): ModelCandidate | undefined;
/** 失活记录。 */
export interface DeadEntry {
    readonly until: number;
    readonly reason: FailoverReason;
    readonly detail: string;
    readonly at: number;
}
/**
 * 内存里的模型健康表（按 `provider/model` 记冷却）。
 *
 * 只放在内存：进程重启后重新试探是合理的（额度可能已经恢复），
 * 也不需要把"某个 key 挂了"这种瞬时状态写进磁盘。
 */
export declare class ModelHealth {
    private readonly now;
    private readonly dead;
    constructor(now?: () => number);
    private static key;
    mark_dead(candidate: ModelCandidate, reason: FailoverReason, detail: string, ms: number): DeadEntry;
    mark_alive(candidate: ModelCandidate): void;
    is_dead(candidate: ModelCandidate): boolean;
    /** 当前失活的模型（供控制台/诊断展示）。 */
    snapshot(): Array<ModelCandidate & DeadEntry>;
}
//# sourceMappingURL=modelFailover.d.ts.map