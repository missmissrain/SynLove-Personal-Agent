/**
 * opencode 远程桥：用微信遥控本机 opencode，并把它的输出主动推回微信。
 *
 * 与 codexBridge 同构（`/opencode` 指令），但驱动的是 opencode CLI。
 * 关键工程点（都是踩过来的坑）：
 * - 必须 `--attach <server>`：脱离 server 续会话会无限阻塞；服务器由启动器保证在跑。
 * - 必须关掉 stdin：opencode 会读管道 stdin，开着就永不返回。
 * - **必须有硬超时并杀掉**：opencode 的 provider 可能长时间 stream error 重试
 *   （实测 `opencode-go` 报 stream error 时 run 会卡住十几分钟），不能让它拖死微信链路。
 * - 可用 `DSH_OPENCODE_MODEL` 覆盖模型，绕开出故障的默认 provider。
 * @module dsh-webhook-weixin/opencode-bridge
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/** `/opencode` 指令。 */
export interface OpencodeCommand {
    readonly action: 'run' | 'stop' | 'status' | 'help' | 'new' | 'yes' | 'no';
    readonly text: string;
}
/** 识别 `/opencode`（或 `/oc`）指令。 */
export declare function parse_opencode_command(text: string): OpencodeCommand | undefined;
/** 微信遥控 opencode 的桥。 */
export declare class OpencodeBridge {
    private readonly store;
    private readonly push;
    private readonly server_url;
    private readonly workspace;
    private readonly tasks;
    /** 等用户确认"切火山"的挂起任务。 */
    private readonly pending;
    /** 用户已同意切火山；在 TTL 内有效。 */
    private readonly approvals;
    private readonly chain;
    /** 绑定状态库、推送回调、server 地址与工作区。 */
    constructor(store: WeixinStateStore, push: (user_id: string, session_id: string, text: string, kind: 'progress' | 'assistant' | 'error', context_token?: string) => void, server_url?: string, workspace?: string);
    /** 当前是否在有效期内的"已同意切火山"。 */
    private has_volcengine_approval;
    /** 处理一条 `/opencode` 指令。 */
    handle(user_id: string, session_id: string, command: OpencodeCommand, context_token?: string): Promise<void>;
    /**
     * 依次用给定模型尝试任务。
     * @returns 'ok' 表示成功；'connectivity_failed' 表示全部因连通性失败；'failed' 表示任务本身失败。
     */
    private try_chain;
    /** 终止当前任务；返回是否真的终止。 */
    stop(user_id: string): boolean;
    /**
     * 执行一次任务：边跑边把有意义的输出行推给用户，结束后给结论。
     * @returns ok=成功；connectivity=连通性失败（调用方据此降级）；否则是任务本身失败。
     */
    private run;
}
//# sourceMappingURL=opencodeBridge.d.ts.map