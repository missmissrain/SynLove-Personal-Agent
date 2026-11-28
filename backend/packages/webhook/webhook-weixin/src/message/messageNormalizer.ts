/** 微信消息规范化层：统一文本、图片、文件、语音元数据，并保留语音文本优先级。 */

import type { IlinkMedia, IlinkMessage, IlinkMessageItem } from '../api/ilinkTypes.ts'

export interface NormalizedMedia {
  kind: 'image' | 'voice' | 'file'
  name?: string
  mime_type?: string
  data?: Uint8Array
  raw_data?: Uint8Array
  transcoded?: boolean
  source_text?: string
  media?: IlinkMedia
}

export interface NormalizedWeixinMessage {
  delivery_id: string
  user_id: string
  context_token?: string
  text: string
  media: NormalizedMedia[]
  received_at: number
}

export type MediaLoader = (media: IlinkMedia) => Promise<Uint8Array>

/** 单个入站媒体的下载上限（字节）。超过就直接跳过，避免大文件把内存和链路拖死。 */
const MAX_MEDIA_BYTES = Number(process.env.DSH_WEIXIN_MAX_MEDIA_BYTES ?? String(20 * 1024 * 1024))

/** 将 iLink 消息转换为稳定的 Harness 入站结构；不执行网络和模型调用。 */
export class MessageNormalizer {
  /** 规范化消息并生成稳定 delivery id。 */
  normalize_message(message: IlinkMessage): NormalizedWeixinMessage {
    const user_id = message.from_user_id ?? ''
    if (!user_id) throw new Error('iLink message has no from_user_id')
    const items = message.item_list ?? []
    const text_parts: string[] = []
    const media: NormalizedMedia[] = []
    for (const item of items) this.normalize_item(item, text_parts, media)
    const delivery_id = String(message.message_id ?? message.seq ?? `${user_id}:${message.create_time_ms ?? Date.now()}`)
    return {
      delivery_id,
      user_id,
      ...message.context_token === undefined ? {} : { context_token: message.context_token },
      text: text_parts.join('\n').trim(),
      media,
      received_at: message.create_time_ms ?? Date.now(),
    }
  }

  /** 下载并填充消息中的媒体字节；语音已有文本时不触发下载或 ASR。 */
  async hydrate_media(message: NormalizedWeixinMessage, loader: MediaLoader): Promise<NormalizedWeixinMessage> {
    for (const media of message.media) {
      if (media.data || !media.media || (media.kind === 'voice' && media.source_text !== 'voice_media_requires_asr')) continue
      // 声明大小超限的直接不下载，改成一条说明性文本。
      const declared = (media.media as { rawsize?: number; filesize?: number }).rawsize
        ?? (media.media as { filesize?: number }).filesize
      if (typeof declared === 'number' && declared > MAX_MEDIA_BYTES) {
        media.source_text = `媒体过大已跳过（${Math.round(declared / 1024 / 1024)}MB > 上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB）`
        continue
      }
      media.data = await loader(media.media)
      if (media.data.length > MAX_MEDIA_BYTES) {
        delete media.data
        media.source_text = `媒体过大已跳过（>${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB）`
        continue
      }
      if (media.kind === 'voice') {
        media.raw_data = media.data
        const { transcode_silk_to_wav } = await import('../media/mediaTranscoder.ts')
        const converted = await transcode_silk_to_wav(media.data)
        media.data = converted.data
        media.mime_type = converted.mime_type
        media.transcoded = converted.transcoded
      }
      if (media.kind === 'image' && media.mime_type === undefined) media.mime_type = 'image/jpeg'
    }
    return message
  }

  /** 解析一个消息项，保证 voice_item.text 优先于语音媒体。 */
  private normalize_item(item: IlinkMessageItem, text_parts: string[], media: NormalizedMedia[]): void {
    if (item.type === 1 && item.text_item?.text !== undefined) text_parts.push(item.text_item.text)
    if (item.type === 2 && item.image_item) media.push({ kind: 'image', mime_type: 'image/jpeg', name: 'weixin-image.jpg', media: { ...item.image_item.media, ...item.image_item.aeskey === undefined ? {} : { aes_key: Buffer.from(item.image_item.aeskey, 'hex').toString('base64') } } })
    if (item.type === 3 && item.voice_item) {
      if (item.voice_item.text) text_parts.push(item.voice_item.text)
      else media.push({ kind: 'voice', mime_type: 'audio/silk', source_text: 'voice_media_requires_asr', ...item.voice_item.media === undefined ? {} : { media: item.voice_item.media } })
    }
    if (item.type === 4 && item.file_item) media.push({ kind: 'file', ...item.file_item.file_name === undefined ? {} : { name: item.file_item.file_name }, mime_type: 'application/octet-stream', ...item.file_item.media === undefined ? {} : { media: item.file_item.media } })
  }
}
