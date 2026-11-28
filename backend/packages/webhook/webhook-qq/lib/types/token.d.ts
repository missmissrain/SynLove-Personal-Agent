/**
 * QQ 官方机器人 access_token 提供者。
 *
 * 官方规则：`POST https://api.bot.qq.com/app/getAppAccessToken`（appId + clientSecret）
 * 返回 `{ access_token, expires_in }``，有效期默认 **7200 秒（2 小时）**；
 * 有效期内重复获取返回同一个值，过期后必须自己刷新。
 *
 * 这里做两件事：缓存 + 提前 60 秒刷新（官方**在过期前 60 秒内**取会拿到新 token，
 * 旧的这 60 秒仍可用，正好可以平滑过渡）。
 *
 * @module dsh-webhook-qq/token
 */
/** 配置：应用凭据（来自 QQ 开放平台管理端）。 */
export interface QqTokenOptions {
    /** 机器人 AppID */
    readonly appId: string;
    /** 机器人 AppSecret（QQ 文档里叫 clientSecret） */
    readonly clientSecret: string;
    /** 接口基址（默认官方 https://api.bot.qq.com；沙箱也用同一个） */
    readonly baseUrl?: string;
}
/** access_token 提供者：缓存 + 提前刷新。 */
export declare class QqTokenProvider {
    private readonly options;
    private token;
    private expiresAt;
    private pending;
    constructor(options: QqTokenOptions);
    /** 取一个可用 token（必要时刷新；并发调用只发一次请求）。 */
    get(): Promise<string>;
    /** 真正去换 token；失败直接抛（调用方按通道故障处理）。 */
    private fetch_token;
}
//# sourceMappingURL=token.d.ts.map