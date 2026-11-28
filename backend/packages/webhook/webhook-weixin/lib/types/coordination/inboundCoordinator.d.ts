/**
 * 入站协调器：微信链路唯一的消息协调者。
 *
 * 重构设计文档 §3.2 / §6：负责幂等登记、路由、控制命令、投递顺序与恢复。
 * 它**不**维护模型执行状态（那是 Harness Agent inbox 的职责），**不**维护第二套队列，
 * **不**负责发送（那是 OutboundCoordinator）。
 *
 * 关键变化（对应诊断 1/2/4/5/6）：
 * - 全局单串行链 → 按 user_id 分片的 keyed scheduler（同用户保序，不同用户并发）；
 * - 控制命令也走同一个状态机并做 delivery 去重；
 * - 停止回执使用真实路由 SessionId，而不是 `weixin-${user_id}` 拼接；
 * - cursor 提交改为"批次内所有 delivery 达到终态"语义；
 * - 媒体下载与附件保存只阻塞该用户，不阻塞全局。
 * @module dsh-webhook-weixin/inbound-coordinator
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { WeixinAttachmentStore, WeixinSessionHost } from '../session/weixinSessionHost.ts';
import type { NormalizedWeixinMessage } from '../message/messageNormalizer.ts';
import { type WeixinStateStore } from '../state/weixinStateStore.ts';
import type { TurnContextStore } from '../state/turnContextStore.ts';
import type { CodexCommand } from './codexBridge.ts';
import type { OpencodeCommand } from './opencodeBridge.ts';
import type { ControlCommand } from '../types/domain.ts';
import type { TimelineEntry } from '../memory/timelineTypes.ts';
/**
 * 把同一合并窗口里的若干条消息并成"一条"。
 *
 * 规则：文本按收到顺序用换行连起来；媒体依次拼接；**context_token 取最后一条**——
 * 回复窗口是"用户最近一次发言"开的，用最后那条的 token 才发得出去。
 */
export declare function merge_messages(messages: readonly NormalizedWeixinMessage[]): NormalizedWeixinMessage;
/** 解析控制命令；普通正文返回 undefined。 */
export declare function parse_control_command(text: string): ControlCommand | undefined;
/** 出站入队回调（由 OutboundCoordinator 注入，避免反向依赖）。 */
export type EnqueueOutbound = (input: {
    session_id: string;
    user_id: string;
    kind: 'control_ack' | 'error' | 'progress';
    text: string;
    context_token?: string;
    turn?: number;
}) => void;
/** 构造参数。 */
export interface InboundCoordinatorOptions {
    readonly store: WeixinStateStore;
    readonly turn_context: TurnContextStore;
    readonly host: WeixinSessionHost;
    readonly attachments?: WeixinAttachmentStore;
    readonly enqueue_outbound: EnqueueOutbound;
    /** Agent 就绪回调（用于绑定 assistant-stream 监听）。 */
    readonly on_agent_ready?: (agent: Agent) => void;
    /** Agent 创建/恢复后回调，用于建立 turn 级上下文监听。 */
    readonly on_agent_bound?: (agent: Agent) => void;
    /** 通道侧媒体发送能力（微信目前只支持图片）；不提供则 send_file 工具不注册 */
    readonly send_media?: (user_id: string, path: string, context_token?: string) => Promise<void>;
    /**
     * 用户要求停止时的**外部任务中断**回调（可选）。
     *
     * 由连接器实现：杀掉 opencode/codex 正在跑的 `run` 进程，并停掉桥里的任务。
     * 返回实际杀掉的进程数——回执文案据此如实描述，不许无核实地说"已停止"。
     */
    readonly on_cancel?: (user_id: string) => Promise<{
        killed: number;
        pids: readonly number[];
    }>;
    /**
     * 用户取消后**必须**做的收尾（停心跳、清"进行中"标记、清聚合器）。
     *
     * 为什么不能只靠 `agent/turn-stopping`：实测 `agent.cancel()` 走 abort 路径时那个事件不会来，
     * 结果是心跳每 5 分钟继续发「还在处理中」、`inflight_turn` 标记也留着
     * （下次启动会把**已经取消的任务**当"被打断"重跑一遍）。
     */
    readonly on_turn_cancelled?: (session_id: string) => void;
    /**
     * 每条真实用户消息（已定好会话）回调一次。
     *
     * 用途：模型故障转移时要"把用户刚才那条重做一遍"，所以连接器需要记住最后一条消息文本。
     * 只放在内存里、且只保留最近一条——不是聊天记录存储（那件事归时间线）。
     */
    readonly on_user_message?: (session_id: string, user_id: string, text: string) => void;
    /**
     * Codex 远程桥（可选）。给了就会把 `/codex ...` 消息交给它，
     * 实现"微信遥控 Codex + Codex 输出主动推回微信"。
     */
    readonly codex_bridge?: {
        parse(text: string): CodexCommand | undefined;
        handle(user_id: string, session_id: string, command: CodexCommand, context_token?: string): Promise<void>;
    };
    /** opencode 远程桥（可选）：`/opencode ...` 走它，输出主动推微信。 */
    readonly opencode_bridge?: {
        parse(text: string): OpencodeCommand | undefined;
        handle(user_id: string, session_id: string, command: OpencodeCommand, context_token?: string): Promise<void>;
    };
    /**
     * 媒体补全（可选）：下载图片/文件/语音的字节并填入消息。
     *
     * 不给就退化成"只有 `[微信媒体 image]` 占位文字"，用户发的图/文件不会被真正保存。
     * 下载失败由实现内部降级为说明文字，不能因此让整条消息失败。
     */
    readonly hydrate_message?: (message: NormalizedWeixinMessage) => Promise<NormalizedWeixinMessage>;
    /**
     * 把"用户上行"记进长期记忆（时间线）。
     *
     * 在 delivery **首次登记**时调用（不是注入成功后）：用户确实说了这句话，
     * 而且 delivery_id 天然稳定，重放/恢复不会记重复。
     */
    readonly record_entry?: (entry: TimelineEntry) => void;
}
/** 微信入站协调器。 */
export declare class InboundCoordinator {
    private readonly options;
    private disposed;
    private readonly shards;
    private readonly pending_media;
    /** 各用户最近一次 context_token（媒体被动回复要用） */
    private readonly latest_token;
    /**
     * 同一个人连续发的消息先攒着，静默 COALESCE_MS 之后**合并成一条**喂给模型。
     *
     * 为什么要攒：人是断续打的（"在吗" → "帮我看看" → "那个文件"），逐条喂会得到三次回答，
     * 又慢又吵；合并成一次提问，模型也更容易答到点上。控制命令（`/codex`、`/opencode`）
     * 与纯媒体消息**不缓冲**，立刻处理。
     */
    private readonly coalesced;
    /** 合并窗口内最近一次收到消息的时间（用于日志里的"等了多久"）。 */
    private readonly coalesced_last_at;
    /** delivery 成功注入后记录的 `delivery_id → session_id`，供 outbox 绑定使用。 */
    private readonly delivery_sessions;
    /** 绑定状态库与宿主。 */
    constructor(options: InboundCoordinatorOptions);
    /** 暴露 delivery → session 映射（outbox 需要）。 */
    session_for_delivery(delivery_id: string): string | undefined;
    /**
     * 处理一个批次：逐条登记 + 分片投递，最后按"全部达到终态"决定是否提交 cursor。
     *
     * @param messages - 本批消息
     * @param cursor - 平台游标
     * @param options.hold - true 时**只登记不投递**（压缩上下文期间用）：
     *   delivery 停在 `received` 且 payload 已落库，压缩结束后由 `recover_unfinished()` 重投。
     *   此时故意不返回可提交，让游标保持未提交、消息不会丢。
     * @returns 是否允许提交该批次 cursor。
     */
    handle_batch(messages: readonly NormalizedWeixinMessage[], cursor: string | undefined, options?: {
        hold?: boolean;
    }): Promise<boolean>;
    /** 把一条消息排进其所属用户的分片链；同用户严格保序，不同用户并发。 */
    private enqueue_for_user;
    /** 处理单条消息：Codex 指令 / 控制命令 / 普通消息。 */
    private process_message;
    /** message 为原始投递，error 为处理异常；统一计次、记录原错并在达到上限时发送失败回执。 */
    private handle_message_failure;
    /** 应用控制命令（幂等：delivery 已登记过就不会重复执行）。 */
    private apply_control;
    /**
     * 普通消息入口：先攒进合并窗口，静默一段时间后一次性注入。
     *
     * 不缓冲的情况：
     * - 关闭了合并（COALESCE_MS = 0）；
     * - 只有媒体没有文字 —— 那种要等用户补文字，交给 `inject_message` 自己的媒体缓存逻辑。
     */
    private coalesce_message;
    /** 合并窗口到期：把攒下的消息并成一条注入（游标要等这条注入完才提交）。 */
    private flush_coalesced;
    /** delivery_id 为已登记投递；复用既有 routing，只从明确可处理状态进入路由。 */
    private begin_routing;
    /** 无参数；取消尚未到期的合并计时器，保留数据库载荷供下次恢复。 */
    dispose(): Promise<void>;
    /** 普通消息：媒体 → Agent → followup → 标记 injected。 */
    private inject_message;
    /** 构造消息内容块；媒体下载失败降级为说明文本，不影响文字投递。 */
    private build_content;
    /**
     * 恢复未完成的 delivery（设计文档 §5.2 的恢复协议）。
     *
     * 关键：**不能因为 delivery 已有 session_id 就把它标成 injected**。那样会掩盖这个窗口：
     * `delivery 已登记 → session_id 已写入 → agent.followup() 尚未执行 → 进程崩溃`。
     * 有 `payload_json` 的必须重新走一遍完整注入，成功才由 process_message 写 injected；
     * 失败则保持 failed_retryable，交给现有重试机制——绝不"假成功"地丢消息。
     */
    recover_unfinished(): Promise<{
        recovered: number;
        needs_reinject: number;
    }>;
    /** 该 delivery 是否可提交 cursor。 */
    is_committable(delivery_id: string): boolean;
}
//# sourceMappingURL=inboundCoordinator.d.ts.map