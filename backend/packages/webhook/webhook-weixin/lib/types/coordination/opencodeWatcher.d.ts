/**
 * opencode 完成监视器：盯着本机 opencode，任务结束就把结果推到微信。
 *
 * **与微信桥的分工（防止重复汇报）**：
 * - 通过微信 `/opencode` 发起的任务 → 由 OpencodeBridge 自己的闭环汇报（含实时输出与完成通知）；
 * - 这个监视器只负责**外部发起**的任务（opencode 桌面/CLI 里自己跑的）。
 * 为区分二者，OpencodeBridge 每次运行都会把时间窗写进 meta（`oc_bridge_window`），
 * 监视器跳过落在窗口内的会话，避免同一任务被报两次。
 *
 * 数据来源：`~/.local/share/opencode/opencode.db`（只读）
 *   - `session`：id / directory / title / time_created / time_updated / model
 *   - `message`：session_id + data(JSON, role)
 *   - `part`：message_id + data(JSON, type=text/tool/step-finish)
 * @module dsh-webhook-weixin/opencode-watcher
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/** 推送回调。 */
export type WatchPush = (user_id: string, text: string) => void;
/** 构造参数。 */
export interface OpencodeWatcherOptions {
    readonly store: WeixinStateStore;
    readonly push: WatchPush;
    /** 轮询间隔（毫秒）；默认 10 秒。 */
    readonly poll_ms?: number;
    /** opencode 数据目录；默认 ~/.local/share/opencode。 */
    readonly data_dir?: string;
    /** 结果文本上限。 */
    readonly summary_limit?: number;
    /** 会话"静默"多久算完成（毫秒）；默认 8 秒。 */
    readonly idle_ms?: number;
}
/** opencode 完成监视器。 */
export declare class OpencodeWatcher {
    private readonly store;
    private readonly push;
    private readonly poll_ms;
    private readonly data_dir;
    private readonly summary_limit;
    private readonly idle_ms;
    private timer;
    private sweeping;
    private seeded;
    /** 绑定状态库与推送实现。 */
    constructor(options: OpencodeWatcherOptions);
    /** 开始监视；幂等。 */
    start(): void;
    /** 停止监视；幂等。 */
    stop(): void;
    /** 手动扫一轮（供测试与诊断直接调用）。 */
    sweep_once(): Promise<void>;
    /** 扫一轮：找出"刚完成"的外部 opencode 会话并推送。 */
    private sweep;
    /** 该会话是否落在微信桥的运行窗口内（防重复汇报）。 */
    private within_bridge_window;
    /** 读取最近更新的会话。 */
    private read_recent_sessions;
    /**
     * 取会话**最后一条助手消息**的 id 与其文本。
     *
     * 先定位最后一条 assistant message（按 message.rowid 倒序），再取该消息的 text 分片——
     * 这样得到的 message_id 就是稳定的"完成指纹"，同一轮完成不会被重复汇报。
     */
    private last_assistant_message;
    /** 取会话最后一条用户消息文本（作为任务标题）。 */
    private last_user_text;
}
//# sourceMappingURL=opencodeWatcher.d.ts.map