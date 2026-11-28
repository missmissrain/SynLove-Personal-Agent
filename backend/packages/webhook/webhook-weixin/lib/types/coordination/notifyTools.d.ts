/**
 * 通知开关工具：让欣爱自己查/改 codex 与 opencode 的完成汇报是否推送。
 *
 * 一个工具两个动作（而不是两个工具）：模型在工具变多时更容易选错，
 * 而"查状态"和"改开关"本来就是一回事的两面，合成一个入口更不容易用错。
 *
 * 只影响**被动通知**（外部发起的任务完成汇报）；真实对话回复不受影响。
 *
 * @module dsh-webhook-weixin/notify-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { NotifySettings } from './notifySettings.ts';
/**
 * 在 agent 作用域注册通知开关工具。
 *
 * @param agent_ctx - agent 自己的 ctx。
 * @param settings - 通知开关（读写状态库 meta）。
 */
export declare function register_notify_tools(agent_ctx: Context, settings: NotifySettings): void;
//# sourceMappingURL=notifyTools.d.ts.map