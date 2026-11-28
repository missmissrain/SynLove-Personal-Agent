/**
 * 工具 `bridge_sessions`：把本机 Codex / opencode 的**会话清单与聊天记录**摆给模型看。
 *
 * 存在的理由：用户会在微信里说"上次那个会话继续做""把那个项目的会话列出来"，
 * 但模型此前只能看到"任务完成"的推送，看不到**会话本身**——于是没法远程指挥。
 * 这个工具补上这一环：先列会话（带名字/目录/状态），再按 id 读聊天记录，
 * 拿到 id 之后就能用 `codex` / `opencode` 工具续会话。
 *
 * 数据来源（都是**只读**打开，不会干扰正在跑的工具）：
 * - Codex：`~/.codex/state_5.sqlite` 的 `threads` 表 + 每个会话的 rollout JSONL；
 * - opencode：`~/.local/share/opencode/opencode.db` 的 `session` / `message` / `part` 三张表。
 *
 * @module dsh-webhook-weixin/bridge-session-tools
 */
import type { Context } from '@deepseek-ai/cordis';
/** 一个会话的摘要（两种工具统一成这个形状）。 */
export interface BridgeSession {
    readonly tool: 'codex' | 'opencode';
    readonly id: string;
    readonly title: string;
    readonly workspace: string;
    /** 状态或补充说明（codex 有 运行中/已完成；opencode 没有生命周期事件）。 */
    readonly status: string;
    readonly updated_at: number;
    /** codex 专用：rollout 文件路径。 */
    readonly rollout_path?: string;
}
/** 一条聊天记录。 */
export interface BridgeMessage {
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly at?: string;
}
/** 列出最近的 Codex 会话。 */
export declare function list_codex_sessions(limit?: number): BridgeSession[];
/**
 * 读一个 Codex 会话的聊天记录（按时间顺序返回最后 limit 条）。
 *
 * rollout 是 JSONL：用户与助手的真实消息都在 `response_item` / `message` 里，
 * 其余是工具调用等内部事件，这里全部跳过（用户要看的是对话，不是内部轨迹）。
 */
export declare function read_codex_messages(rollout_path: string, limit?: number): BridgeMessage[];
/** 列出最近的 opencode 会话。 */
export declare function list_opencode_sessions(limit?: number): BridgeSession[];
/** 读一个 opencode 会话的聊天记录（按时间顺序返回最后 limit 条）。 */
export declare function read_opencode_messages(session_id: string, limit?: number): BridgeMessage[];
/** 注册会话查询工具。 */
export declare function register_bridge_session_tools(agent_ctx: Context): void;
//# sourceMappingURL=bridgeSessionTools.d.ts.map