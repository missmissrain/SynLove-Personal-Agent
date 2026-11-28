/**
 * 向 QQ 发送消息（官方 v2 HTTP 接口）。
 *
 * 两种消息形态（官方定义）：
 * - **被动消息**：带 `msg_id`（回复用户那条消息），单聊有效期 **60 分钟 / 每条最多回 4 次**，
 *   群聊 **5 分钟 / 最多 5 次**；
 * - **主动消息**：不带 `msg_id`，随时可发（受频控：单聊 20 qpm / 1000 条/天/用户）。
 *
 * 这里默认走"被动回复"（带 msg_id），失败再退回主动推送 —— 这样正常对话零成本，
 * 而"没人说话时也想说一句"（定时提醒、长任务完成汇报）时主动推送仍可用。
 *
 * @module dsh-webhook-qq/send
 */
/** 发送目标：单聊按用户 openid，群聊按群 openid。 */
export interface QqSendTarget {
    /** 用户 openid（单聊） */
    readonly userOpenid?: string;
    /** 群 openid（群聊） */
    readonly groupOpenid?: string;
}
/** 发送结果：ok=false 时带可核对的原因。 */
export interface QqSendResult {
    readonly ok: boolean;
    /** 实际走的通道：passive=带 msg_id 回复，active=主动推送 */
    readonly mode: 'passive' | 'active';
    /** 官方返回的 msg id（成功时） */
    readonly id?: string;
    /** 失败原因（HTTP 状态 / err_code / message） */
    readonly error?: string;
}
/** 把长文本切成若干条（不拆开英文字母/数字太多的情况，简单按长度切）。 */
export declare function split_text(text: string, limit?: number): string[];
/**
 * 发一条文本消息。
 *
 * @param tokenProvider - 取 access_token 的函数（过期自动刷新）
 * @param target - 单聊或群聊目标
 * @param text - 文本内容
 * @param msgId - 被动回复时要带的消息 id；省略=主动推送
 * @param baseUrl - 接口基址
 * @returns 发送结果（不抛异常，便于调用方记录并降级）
 */
export declare function send_qq_text(tokenProvider: {
    get(): Promise<string>;
}, target: QqSendTarget, text: string, msgId?: string, baseUrl?: string, progress?: {
    sent_parts: readonly number[];
    on_sent: (index: number) => void;
}): Promise<QqSendResult>;
/**
 * 发一个本地文件/图片到 QQ（官方富媒体：先上传拿 file_info，再发 msg_type=7）。
 *
 * 为什么要先上传：QQ 的富媒体消息不带本地路径，必须先调 `/files` 拿到 `file_info`。
 * 被动回复优先（带 msg_id）；失败回退主动消息（不带 msg_id）。
 */
export declare function send_qq_media(tokenProvider: {
    get(): Promise<string>;
}, target: QqSendTarget, filePath: string, msgId?: string, baseUrl?: string): Promise<QqSendResult>;
//# sourceMappingURL=send.d.ts.map