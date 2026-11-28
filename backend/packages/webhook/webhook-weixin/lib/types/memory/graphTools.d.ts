/**
 * 知识图谱（社交网络）的查询工具。
 *
 * 只提供**一个**工具 `relation_query`，两种用法：
 * - 给两个人名 → 查他们之间的称呼链路（**递归多跳**，能回答"朋友的朋友"这种关系）；
 * - 只给一个人名 → 查这个人的属性 + 向外的关系网。
 *
 * 为什么合成一个工具：模型（尤其中小参数）在工具变多时容易选错。
 * 一个入口 + 可选参数，比"person_info / relation_path"两个工具更不容易用错。
 *
 * 写入不开放给模型：图谱由链路在空闲时用 Gemma 分批更新，避免模型凭印象改事实。
 *
 * @module dsh-webhook-weixin/graph-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { KnowledgeGraphStore } from './graphStore.ts';
/**
 * 在 agent 作用域注册图谱查询工具。
 *
 * @param agent_ctx - agent 自己的 ctx。
 * @param graph - 知识图谱存储。
 */
export declare function register_graph_tools(agent_ctx: Context, graph: KnowledgeGraphStore): void;
//# sourceMappingURL=graphTools.d.ts.map