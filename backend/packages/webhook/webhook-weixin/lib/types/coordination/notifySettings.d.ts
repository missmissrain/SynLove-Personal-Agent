/**
 * 通知开关：控制 codex / opencode 的"任务完成汇报"是否推送到微信。
 *
 * 存在状态库的 `meta` 表里（`notify.codex` / `notify.opencode`，值为 `1`/`0`），
 * 所以**重启后依然生效**，不需要额外的配置文件。
 *
 * 为什么需要它：完成汇报是"外部发起的任务结束了"这类被动通知，
 * 有时候用户在专心聊天、不想被一堆任务汇报打断，就需要能关掉；
 * 但真实对话回复**不受这个开关影响**（那个永远要发）。
 *
 * @module dsh-webhook-weixin/notify-settings
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/** 可开关的通知来源。 */
export type NotifyTarget = 'codex' | 'opencode';
/** 通知开关。 */
export interface NotifySettings {
    /** 该来源的通知当前是否开启（默认开启）。 */
    is_enabled(target: NotifyTarget): boolean;
    /** 设置开关。 */
    set_enabled(target: NotifyTarget, enabled: boolean): void;
    /** 两个来源的当前状态。 */
    snapshot(): Record<NotifyTarget, boolean>;
}
/**
 * 基于状态库创建通知开关。
 *
 * @param store - 微信状态库（复用 meta 表，避免再引入一份配置）。
 */
export declare function create_notify_settings(store: WeixinStateStore): NotifySettings;
//# sourceMappingURL=notifySettings.d.ts.map