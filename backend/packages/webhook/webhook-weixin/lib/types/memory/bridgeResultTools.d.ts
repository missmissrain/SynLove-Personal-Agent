/**
 * codex-opencode 处理结果日志：按需取回"任务做完了但当时没能推给你"的结果。
 *
 * 为什么需要它：平台只允许在"用户刚发过消息"的窗口内发送（实测：旧 token / 无 token /
 * 先调 notifystart 全都会 ret=-2）。所以当任务在用户不在微信时完成，结果推不出去；
 * 与其反复重试或直接丢弃，不如**停放在队列里保留一段时间**，等用户主动问起再返回。
 *
 * 工具名用英文标识符（协议要求），但**说明里写明中文名**，界面与模型都能看懂。
 *
 * @module dsh-webhook-weixin/bridge-result-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/**
 * 注册"处理结果日志"工具。
 *
 * @param agent_ctx - agent 自己的 ctx。
 * @param store - 微信状态库（停放结果就在 outbox 里）。
 * @param retention_ms - 停放保留期，用于告诉模型结果会保留多久。
 */
export declare function register_bridge_result_tools(agent_ctx: Context, store: WeixinStateStore, retention_ms?: number): void;
//# sourceMappingURL=bridgeResultTools.d.ts.map