/** 微信消息规范化层：统一文本、图片、文件、语音元数据，并保留语音文本优先级。 */
import type { IlinkMedia, IlinkMessage } from '../api/ilinkTypes.ts';
export interface NormalizedMedia {
    kind: 'image' | 'voice' | 'file';
    name?: string;
    mime_type?: string;
    data?: Uint8Array;
    raw_data?: Uint8Array;
    transcoded?: boolean;
    source_text?: string;
    media?: IlinkMedia;
}
export interface NormalizedWeixinMessage {
    delivery_id: string;
    user_id: string;
    context_token?: string;
    text: string;
    media: NormalizedMedia[];
    received_at: number;
}
export type MediaLoader = (media: IlinkMedia) => Promise<Uint8Array>;
/** 将 iLink 消息转换为稳定的 Harness 入站结构；不执行网络和模型调用。 */
export declare class MessageNormalizer {
    /** 规范化消息并生成稳定 delivery id。 */
    normalize_message(message: IlinkMessage): NormalizedWeixinMessage;
    /** 下载并填充消息中的媒体字节；语音已有文本时不触发下载或 ASR。 */
    hydrate_media(message: NormalizedWeixinMessage, loader: MediaLoader): Promise<NormalizedWeixinMessage>;
    /** 解析一个消息项，保证 voice_item.text 优先于语音媒体。 */
    private normalize_item;
}
//# sourceMappingURL=messageNormalizer.d.ts.map