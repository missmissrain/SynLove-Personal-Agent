/**
 * Codex 任务完成监视器：被动盯着本机 Codex，任务一结束就主动把结果推到微信。
 *
 * 一个容易走错的思路是"用 Codex 的 `notify` 钩子让独立进程直接推送"。
 * 微信链路里不能那么做：独立进程直接调 iLink 会变成**第二个消费者**，
 * 与 harness 抢同一个微信账号（我们为此吃过亏）。所以这里在 harness 内部做轮询式监视，
 * 推送复用同一条 durable outbox —— 不新增消费者、不新增发送路径。
 *
 * 数据来源（与 Telegram 版一致，已验证可行）：
 *   - `~/.codex/state_5.sqlite` 的 `threads` 表 → 最近的会话及其 rollout 路径/工作区/标题；
 *   - rollout JSONL 尾部 → 生命周期事件 `task_started` / `task_complete` / `turn_aborted`；
 *   - rollout 里的 `response_item(role=assistant)` → 最终回答文本。
 *
 * 关键行为：**首次扫描只记录基线、不通知**（否则重启会把历史任务全推一遍）。
 * @module dsh-webhook-weixin/codex-watcher
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/** 推送回调（由连接器注入，走 outbox）。 */
export type WatchPush = (user_id: string, text: string) => void;
/** 构造参数。 */
export interface CodexWatcherOptions {
    readonly store: WeixinStateStore;
    /** 有任务完成时调用；user_id 由连接器决定。 */
    readonly push: WatchPush;
    /** 轮询间隔（毫秒）；默认 8 秒。 */
    readonly poll_ms?: number;
    /** Codex home；默认 ~/.codex。 */
    readonly codex_home?: string;
    /** 通知里附带的结果文本上限。 */
    readonly summary_limit?: number;
}
/** Codex 任务完成监视器。 */
export declare class CodexWatcher {
    private readonly store;
    private readonly push;
    private readonly poll_ms;
    private readonly codex_home;
    private readonly summary_limit;
    private timer;
    private sweeping;
    /** 是否已完成首轮基线扫描（首轮不通知）。 */
    private seeded;
    /** 绑定状态库与推送实现。 */
    constructor(options: CodexWatcherOptions);
    /** 开始监视；幂等。 */
    start(): void;
    /** 停止监视；幂等。 */
    stop(): void;
    /** 扫一轮：读取最近的 Codex 会话状态，检测"刚完成"并推送。 */
    private sweep;
    /** 组装通知文本。 */
    private compose;
    /** 读取最近的非归档 Codex 会话状态（只读，不打扰 Codex）。 */
    private read_statuses;
    /** 从 rollout 尾部找最近的生命周期事件（倒序扫描，避免读整个大文件）。 */
    private read_lifecycle;
    /** 取最近一条真实用户消息作为任务标题。 */
    private latest_user_message;
    /** 取最近一条助手回答文本。 */
    private latest_assistant_text;
    /** 从文件尾部往前找第一个满足条件的行（避免全文件解析）。 */
    private scan_tail;
}
/** 列出最近修改过的 rollout 文件（诊断用；正常流程走 state_5.sqlite）。 */
export declare function list_recent_rollouts(codex_home: string, limit?: number): string[];
//# sourceMappingURL=codexWatcher.d.ts.map