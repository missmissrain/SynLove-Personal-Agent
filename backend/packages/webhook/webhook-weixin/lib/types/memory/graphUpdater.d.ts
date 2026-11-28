/**
 * 用本地 Gemma 从聊天记录里更新知识图谱。
 *
 * ## 为什么要分成"小块 + 多次小调用"，而不是"一次读一大段"
 *
 * 显存只有 8GB（模型+视觉投影器已占约 5GB），**长上下文就是最贵的资源**。
 * 而"之前那个人"这类指代又天然需要上下文——两者直接冲突。
 * 解法不是把上下文变长，而是**把上下文变窄 + 用一份很小的候选名单把指代变成选择题**：
 *
 * 1. **分块**：记录按 ~2.5k 字符切块，每块单独调用，输入永远很短；
 * 2. **滚动指代候选**：每次调用都带上"最近提到过的人 + 图谱已有的人"（几十个 token），
 *    让模型做"`那个人` → 名单里哪一个"的选择，而不是自由回忆；
 * 3. **跨块续接**：上一块末尾几行 + 未解开的指代片段带进下一块（有界），
 *    这样跨块的"之前说的那个人"也能接上；
 * 4. **先抽取、后落库**：模型只输出**中文短协议事实**（一行一条），
 *    由代码解析并写库——模型不直接改图，格式错一行也只丢一行；
 * 5. **逐节点审核**：只对"这批记录里被提到的人"再各调一次，
 *    且只喂**与这个人有关的事实**（几十到几百 token），这就是"递归遍历节点"，
 *    但代价不随图谱规模线性膨胀（可选 `full_scan` 强制全量遍历）。
 *
 * 时间不敏感（都在空闲时跑），所以"多调用、每次很小"是明确更优的取舍。
 *
 * @module dsh-webhook-weixin/graph-updater
 */
import type { KnowledgeGraphStore } from './graphStore.ts';
import { type GraphEvidence } from './graphTypes.ts';
/** 一条待更新的聊天记录（来自时间线）。 */
export interface UpdateRecord {
    readonly date: string;
    readonly role: 'user' | 'assistant';
    readonly text: string;
}
/** 把说话人别名归一到规范名；不是别名就原样返回。 */
export declare function canonical_person_name(name: string): string;
/** 构造参数。 */
export interface GraphUpdaterOptions {
    readonly graph: KnowledgeGraphStore;
    /** 调用模型：输入完整提示词，返回模型文本。由调用方注入（便于测试）。 */
    readonly complete: (prompt: string) => Promise<string>;
    /**
     * 每块最大字符数，默认 8000（≈6k token）。
     *
     * 压力实测（本地 Gemma 4B）：
     * - 容量不是瓶颈：24k 字符≈19k token 只要 7.6s，显存恒定 5.3GB（按 32k 预分配 KV），
     *   硬上限是 32768 token；
     * - **瓶颈是召回率**：同一批测试，2k 字符时 3/3 命中，12k 以上掉到 2/3——
     *   块越大越容易漏事实（漏掉的事实 = 错的长期记忆）。
     * 所以这里取"够大以减少跨块指代碎片、又不至于明显掉召回"的折中值；
     * 时间不敏感（空闲时跑），需要更高准确率就把块调小。
     */
    readonly chunk_chars?: number;
    /** 是否遍历**所有**节点（默认 false：只审这批记录里提到的人）。 */
    readonly full_scan?: boolean;
    /**
     * 单次提示词字符上限，默认 30000（≈24k token，给 32768 的上下文留输出余量）。
     * 超限时优先丢掉最旧的"前文提要"，绝不冒被服务端截断的风险。
     */
    readonly max_prompt_chars?: number;
}
/** 一次更新的结果（用于探针与汇报）。 */
export interface GraphUpdateResult {
    readonly chunks: number;
    readonly facts: number;
    readonly bad_lines: number;
    readonly people_created: readonly string[];
    readonly people_updated: readonly string[];
    readonly relations_created: number;
    readonly unresolved: number;
    /** 因超限而做"合并压缩"的次数（旧压缩块 + 当前块 → 一个新块）。 */
    readonly merged_blocks: number;
    /** 极端兜底：连合并都装不下、被迫丢弃最旧提要的次数（正常应为 0）。 */
    readonly trimmed_prompts: number;
}
/**
 * 从一段聊天记录更新知识图谱。
 *
 * @param options - 图谱、模型调用、分块参数。
 * @param records - 待处理的记录（按时间升序）。
 * @returns 本次更新的统计。
 */
export declare function update_graph_from_records(options: GraphUpdaterOptions, records: readonly UpdateRecord[]): Promise<GraphUpdateResult>;
/** 让 GraphEvidence 类型在文件内可见（供类型推断）。 */
export type { GraphEvidence };
//# sourceMappingURL=graphUpdater.d.ts.map