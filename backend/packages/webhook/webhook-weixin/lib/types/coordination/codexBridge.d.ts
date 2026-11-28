/**
 * Codex 远程桥：让用户用微信直接遥控本机 Codex，并把 Codex 的输出主动推回微信。
 *
 * 思路沿用作者早前的 Telegram 版本桥接实践（本仓库不含那份实现）。
 * 本模块把它搬到微信链路上，并复用我们已有的 durable outbox 做推送：
 *   - 入站：以 `/codex` 开头的消息不走大模型，直接交给 Codex 执行；
 *   - 出站：Codex 的每一步事件（思考/命令/结果）都作为消息推进 outbox，按节流发出；
 *   - 会话：记住 thread_id，后续 `/codex` 默认续用同一线程（可用 `/codex new` 强制新开）；
 *   - 控制：`/codex stop` 终止当前任务、`/codex status` 查看状态。
 *
 * 用 `codex exec --json`：它按行输出结构化事件（thread.started / item.completed / turn.completed），
 * 比 app-server 的 JSON-RPC 简单得多，足够做"边跑边推"。
 * @module dsh-webhook-weixin/codex-bridge
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/** 推送回调：把一条消息推给用户（走 outbox）。 */
export type CodexPush = (text: string, kind: 'progress' | 'assistant' | 'error') => void;
/** 解析出来的命令。 */
export interface CodexCommand {
    readonly action: 'run' | 'stop' | 'status' | 'help' | 'new';
    readonly text: string;
}
/** 识别 `/codex` 指令；不是则返回 undefined。 */
export declare function parse_codex_command(text: string): CodexCommand | undefined;
/** 微信远程 Codex 桥。 */
export declare class CodexBridge {
    private readonly store;
    private readonly push;
    private readonly workspace;
    private readonly tasks;
    private readonly seq;
    /** 绑定状态库与推送实现。 */
    constructor(store: WeixinStateStore, push: (user_id: string, session_id: string, text: string, kind: 'progress' | 'assistant' | 'error', context_token?: string) => void, workspace?: string);
    /** 处理一条 `/codex` 指令。 */
    handle(user_id: string, session_id: string, command: CodexCommand, context_token?: string): Promise<void>;
    /** 终止某用户当前任务；返回是否真的终止了。 */
    stop(user_id: string): boolean;
    /** 当前用户是否有任务在跑。 */
    is_running(user_id: string): boolean;
    /** 读取该用户记住的 Codex 线程 id。 */
    thread_for(user_id: string): string | undefined;
    /** 执行一次 Codex 任务，边跑边把事件推给用户，结束后发最终结果。 */
    private run;
    /** 解析单个 Codex JSON 事件并（必要时）推送给用户。 */
    private consume_event;
}
//# sourceMappingURL=codexBridge.d.ts.map