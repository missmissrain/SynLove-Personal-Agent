/**
 * Harness Agent 宿主接口 + 单一所有权实现。
 *
 * 重构设计文档 §8.1：必须选定一种所有权模型，禁止"连接器 handles"与"Harness owner effect"
 * 同时认为自己是最终 owner。此处采用 **gateway 统一持有** 模型：
 * - 本类是唯一保存 `AgentHandle` 的地方；
 * - Cordis teardown 只调用本类的 `dispose_agents()` 一次；
 * - `dispose` 在 stop / 插件卸载 / 重复 stop / 创建中止四种情况下都幂等。
 *
 * 同时 §8.2 要求：preset / agent-loop / sessionPersistence 缺失必须在**连接器启动时**失败，
 * 而不是第一条消息到达时才失败（由 `assert_capabilities()` 完成）。
 * @module dsh-webhook-weixin/session-host
 */
import { type FileHandle } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
/** 附件保存能力（由 harness attachments 服务提供）。 */
export interface WeixinAttachmentStore {
    saveImage(input: {
        data: Uint8Array;
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        name?: string;
    }): Promise<ImageAttachmentRef>;
    saveFile?(input: {
        data: Uint8Array;
        name?: string;
    }): Promise<FileAttachmentRef>;
}
/** 宿主必须提供的能力。 */
export interface WeixinSessionHost {
    get_agent(session_id: SessionId): Agent | undefined;
    create_agent(session_id: SessionId): Promise<Agent>;
    resume_agent(session_id: SessionId): Promise<Agent>;
}
/** 构造参数。 */
export interface HarnessSessionHostOptions {
    /** preset id；缺省用部署默认。 */
    readonly agent_preset?: string;
    /** 工作目录。 */
    readonly workspace_path: string;
    /** 模型 provider。必须传给 Agent，否则 preset 的 `{{model}}` 等提示变量无值。 */
    readonly provider?: string;
    /** 模型 id。必须传给 Agent，否则 preset 的 `{{model}}` 等提示变量无值。 */
    readonly model?: string;
    /** 推理强度（可选）。 */
    readonly reasoning_effort?: string;
}
/** 唯一的 Agent 所有权实现。 */
export declare class HarnessSessionHost implements WeixinSessionHost {
    private readonly ctx;
    private readonly options;
    private readonly handles;
    private disposed;
    private composition;
    /** 绑定 Cordis 上下文与组合参数。 */
    constructor(ctx: Context, options: HarnessSessionHostOptions);
    /**
     * 启动时装配检查（设计文档 §8.2 / §9.3）：缺任何一个必需服务都立即失败。
     * @throws 缺少 agents / agent-loop / agentPresets / sessionPersistence 时抛出。
     */
    assert_capabilities(): void;
    /**
     * 忘掉已解析的 preset 组合（挂载/卸载工具后调用）。
     *
     * `compose()` 是**按宿主实例记忆**的：不重置的话，改完 preset 之后
     * 新会话仍然拿到旧工具集，用户会以为"勾选了没生效"。
     * 重置后下一次创建 Agent 会重新解析 preset（已有 Agent 不受影响，
     * 需要新会话或清空上下文才会换上新工具）。
     */
    reset_composition(): void;
    /** 查找在线 Agent。 */
    get_agent(session_id: SessionId): Agent | undefined;
    /** 创建 Agent；Session 已存在时自动恢复。 */
    create_agent(session_id: SessionId): Promise<Agent>;
    /** 恢复持久化 Session。 */
    resume_agent(session_id: SessionId): Promise<Agent>;
    /**
     * 释放**单个** Agent（清空某个用户的上下文用），返回是否真的释放了。
     *
     * 必须是 owner 来释放：只有 dispose 才会关掉会话日志的写句柄。
     * 否则外部删掉 session 文件后，进程内残留的句柄会在下次 append 时
     * **新建一个没有 header 的坏文件**（实测的坑），那个会话就再也恢复不起来了。
     */
    dispose_agent(session_id: string): Promise<boolean>;
    /**
     * 释放本宿主创建的全部 Agent；**幂等**（重复调用、卸载后调用都安全）。
     * 这是唯一的 owner 释放点。
     */
    dispose_agents(): Promise<void>;
    /** 组装 preset（解析失败必须抛错，禁止静默降级成"无工具 Agent"）。 */
    private compose;
    /**
     * 组装 Agent 运行选项。
     *
     * provider/model 必须传给 `ctx.agents.create/resume`：preset 的 persona 前缀里有
     * `{{model}}` 这类提示变量，不传会导致 Agent 启动即报
     * `prompt variable "{{model}}" has no value for this assembly`，
     * 表现为"消息已注入但永远没有回复"（探针里能看到 agent.error）。
     */
    private agent_options;
    /** 卸载后禁止再创建。 */
    private assert_not_disposed;
}
/** 可选的调试日志写入器；仅在设置 DSH_WEIXIN_DEBUG_LOG 时生效。 */
export declare function trace_to_file(line: string): Promise<void>;
export type { FileHandle };
//# sourceMappingURL=weixinSessionHost.d.ts.map