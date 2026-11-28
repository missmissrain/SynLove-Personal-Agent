/**
 * 时间线存储（长期记忆）：一天一个 node，node 内 = 摘要 + 切实聊天记录。
 *
 * 目录结构：
 * ```
 * <dir>/
 *   index.json                 # 日期索引：node 元数据，供快速查询/统计
 *   days/
 *     2026-09-20.jsonl         # 权威记录（append-only，每行一条 TimelineEntry）
 *     2026-09-20.summary.md    # 权威摘要（可人工编辑）
 *     2026-09-20.md            # 人类可读视图（由上面两者生成，勿手改）
 * ```
 *
 * 为什么把 jsonl 和 md 分开：
 * - `jsonl` 是**权威**记录，解析稳定、追加安全，适合程序读写；
 * - `md` 是给人（也给人格化 agent）读的视图，可随时从权威数据重建；
 * - 摘要单独放 `summary.md`，这样"重新生成视图"不会覆盖人工编辑过的摘要。
 *
 * 所有写操作都走"临时文件 + rename"的原子替换，避免断电/杀进程留下半个文件。
 *
 * @module dsh-webhook-weixin/timeline-store
 */
import type { TimelineAttachment, TimelineDay, TimelineDayMeta, TimelineEntry, TimelineReadFilter, TimelineSearchHit, TimelineStoreOptions, TimelineSummarizer } from './timelineTypes.ts';
/** 时间线存储：读取与更新长期记忆。 */
export declare class TimelineStore {
    private readonly dir;
    private readonly days_dir;
    private readonly timezone;
    private readonly persist_reasoning;
    private readonly idle_ms;
    /**
     * 已写入记录 id 的内存缓存（按天）。
     *
     * 用途：append 的幂等校验本来要读整天文件（O(n)），1000 条时是 O(n²)。
     * 用 `文件大小:mtime` 当缓存键——文件没变就直接复用，append 变成 O(1)。
     * 别的进程改了文件，键会变，缓存自动失效（配合 file lock 保证一致）。
     */
    private readonly id_cache;
    /** 视图（.md）待重建的日期；惰性重建，避免每次 append 都重写 Markdown。 */
    private readonly dirty_views;
    /** 临时文件序号（同进程同毫秒多次写不撞名）。 */
    private tmp_seq;
    /** 正在重建索引：防止 load_index ↔ rebuild_index 互相递归。 */
    private rebuilding_index;
    /** 每日元数据的内存缓存（追加时增量更新，避免每次重算整天）。 */
    private readonly meta_cache;
    constructor(options: TimelineStoreOptions);
    /**
     * 追加一条记录（幂等：同一 id 重复追加会被忽略）。
     *
     * @returns `true` 表示真的写入；`false` 表示这条 id 已存在。
     */
    /** 存储目录（清空记忆时需要，避免调用方另算一遍路径）。 */
    dir_path(): string;
    /**
     * 确保存储目录存在（含 `days/` 子目录）。
     *
     * **清空记忆之后必须调用**：清空会连 `days/` 一起删掉，而 store 实例是长驻的，
     * 不会自己重建——下一次 append 就会 ENOENT（实测 2026-09-21 23:46 那轮就撞上了）。
     * 构造函数与 append 也会调用它，所以外部删目录同样能自愈。
     */
    ensure_dirs(): void;
    /**
     * 丢掉全部内存缓存。
     *
     * **外部清空目录之后必须调用**：`meta_cache` 是按天缓存的，文件被删掉了它却还在，
     * 于是 `list_days()` 会继续列出早已不存在的天。id 缓存虽按 `size:mtime` 校验，
     * 但也一并清掉更省心。
     */
    forget_caches(): void;
    append(entry: TimelineEntry): boolean;
    /**
     * 该日期已知的记录 id 集合（带 mtime 缓存）。
     *
     * 文件被别的进程改过（大小/mtime 变化）时会重新读，保证跨进程也准确。
     */
    private known_ids;
    /**
     * 取某日"当前基数"（追加前）。
     *
     * 优先用内存缓存（热路径 O(1)）；缓存冷时**从记录文件算**，而不是信索引——
     * 索引只是缓存，记录文件才是权威。
     */
    private base_meta;
    /** 写入某日的元数据（覆盖，不累加）。 */
    private set_meta;
    /** 由记录列表直接算元数据（不读索引，避免递归/双重计数）。 */
    private meta_from_entries;
    /** 视图惰性重建：同一日期最多每 5 秒重建一次，且文件缺失时必建。 */
    private regenerate_view_if_due;
    /** 强制把所有待重建的视图刷出来（调度器空闲时调用）。 */
    flush_views(): void;
    /**
     * 批量追加；返回真正写入的条数。用于恢复/回填历史。
     */
    append_many(entries: readonly TimelineEntry[]): number;
    /**
     * 给某条记录补写媒体引用/描述（记录本身是 append-only，这里做定点改写）。
     *
     * 为什么需要它：消息先落盘（拿到事实），媒体要等下载完才拿得到引用、
     * 描述更要等视觉模型跑完；这两件事都比"记下这句话"晚，所以必须能后补。
     * 改写是**整天重写 + 原子替换**（一天记录量很小），失败也不会留下半截文件。
     *
     * @returns 是否命中并改写。
     */
    update_entry(date: string, entry_id: string, patch: {
        attachments?: readonly TimelineAttachment[];
        text?: string;
    }): boolean;
    /**
     * 给某条记录里的某个附件补上描述（视觉模型跑完后回填）。
     *
     * @returns 是否命中并写入。
     */
    update_attachment_description(date: string, entry_id: string, attachment_id: string, description: string): boolean;
    /**
     * 更新某一日的摘要（权威来源是 `days/<date>.summary.md`，可人工编辑）。
     *
     * @param date - `YYYY-MM-DD`。
     * @param summary - 摘要正文；空字符串表示清空。
     * @param meta - 可选的生成信息（例如模型名），会写进索引。
     */
    update_summary(date: string, summary: string, meta?: {
        model?: string;
    }): void;
    /** 从权威记录重新生成人类可读视图（`<date>.md`）；人工改过视图时用它复原。 */
    regenerate_view(date: string): void;
    /**
     * 重建索引：**直接扫 `days/*.jsonl`**（权威数据），不信任 index.json。
     *
     * 这是索引损坏时的自愈路径——审计复现过"损坏索引后旧日期彻底不可发现"，
     * 而记录文件其实还在。所以读取路径发现索引缺失/损坏时必须自动走这里。
     */
    rebuild_index(): number;
    /**
     * 找出"该更新摘要"的日期。
     *
     * 判定两条同时成立：
     * 1. **已经空闲**：距该日最后一条记录 ≥ `idle_ms`（默认 3 小时）——
     *    说明这段对话讲完了，现在总结不会再反复重写；
     * 2. **有待总结的内容**：还没有摘要，或上次摘要之后又新增了记录。
     *
     * @param now - 当前时间（便于测试注入）。
     */
    days_needing_summary(now?: number): string[];
    /**
     * 用注入的摘要器更新指定日期的摘要。
     *
     * @param date - `YYYY-MM-DD`。
     * @param summarize - 摘要实现（本地 Gemma / 云端模型都行）。
     * @returns 摘要文本；该日没有记录时返回 undefined（不写空摘要）。
     */
    summarize_day(date: string, summarize: TimelineSummarizer): Promise<string | undefined>;
    /** 扫描并按需更新所有到期摘要；返回更新过的日期。 */
    summarize_due(summarize: TimelineSummarizer, now?: number): Promise<string[]>;
    /** 读一天的 node（摘要 + 记录 + 元数据）；可用 filter 按人/会话过滤。 */
    read_day(date: string, filter?: TimelineReadFilter): TimelineDay;
    /**
     * 读一段日期区间（含两端）。
     *
     * @param from - 起始 `YYYY-MM-DD`。
     * @param to - 结束 `YYYY-MM-DD`；缺省等于 `from`。
     */
    read_range(from: string, to?: string): TimelineDay[];
    /** 列出所有 node 的元数据（按日期升序）。 */
    list_days(): TimelineDayMeta[];
    /** 读原始摘要文本；没有则 undefined。 */
    read_summary(date: string): string | undefined;
    /**
     * 跨天全文搜索（大小写不敏感的朴素子串匹配）。
     *
     * 长期记忆规模有限（一天一个文件），朴素扫描足够；命中按时间倒序返回。
     */
    search(keyword: string, options?: {
        limit?: number;
        from?: string;
        to?: string;
        user_id?: string;
        session_id?: string;
    }): TimelineSearchHit[];
    /** 全局统计。 */
    stats(): TimelineStats;
    /** 时间戳 → 时区内的日期键。 */
    day_key(ts: number): string;
    private entries_path;
    private summary_path;
    private view_path;
    private index_path;
    private read_entries;
    private meta_for;
    private empty_meta;
    private refresh_meta;
    /**
     * 读索引；**缺失或损坏时自动从权威 JSONL 重建**。
     *
     * 审计复现过：索引坏掉后旧日期"数据还在但彻底不可发现"（list_days/search/摘要调度都看不到）。
     * 所以这里不能返回空索引了事——记录文件才是权威，索引只是缓存，坏了就重建。
     */
    private load_index;
    /** 从磁盘重建索引（带递归保护：重建期间再问索引就返回空表）。 */
    private rebuild_from_disk;
    private save_index;
    /**
     * 原子写：临时文件 + rename。
     *
     * 临时名带**进程内递增序号**：同一进程同一毫秒的两次写不会撞名
     * （只带 pid 会撞，因为 pid 相同）；rename 带重试，Windows 并发时偶发 EPERM。
     */
    private write_atomic;
}
/** 全局统计结果。 */
export interface TimelineStats {
    readonly days: number;
    readonly entries: number;
    readonly first_date?: string;
    readonly last_date?: string;
}
//# sourceMappingURL=timelineStore.d.ts.map