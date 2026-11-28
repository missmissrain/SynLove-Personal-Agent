/**
 * 微信链路唯一状态存储（SQLite）。
 *
 * 重构设计文档 §5.1：不再新增临时 JSON 作为状态源，所有外部协议状态集中在一个库里：
 *   consumer_lease / transport_cursor / route / delivery / outbox / turn_context / meta
 *
 * 关键语义（§5.3）：**任何写失败都必须 reject 调用方**，禁止"记日志后 resolve"。
 * 事务由 SQLite 原生事务保证；跨进程互斥由 lease 表 + 主键冲突保证原子性。
 *
 * 使用 Node 内置 `node:sqlite`（Node 22+），无需第三方依赖。
 * @module dsh-webhook-weixin/state-store
 */
import type { DeliveryRecord, DeliveryStatus, OutboxKind, OutboxRecord } from '../types/domain.ts';
/**
 * 状态库 schema 版本；不匹配时 fail closed（禁止自动清空）。
 * v2：delivery 增加 context_token 列（回复需要它，之前没存导致只能无 token 发送）。
 * v3：delivery 增加 payload_json 列（崩溃恢复时据此**重新注入**，而不是误标 injected）；
 *     outbox 增加 sent_parts_json 列（分段发送断点续传，避免重试重复发已成功段）。
 */
export declare const STATE_SCHEMA_VERSION = 3;
/**
 * meta 表里"这一轮还在进行中"的标记前缀：`inflight_turn:<session_id>`。
 *
 * 轮次开始写、正常结束**或用户取消**时删。进程被强杀时会留下残留，启动时据此
 * 把该轮 delivery 退回 received 重投（见 weixinConnector.rescue_interrupted_turns）。
 * 用户主动取消必须清掉它 —— 否则下次启动会把"用户已经叫停的任务"又跑一遍。
 */
export declare const INFLIGHT_TURN_PREFIX = "inflight_turn:";
/** 构造参数。 */
export interface WeixinStateStoreOptions {
    /** SQLite 文件路径。 */
    readonly path: string;
    /** 是否允许在库不存在时创建；默认 true。 */
    readonly create?: boolean;
}
/** 微信链路状态库。所有公开写方法失败时抛出，调用方必须处理。 */
export declare class WeixinStateStore {
    private readonly db;
    private readonly storeDir;
    private closed;
    /** 打开（或创建）状态库并校验 schema。 */
    constructor(options: WeixinStateStoreOptions);
    /** 建表 + schema 校验；不匹配则 fail closed。 */
    private migrate;
    /** 读取某张表的列名集合；用于幂等的前向迁移。 */
    private column_names;
    /** 关闭数据库；幂等。 */
    close(): void;
    /**
     * 在一个事务里执行；抛错自动回滚并向上传播。
     * 这是"一个事实一个权威写入者"的实现手段：相关状态要么一起成功，要么一起不生效。
     */
    transaction<T>(fn: () => T): T;
    /** 读取当前 getUpdates 游标。 */
    get_cursor(): string;
    /** 提交游标；失败抛错（调用方不得把未落盘当作已提交）。 */
    set_cursor(cursor: string): void;
    /** 读一个 meta 键。 */
    get_meta(key: string): string | undefined;
    /** 写一个 meta 键。 */
    set_meta(key: string, value: string): void;
    /** 按前缀列出 meta 键值（启动时找"进行中的轮次"标记用）。 */
    list_meta_prefix(prefix: string): Array<{
        key: string;
        value: string;
    }>;
    /** 删除一个 meta 键（不存在也算成功）。 */
    delete_meta(key: string): void;
    /**
     * 共享会话的基名（用户要求"微信和 QQ 单聊聊同一段"时启用）。
     *
     * 开关：环境变量 `DSH_SESSION_SHARED` 非空；基名存在 `$DSH_HOME/shared-session.txt`
     * （清空上下文后代次会变，文件也会被改写，QQ 侧每次读它以保证两边同一个会话）。
     * 未启用时返回空串，行为与以前完全一致。
     */
    private shared_base;
    /** 把共享会话当前 id 写回文件（只在变化时写），让 QQ 通道跟着走。 */
    private persist_shared;
    /** 读取 user → session 路由。 */
    get_session_id(user_id: string): string | undefined;
    /**
     * 清空出站队列：删掉所有**未终态**的行（待发 / 发送中 / 停放待问）。
     *
     * 用"删"而不是"标记失败"：队列的用途只是"还没发出去的东西"，
     * 清空之后 `bridge_results` 里也不会再翻出这些旧内容——这才是用户要的"清空队列"。
     * 已发送（sent）与明确失败（failed_terminal）的历史不动，它们只是记录。
     *
     * @returns 删掉的条数。
     */
    clear_queue(): number;
    /**
     * 某个用户当前应使用的会话 id（把上下文代次编进去）。
     *
     * 代次 0（从没清空过）就用 `weixin-<user>`，保持历史数据不变；
     * 清空过就用 `weixin-<user>-c<epoch>`——换名字是为了**让新会话不与旧文件重名**，
     * 这样即便旧文件没删掉，也一定会新建一个空上下文的会话。
     */
    session_id_for(user_id: string): string;
    /**
     * 删除 user → session 路由（清空上下文用）。
     *
     * 删掉后下一条消息会走"新建会话"分支，于是拿到一个**全新**的会话（空上下文）。
     * 只删路由是不够的——旧会话文件还在原地，所以必须配合"换一个会话 id"（见 epoch），
     * 否则新建时会撞上已存在的同名会话、又恢复回旧上下文。
     */
    clear_session_id(user_id: string): void;
    /**
     * 上下文代次（epoch）：同一用户名下第几段会话。
     *
     * 每次"清空上下文"就 +1，于是新会话 id 变成 `weixin-<user>` 之外的另一个名字，
     * 不会与旧会话文件重名。**这样即使旧文件删不掉（路径推导失败/被占用），
     * 上下文也一定是干净的**——文件删除只是顺手回收磁盘。
     */
    context_epoch(user_id: string): number;
    /** 上下文代次 +1，返回新值。 */
    bump_context_epoch(user_id: string): number;
    /** 写入 user → session 路由。 */
    set_session_id(user_id: string, session_id: string): void;
    /** 列出所有有路由的微信用户（主动推送时要知道推给谁）。 */
    list_users(): string[];
    /** 统计路由条数与会话数（装配检查/诊断用）。 */
    route_summary(): {
        users: number;
        sessions: number;
    };
    /**
     * 幂等登记一条 delivery。
     * @returns `true` 表示首次登记（应继续处理）；`false` 表示此前已登记（重复投递）。
     * 注意：这里只登记接收事实，**不代表已注入会话**；cursor 提交仍取决于后续状态。
     */
    put_delivery_if_absent(record: {
        delivery_id: string;
        user_id: string;
        received_at: number;
        context_token?: string;
        /** 规范化后的入站消息（不含二进制），用于崩溃后重新注入。 */
        payload_json?: string;
    }): boolean;
    /** 最近一条入站消息的用户；调试注入口在未指定 user_id 时用它作为默认收件人。 */
    latest_user_id(): string | undefined;
    /** 读取某条 delivery 的 context_token（回复时必须用它）。 */
    delivery_context_token(delivery_id: string): string | undefined;
    /** 读取一条 delivery。 */
    get_delivery(delivery_id: string): DeliveryRecord | undefined;
    /**
     * 更新 delivery 状态（CAS：可指定期望的当前状态）。
     *
     * attempt 只统计**实际处理失败**的次数，不由状态迁移本身消耗：
     * `received → routing → injected` 是正常流转，不应该吃掉重试预算；
     * 只有重试与终态失败才传 `increment_attempt: true`。
     */
    update_delivery(delivery_id: string, status: DeliveryStatus, fields?: {
        session_id?: string;
        injected_at?: number;
        last_error?: string;
        expect?: DeliveryStatus;
        /** 是否消耗一次重试计数；默认 false（普通状态迁移不计次）。 */
        increment_attempt?: boolean;
    }): boolean;
    /** 列出未完成（需要恢复）的 delivery。 */
    list_unfinished_deliveries(limit?: number): DeliveryRecord[];
    /** 批次内 delivery 是否都达到可提交 cursor 的状态。 */
    batch_committable(delivery_ids: readonly string[]): boolean;
    /**
     * 入队一条出站消息；sequence 在同一 Session 内单调递增（由本方法分配）。
     * @returns 落库后的完整记录（含分配的 sequence）。
     */
    enqueue_outbox(input: {
        session_id: string;
        user_id: string;
        kind: OutboxKind;
        text: string;
        turn?: number;
        context_token?: string;
        client_id?: string;
    }): OutboxRecord;
    /**
     * 取出某 Session 中下一条可发送记录（pending 或到时间的 failed_retryable）。
     *
     * **优先级**：`turn` 非空的是"针对某一轮的正式回复"，`turn` 为空的是通知类
     * （codex/opencode 完成汇报、进度、心跳）。平台对短时发送条数有限额，通知量一大
     * 就会把正式回复挤到窗口外，所以回复一律排在通知前面。
     */
    next_outbox(session_id: string, now?: number): OutboxRecord | undefined;
    /** 列出所有会话中待处理的下一条（用于跨会话并发发送）。 */
    next_outbox_per_session(now?: number): OutboxRecord[];
    /** 标记发送中；失败抛错。 */
    mark_outbox_sending(outbound_id: string): void;
    /**
     * 列出"已停放、尚未送达"的处理结果（通知类），供工具按需取回。
     *
     * 场景：codex/opencode 任务做完了，但用户此时不在微信里（会话窗口关闭），
     * 平台不允许推送。这些结果**停放在队列里保留一段时间**，等用户主动问起时由工具返回，
     * 而不是反复重试（重试必然失败，还会拖慢真实回复）。
     */
    parked_results(limit?: number): Array<{
        outbound_id: string;
        sequence: number;
        text: string;
        created_at: number;
    }>;
    /** 丢弃超过保留期的停放结果（默认 6 小时），避免长期堆积。 */
    prune_parked_results(max_age_ms: number, now?: number): number;
    /**
     * 每个会话最多保留多少条**待发通知**（turn 为空）。
     *
     * 通知类消息（任务完成汇报、进度）时效性很强，积压后往往已经没意义，
     * 而且会占用平台的发送限额、把正式回复挤掉——所以超出上限时**丢最旧的**。
     */
    trim_pending_notices(session_id: string, keep?: number): number;
    /**
     * 记录某一分段已成功送达（立即落盘）。
     *
     * 必须在每段发送成功后马上写，而不是整条发完再写：否则进程在中间崩溃，
     * 重启后会从头重发，用户收到重复内容。
     */
    mark_outbox_part_sent(outbound_id: string, index: number): void;
    /** 标记已发送。 */
    mark_outbox_sent(outbound_id: string): void;
    /** 标记失败（可重试/终态），并给出下次重试时间。 */
    mark_outbox_failed(outbound_id: string, status: 'failed_retryable' | 'failed_terminal', error: string, next_retry_at?: number): void;
    /** 读取一条 outbox 记录。 */
    get_outbox(outbound_id: string): OutboxRecord | undefined;
    /** 列出未发送完成的记录（恢复用）。 */
    list_pending_outbox(limit?: number): OutboxRecord[];
    /** 绑定 `session_id + turn` → delivery/context_token（设计文档 §7.1）。 */
    bind_turn_context(input: {
        session_id: string;
        turn: number;
        delivery_id: string;
        user_id: string;
        context_token?: string;
    }): void;
    /** 读取某 turn 的上下文绑定。 */
    get_turn_context(session_id: string, turn: number): {
        delivery_id: string;
        user_id: string;
        context_token?: string;
    } | undefined;
    /** 最近一条 delivery → session 绑定（重启后补 turn context 用）。 */
    latest_delivery_for_session(session_id: string): DeliveryRecord | undefined;
    /** 清理过期的 turn_context（保留最近 N 个 turn）。 */
    prune_turn_context(session_id: string, keep?: number): void;
    /** 读取当前 lease（若有）。`process_started_at` 用于识别 pid 被回收的情况。 */
    get_lease(): {
        owner_id: string;
        pid: number;
        heartbeat_at: number;
        account_id: string;
        process_started_at: number;
    } | undefined;
    /**
     * 原子获取 lease：主键唯一 + UPDATE ... WHERE 条件保证只有一个进程成功。
     * @returns true 表示获取成功。
     */
    try_acquire_lease(input: {
        owner_id: string;
        pid: number;
        process_started_at: number;
        account_id: string;
        stale_ms: number;
    }): boolean;
    /** 续租；只有持有者能续。 */
    heartbeat_lease(owner_id: string): boolean;
    /** 释放 lease；只有持有者能释放。 */
    release_lease(owner_id: string): void;
    /** 诊断快照：各状态计数，供启动日志与探针使用。 */
    snapshot(): Record<string, unknown>;
}
/**
 * 判断 lease 里的持有者是否**真的还在**：pid 存活 **且** 启动时刻对得上。
 * 启动时刻拿不到时（权限/平台差异）退回"仅 pid 存活"，保持原有行为。
 */
export declare function lease_holder_alive(pid: number, recorded_started_at: number): boolean;
//# sourceMappingURL=weixinStateStore.d.ts.map