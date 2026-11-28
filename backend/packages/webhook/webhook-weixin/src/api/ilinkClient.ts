/** 微信 iLink HTTP 客户端：封装长轮询、发消息、上传地址、启动停止通知和 CDN 媒体下载。 */

import { createHash, randomBytes, createCipheriv } from 'node:crypto'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'
import { decrypt_aes_ecb, parse_aes_key } from '../media/mediaCrypto.ts'

/**
 * iLink 客户端身份头。
 *
 * 官方插件（@tencent-weixin/openclaw-weixin）在每个请求上都会带：
 *   iLink-App-Id: <package.json 的 ilink_appid>   → "bot"
 *   iLink-App-ClientVersion: uint32 = (major<<16)|(minor<<8)|patch
 * 缺少这两个头发送会被服务端判为 `prepare failed`（ret=-2），
 * 而接收（getUpdates/notifystart）却是正常的，极易误判成 token 失效。
 */
const ILINK_APP_ID = process.env.WEIXIN_ILINK_APP_ID?.trim() || 'bot'
const ILINK_APP_CLIENT_VERSION = process.env.WEIXIN_ILINK_APP_VERSION?.trim() || '132105'

/** 失效标记文件路径。 */
function token_marker_path(): string {
  return process.env.DSH_WEIXIN_TOKEN_MARKER
    ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'weixin-token-invalid.flag')
}

/**
 * 记录"凭据失效"信号，供启动器/运维发现。
 *
 * 发送返回 ret=-2（prepare failed）实测等价于 bot token 失效：此时接收和 notifystart 都还正常，
 * 只有发送被拒，非常难排查。写一个标记文件让上游能主动提示扫码。
 */
function mark_token_invalid(reason: string): void {
  const path = token_marker_path()
  void import('node:fs/promises')
    .then(async fs => {
      // 去重：60 秒内只写一条，避免一次重试风暴刷出几十行（曾因此让启动器误判与日志爆炸）。
      const stat = await fs.stat(path).catch(() => undefined)
      if (stat !== undefined && Date.now() - stat.mtimeMs < 60_000) return
      await fs.appendFile(path, `${new Date().toISOString()} ${reason}\n`, 'utf8')
    })
    .catch(() => undefined)
}

/**
 * 发送成功后清除失效标记。
 *
 * 标记只在"确实发不出去"时有意义；一旦恢复发送就必须清掉，
 * 否则启动器会一直按"凭据失效"处理（反复弹登录器），造成假故障。
 */
function clear_token_invalid(): void {
  void import('node:fs/promises')
    .then(fs => fs.unlink(token_marker_path()))
    .catch(() => undefined)
}
import type {
  IlinkBaseInfo, IlinkClientOptions, IlinkGetUpdatesResponse, IlinkMessage, IlinkMessageItem, IlinkSendMessageInput,
  IlinkUploadRequest, IlinkUploadResponse,
} from './ilinkTypes.ts'

/** 可注入的 iLink 请求客户端，便于本地模拟和协议测试。 */
export class IlinkClient {
  private readonly options: Required<Pick<IlinkClientOptions, 'base_url' | 'token' | 'timeout_ms' | 'long_poll_timeout_ms'>>
    & Omit<IlinkClientOptions, 'base_url' | 'token' | 'timeout_ms' | 'long_poll_timeout_ms'>
  private readonly fetch_impl: typeof fetch
  private readonly wechat_uin: string

  /** 使用协议配置创建客户端；token 只保存在进程内。 */
  constructor(options: IlinkClientOptions) {
    if (!options.base_url || !options.token) throw new Error('iLink base_url and token are required')
    this.options = {
      ...options,
      base_url: options.base_url.replace(/\/$/, ''),
      token: options.token,
      timeout_ms: options.timeout_ms ?? 15_000,
      long_poll_timeout_ms: options.long_poll_timeout_ms ?? 35_000,
    }
    this.fetch_impl = options.fetch_impl ?? fetch
    this.wechat_uin = options.random_uin ?? Buffer.from(randomBytes(4)).toString('base64')
  }

  /** 执行一次 getUpdates 长轮询；外部 signal 可立即取消请求。 */
  async get_updates(cursor: string, signal?: AbortSignal): Promise<IlinkGetUpdatesResponse> {
    return this.post_json<IlinkGetUpdatesResponse>('ilink/bot/getupdates', {
      get_updates_buf: cursor,
      base_info: this.base_info(),
    }, this.options.long_poll_timeout_ms, signal)
  }

  /** 向一个微信用户发送单条文本消息。 */
  async send_message(input: IlinkSendMessageInput, signal?: AbortSignal): Promise<void> {
    // 可选字段必须在“有值”时才出现：JSON.stringify 会把 undefined 变成 null，
    // 而 iLink 对多出来的空字段（context_token/run_id）会直接回 "prepare failed"。
    const response = await this.post_json<{ ret?: number; errmsg?: string; errcode?: number }>('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: input.to_user_id,
        client_id: input.client_id ?? `dsh-${Date.now()}`,
        ...input.context_token === undefined ? {} : { context_token: input.context_token },
        message_type: 2,
        message_state: 2,
        item_list: input.item_list ?? (input.text ? [{ type: 1, text_item: { text: input.text } }] : []),
        ...input.run_id === undefined ? {} : { run_id: input.run_id },
      },
      base_info: this.base_info(),
    }, this.options.timeout_ms, signal)
    if (response.ret !== undefined && response.ret !== 0) {
      // ret=-2（prepare failed）实测是**发送限流**，不是凭据失效：
      // 连续快速发送时前几条成功、之后全是 ret=-2。凭据本身仍可鉴权（notifystart 正常）。
      // 旧实现把它当"token 失效"并写标记 → 触发重新扫码 → 新 bot 作废旧 token →
      // 用户被迫解绑重绑，形成"token 老是过期"的假象。
      // 真正的凭据失效信号是 errcode -14（session timeout）。
      const rate_limited = response.ret === -2
      // 真正发给服务端的 item 数：text 会被折成一个文本 item，
      // 之前统计 input.item_list（调用方通常不传）永远是 0，排查时严重误导。
      const effective_items = (input.item_list ?? (input.text ? [1] : [])).length
      if (response.errcode === -14) mark_token_invalid(response.errmsg ?? 'session timeout')
      // 把 token 前后各 8 字符打出来：便于和"收到的消息 token"比对，确认是不是旧 token。
      const shown = input.context_token === undefined
        ? 'none'
        : `${input.context_token.slice(0, 12)}…${input.context_token.slice(-8)}`
      // 请求指纹：用于区分"限流/形态问题"与"凭据问题"，避免把发送故障升级成登录故障。
      if (rate_limited) {
        probe('outbound', 'send.rejected', {
          ret: response.ret,
          errmsg: response.errmsg,
          app_id: ILINK_APP_ID,
          app_client_version: ILINK_APP_CLIENT_VERSION,
          has_context_token: input.context_token !== undefined,
          context_token_hash: input.context_token === undefined
            ? undefined
            : createHash('sha256').update(input.context_token).digest('hex').slice(0, 12),
          token_hash: createHash('sha256').update(this.options.token).digest('hex').slice(0, 12),
          items: effective_items,
          text_len: (input.text ?? '').length,
        })
      }
      const error = new Error(`iLink sendMessage failed: ${response.errmsg ?? response.ret} (ret=${response.ret}, errcode=${response.errcode ?? '-'}, items=${effective_items}, len=${(input.text ?? '').length}, token=${shown})`) as Error & { retryable?: boolean, rate_limited?: boolean }
      // 限流可重试（退避后即可恢复）；5xx/429 同样可重试。
      error.retryable = rate_limited || response.ret >= 500 || response.ret === 429
      error.rate_limited = rate_limited
      throw error
    }
    // 发送成功即说明凭据可用：清掉可能残留的失效标记。
    clear_token_invalid()
  }

  /** 以稳定 client_id 有限重试发送，避免瞬时网络错误导致回复丢失。 */
  async send_message_with_retry(input: IlinkSendMessageInput, signal?: AbortSignal): Promise<void> {
    const attempts = Math.max(1, (this.options.send_retry_count ?? 2) + 1)
    const client_id = input.client_id ?? `dsh-${Date.now()}-${randomBytes(6).toString('hex')}`
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.send_message({ ...input, client_id }, signal)
        return
      } catch (error: unknown) {
        // 限流不做客户端内重试：连发 3 次（250/500ms）本身就是触发限流的突发形态，
        // 而且退避应由 OutboundCoordinator 整链路统一做（它会把冷却扩散到全局）。
        const rate_limited = (error as { rate_limited?: boolean } | undefined)?.rate_limited === true
        const retryable = !rate_limited
          && !(error && typeof error === 'object' && 'retryable' in error && (error as { retryable?: boolean }).retryable === false)
        if (!retryable || signal?.aborted || (error instanceof Error && error.name === 'AbortError') || attempt === attempts - 1) throw error
        const delay = Math.max(0, this.options.send_retry_delay_ms ?? 250) * 2 ** attempt
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          const on_abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')) }
          signal?.addEventListener('abort', on_abort, { once: true })
        })
      }
    }
  }

  /** 通知微信连接器开始工作。 */
  async notify_start(signal?: AbortSignal): Promise<void> {
    await this.post_json('ilink/bot/msg/notifystart', { base_info: this.base_info() }, this.options.timeout_ms, signal)
  }

  /** 通知微信连接器停止工作。 */
  async notify_stop(signal?: AbortSignal): Promise<void> {
    await this.post_json('ilink/bot/msg/notifystop', { base_info: this.base_info() }, this.options.timeout_ms, signal)
  }

  /** 下载并解密一个媒体引用；无完整 URL 时要求调用方提供 CDN URL。 */
  async download_media(media: { full_url?: string; encrypt_query_param?: string; aes_key?: string }, signal?: AbortSignal): Promise<Buffer> {
    const url = media.full_url ?? (media.encrypt_query_param && this.options.cdn_base_url
      ? `${this.options.cdn_base_url.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : undefined)
    if (!url) throw new Error('iLink media full_url or cdn_base_url/encrypt_query_param is required')
    const response = await this.fetch_impl(url, signal === undefined ? {} : { signal })
    if (!response.ok) throw new Error(`iLink media download failed: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    return media.aes_key ? decrypt_aes_ecb(bytes, parse_aes_key(media.aes_key)) : bytes
  }

  /** 获取微信 CDN 媒体上传地址，参数与官方 getuploadurl 协议一致。 */
  async get_upload_url(input: IlinkUploadRequest, signal?: AbortSignal): Promise<IlinkUploadResponse> {
    return this.post_json<IlinkUploadResponse>('ilink/bot/getuploadurl', {
      ...input,
      base_info: this.base_info(),
    }, this.options.timeout_ms, signal)
  }

  /** 使用官方 AES-ECB 上传链路上传媒体并返回发送所需 CDN 引用。 */
  async upload_media(input: { data: Uint8Array; to_user_id: string; media_type: number }, signal?: AbortSignal): Promise<{ filekey: string; encrypted_query_param: string; aes_key: string; rawsize: number; filesize: number }> {
    const raw = Buffer.from(input.data)
    const key = randomBytes(16)
    const filekey = randomBytes(16).toString('hex')
    const encrypted = this.encrypt_aes_ecb(raw, key)
    const request: IlinkUploadRequest = {
      filekey,
      media_type: input.media_type,
      to_user_id: input.to_user_id,
      rawsize: raw.length,
      rawfilemd5: createHash('md5').update(raw).digest('hex'),
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: key.toString('hex'),
    }
    const result = await this.get_upload_url(request, signal)
    const upload_url = result.upload_full_url ?? (result.upload_param && this.options.cdn_base_url
      ? `${this.options.cdn_base_url.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : undefined)
    if (!upload_url) throw new Error('iLink getuploadurl returned no upload URL')
    const uploaded = await this.fetch_impl(upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(encrypted),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!uploaded.ok) throw new Error(`iLink CDN upload failed: ${uploaded.status}`)
    const encrypted_query_param = uploaded.headers.get('x-encrypted-param')
    if (!encrypted_query_param) throw new Error('iLink CDN upload missing x-encrypted-param')
    return { filekey, encrypted_query_param, aes_key: key.toString('base64'), rawsize: raw.length, filesize: encrypted.length }
  }

  /** 上传并回传一张图片；文本说明会作为独立 item 一并发送。 */
  async send_image(input: { to_user_id: string; data: Uint8Array; context_token?: string; caption?: string }, signal?: AbortSignal): Promise<void> {
    const uploaded = await this.upload_media({ data: input.data, to_user_id: input.to_user_id, media_type: 1 }, signal)
    const item_list: IlinkMessageItem[] = []
    if (input.caption) item_list.push({ type: 1, text_item: { text: input.caption } })
    item_list.push({
      type: 2,
      image_item: {
        media: { encrypt_query_param: uploaded.encrypted_query_param, aes_key: uploaded.aes_key, encrypt_type: 1 },
        mid_size: uploaded.filesize,
      },
    })
    await this.send_message({ to_user_id: input.to_user_id, text: '', ...input.context_token === undefined ? {} : { context_token: input.context_token }, item_list }, signal)
  }

  /** 返回协议所需的脱敏基础信息。 */
  private base_info(): IlinkBaseInfo {
    return { channel_version: this.options.channel_version ?? 'dsh-webhook-weixin', bot_agent: this.options.bot_agent ?? 'DeepSeekHarness' }
  }

  /** 发起带超时、Bearer Token 和 base_info 的 JSON POST。 */
  private async post_json<T>(endpoint: string, body: unknown, timeout_ms: number, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms)
    const on_abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', on_abort, { once: true })
    try {
      const response = await this.fetch_impl(`${this.options.base_url}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.token}`,
          AuthorizationType: 'ilink_bot_token',
          'X-WECHAT-UIN': this.wechat_uin,
          // 官方客户端身份头：缺失会导致 sendMessage 被判 prepare failed。
          'iLink-App-Id': ILINK_APP_ID,
          'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`iLink ${endpoint} failed: HTTP ${response.status}`)
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', on_abort)
    }
  }

  /** 使用 PKCS#7 填充执行 AES-128-ECB 加密。 */
  private encrypt_aes_ecb(data: Uint8Array, key: Uint8Array): Buffer {
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null)
    return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()])
  }
}

export type { IlinkMessage }
