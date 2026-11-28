/** 微信 iLink HTTP 客户端：封装长轮询、发消息、上传地址、启动停止通知和 CDN 媒体下载。 */
import type { IlinkClientOptions, IlinkGetUpdatesResponse, IlinkMessage, IlinkSendMessageInput, IlinkUploadRequest, IlinkUploadResponse } from './ilinkTypes.ts';
/** 可注入的 iLink 请求客户端，便于本地模拟和协议测试。 */
export declare class IlinkClient {
    private readonly options;
    private readonly fetch_impl;
    private readonly wechat_uin;
    /** 使用协议配置创建客户端；token 只保存在进程内。 */
    constructor(options: IlinkClientOptions);
    /** 执行一次 getUpdates 长轮询；外部 signal 可立即取消请求。 */
    get_updates(cursor: string, signal?: AbortSignal): Promise<IlinkGetUpdatesResponse>;
    /** 向一个微信用户发送单条文本消息。 */
    send_message(input: IlinkSendMessageInput, signal?: AbortSignal): Promise<void>;
    /** 以稳定 client_id 有限重试发送，避免瞬时网络错误导致回复丢失。 */
    send_message_with_retry(input: IlinkSendMessageInput, signal?: AbortSignal): Promise<void>;
    /** 通知微信连接器开始工作。 */
    notify_start(signal?: AbortSignal): Promise<void>;
    /** 通知微信连接器停止工作。 */
    notify_stop(signal?: AbortSignal): Promise<void>;
    /** 下载并解密一个媒体引用；无完整 URL 时要求调用方提供 CDN URL。 */
    download_media(media: {
        full_url?: string;
        encrypt_query_param?: string;
        aes_key?: string;
    }, signal?: AbortSignal): Promise<Buffer>;
    /** 获取微信 CDN 媒体上传地址，参数与官方 getuploadurl 协议一致。 */
    get_upload_url(input: IlinkUploadRequest, signal?: AbortSignal): Promise<IlinkUploadResponse>;
    /** 使用官方 AES-ECB 上传链路上传媒体并返回发送所需 CDN 引用。 */
    upload_media(input: {
        data: Uint8Array;
        to_user_id: string;
        media_type: number;
    }, signal?: AbortSignal): Promise<{
        filekey: string;
        encrypted_query_param: string;
        aes_key: string;
        rawsize: number;
        filesize: number;
    }>;
    /** 上传并回传一张图片；文本说明会作为独立 item 一并发送。 */
    send_image(input: {
        to_user_id: string;
        data: Uint8Array;
        context_token?: string;
        caption?: string;
    }, signal?: AbortSignal): Promise<void>;
    /** 返回协议所需的脱敏基础信息。 */
    private base_info;
    /** 发起带超时、Bearer Token 和 base_info 的 JSON POST。 */
    private post_json;
    /** 使用 PKCS#7 填充执行 AES-128-ECB 加密。 */
    private encrypt_aes_ecb;
}
export type { IlinkMessage };
//# sourceMappingURL=ilinkClient.d.ts.map