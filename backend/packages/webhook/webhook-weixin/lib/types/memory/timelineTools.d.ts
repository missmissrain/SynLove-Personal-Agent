/**
 * 长期记忆（时间线）的三层工具接口。
 *
 * ## 三层架构（按"代价"从便宜到贵，检索顺序就是从 1 到 3）
 *
 * | 层 | 工具 | 数据 | 代价 |
 * |---|---|---|---|
 * | L1 索引 | `timeline_days` | 有哪些天、各多少条、那天摘要 | 最低：只读索引 |
 * | L2 检索 | `timeline_search` | 关键词命中在**哪天**、谁说的 | 中：跨天扫记录 |
 * | L3 明细 | `timeline_read` | 某天的摘要 + **逐句原文** | 最高：整段进上下文 |
 *
 * 设计意图：**先便宜地缩小范围，再决定要不要读原文**。
 * 模型最容易犯的错是"一上来就读一整天的原文"，既浪费上下文又慢；
 * 所以 L1/L2 的返回里都故意只给"日期 + 片段"，逼它先定位。
 *
 * 写入**不开放给模型**：记录由链路的连接器自动落盘（用户上行 + 最终回复），
 * 避免模型把"自己以为发生过的事"写进长期记忆。
 *
 * @module dsh-webhook-weixin/timeline-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TimelineStore } from './timelineStore.ts';
/**
 * 在某个 agent 作用域上注册三个时间线工具。
 *
 * @param agent_ctx - agent 自己的 ctx（用 `agent.ctx.effect` 保证卸载时自动清理）。
 * @param store - 时间线存储。
 */
export declare function register_timeline_tools(agent_ctx: Context, store: TimelineStore): void;
//# sourceMappingURL=timelineTools.d.ts.map