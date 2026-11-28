/**
 * 知识图谱存储（社交网络）：人物节点 + "A 称呼 B 为 X"的有向边。
 *
 * 目录结构与时间线同构（**原始数据权威、视图可重建**）：
 * ```
 * <dir>/
 *   nodes.jsonl    # 权威：一人一行
 *   edges.jsonl    # 权威：一条称呼一行
 *   index.json     # 元数据：id 计数器、更新时间
 *   graph.md       # 人类可读视图（生成，勿手改）
 * ```
 *
 * 关键设计：
 * - **id 与姓名解耦**：改名不会产生新节点；查找支持姓名与别名。
 * - **每条信息带证据**：`sources` 记录"哪天的哪句话"支撑它，便于纠错和取信。
 * - **年龄不硬记**：能从生日算就算，避免模型写错后一直错。
 * - **不删只标**：节点/边不物理删除（人不会因为一次聊天就说错而被抹掉），
 *   需要"失效"时用状态字段（例如 `status: 'unknown'`）。
 *
 * @module dsh-webhook-weixin/graph-store
 */
import { type GraphEvidence, type GraphPath, type GraphSnapshot, type KnowledgeGraphOptions, type PersonNode, type RelationEdge } from './graphTypes.ts';
/** 知识图谱存储。 */
export declare class KnowledgeGraphStore {
    private readonly dir;
    /** 临时文件序号（同进程同毫秒多次写不撞名）。 */
    private tmp_seq;
    constructor(options: KnowledgeGraphOptions);
    /** 全部节点。 */
    nodes(): PersonNode[];
    /** 全部边。 */
    edges(): RelationEdge[];
    snapshot(): GraphSnapshot;
    /** 按 id 或姓名/别名找人（姓名匹配忽略大小写与空格）。 */
    find(name_or_id: string): PersonNode | undefined;
    /** 某人对外（他称呼别人）的边。 */
    edges_from(id: string): RelationEdge[];
    /** 别人对某人的边（别人怎么称呼他）。 */
    edges_to(id: string): RelationEdge[];
    /**
     * 查询 A 与 B 之间的链路（**支持"朋友的朋友"这种多跳**）。
     *
     * 从 `from` 出发按有向边广度优先，找出所有到 `to` 的简单路径（不重复经过同一节点），
     * 深度上限默认 4 跳。深度必须限制：再远的关系已经解释不动，而且搜索会爆炸。
     *
     * @returns 按跳数从短到长排序的链路；没有通路返回空数组。
     */
    paths(from_name: string, to_name: string, options?: {
        max_depth?: number;
    }): GraphPath[];
    /**
     * 某人的关系网（向外 expand 多少跳），用于"他身边都有谁"这类问题。
     */
    neighborhood(name: string, options?: {
        max_depth?: number;
    }): Array<{
        name: string;
        label: string;
        depth: number;
    }>;
    /** 人物属性（含由生日推算的年龄）。 */
    attributes(name: string): PersonNode | undefined;
    /**
     * 建立（或修复）图谱的中心——**欣爱是绝对中心**。
     *
     * 做三件事，全部幂等，所以启动时无脑调用即可：
     * 1. **只建两个中心节点**：`欣爱` 与 `主人`。除姓名外不预设任何属性——
     *    图谱应该是"聊到什么补什么"，凭空写一个"状态：unknown"只会变成噪音。
     * 2. **建立两人互相的称呼**：欣爱→主人 标 `主人`（她这么称呼他），
     *    主人→欣爱 标 `欣爱`。这两条边给了所有多跳查询一个共同起点。
     * 3. **迁移历史数据**：早期版本把用户节点叫"我"（还硬写了 `status: unknown`），
     *    这里就地改名为"主人"，并把"我"保留成别名——于是按"我""用户"仍然查得到，
     *    已有边因为存的是 id，完全不受影响。
     */
    ensure_center(): void;
    /**
     * 新增或更新一个人（按姓名/别名匹配已有节点；匹配不到就新建）。
     *
     * **改名只认显式 id**：只有调用方给出 `id`（说明它已经解析出"这是谁"）时，
     * `name` 才会被当成新正名。否则用别名调用（"妈妈"→已存在的"王丽"）会把正名
     * 覆盖成别名，节点从此在"王丽"名下查不到——这个坑实测踩过。
     *
     * @returns 落库后的节点。
     */
    upsert_person(input: {
        name: string;
        id?: string;
        aliases?: readonly string[];
        birthday?: string;
        age?: number;
        gender?: PersonNode['gender'];
        status?: PersonNode['status'];
        contacts?: readonly string[];
        location?: string;
        occupation?: string;
        family_summary?: string;
        important_dates?: readonly {
            label: string;
            date: string;
        }[];
        notes?: string;
        evidence?: GraphEvidence;
    }): PersonNode;
    private upsert_person_locked;
    /**
     * 新增或更新一条"称呼"边。
     *
     * 同一对人可以有多个称呼（`妈` / `母亲`），所以按 (from,to,label) 去重而不是按 (from,to)。
     */
    upsert_edge(input: {
        from: string;
        to: string;
        label: string;
        kind?: RelationEdge['kind'];
        evidence?: GraphEvidence;
    }): RelationEdge | undefined;
    private upsert_edge_locked;
    /** 人类可读视图（生成）。 */
    to_markdown(): string;
    /** 重建人类可读视图。 */
    regenerate_view(): void;
    /** 统计。 */
    stats(): {
        people: number;
        relations: number;
    };
    /** 存储目录（清空图谱时需要，避免调用方另算一遍路径）。 */
    dir_path(): string;
    /**
     * 把"消化到哪了"的水位清零。
     *
     * 清空图谱后要调它：否则水位还停在被清掉之前的位置，后续更新只会处理**新**记录，
     * 图谱会一直空着。归零之后，下一次空闲更新会把时间线里的历史重新消化一遍，
     * 图谱就能从已有记忆里逐步长回来。
     */
    reset_watermark(): void;
    private nodes_path;
    private edges_path;
    private index_path;
    /**
     * 上次用聊天记录更新图谱的时间（毫秒）。
     *
     * 用它做**增量更新**：每次只处理比它更新的记录，避免重复消化同一批对话
     * （重复处理不仅浪费，还会让模型反复"确认"同一件事，容易把错误固化下来）。
     */
    last_update_ms(): number | undefined;
    /** 本次水位同时刻已处理过的记录 id（用于 (ts, id) 复合游标）。 */
    last_update_ids(): string[];
    /**
     * 记录本次更新覆盖到的水位：时间戳 + **该时间戳上已处理的记录 id**。
     *
     * 为什么要带 id：只存毫秒时间戳时，同一毫秒内后来新增的记录会被
     * `ts > since` 永久跳过（审计复现过）。带上 id 就能精确续上。
     */
    set_last_update(ts: number, ids?: readonly string[]): void;
    /**
     * 分配下一个节点 id。
     *
     * **不能只信索引**：审计复现过"索引损坏 → 计数器归零 → 新节点又拿到 p1"，
     * 重复 id 会让边指向错误的人。所以这里取"索引计数器"和"实际节点里最大编号"的较大值 + 1。
     * 万一算出已存在的 id，直接抛错（fail closed），绝不写重复 id。
     */
    private next_id;
    /** 扫节点文件取最大编号（`p12` → 12）；这是 id 分配的**权威兜底**。 */
    private max_seq_in_nodes;
    private load_index;
    private save_index;
    private write_nodes;
    private write_edges;
    /** 原子写：临时文件（带进程内序号防撞名）+ rename（带重试，Windows 偶发 EPERM）。 */
    private write_atomic;
}
//# sourceMappingURL=graphStore.d.ts.map