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
  readonly userOpenid?: string
  /** 群 openid（群聊） */
  readonly groupOpenid?: string
}

/** 发送结果：ok=false 时带可核对的原因。 */
export interface QqSendResult {
  readonly ok: boolean
  /** 实际走的通道：passive=带 msg_id 回复，active=主动推送 */
  readonly mode: 'passive' | 'active'
  /** 官方返回的 msg id（成功时） */
  readonly id?: string
  /** 失败原因（HTTP 状态 / err_code / message） */
  readonly error?: string
}

/** 单条文本上限（官方允许更长，但拆条更好送达；也方便"回想起来"分段）。 */
const CHUNK_CHARS = 1200

/** 把长文本切成若干条（不拆开英文字母/数字太多的情况，简单按长度切）。 */
export function split_text(text: string, limit = CHUNK_CHARS): string[] {
  const value = text.trim()
  if (value === '') return []
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += limit) chunks.push(value.slice(index, index + limit))
  return chunks
}

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
export async function send_qq_text(
  tokenProvider: { get(): Promise<string> },
  target: QqSendTarget,
  text: string,
  msgId?: string,
  baseUrl = 'https://api.bot.qq.com',
  progress?: { sent_parts: readonly number[]; on_sent: (index: number) => void },
): Promise<QqSendResult> {
  const chunks = split_text(text)
  if (chunks.length === 0) return { ok: true, mode: msgId === undefined ? 'active' : 'passive' }
  const scope = target.groupOpenid !== undefined
    ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages`
    : target.userOpenid !== undefined
      ? `/v2/users/${encodeURIComponent(target.userOpenid)}/messages`
      : undefined
  if (scope === undefined) return { ok: false, mode: 'passive', error: '没有发送目标（userOpenid / groupOpenid 都为空）' }

  const mode = msgId === undefined ? 'active' : 'passive'
  let lastId: string | undefined
  for (const [index, chunk] of chunks.entries()) {
    if (progress?.sent_parts.includes(index)) continue
    const body: Record<string, unknown> = { content: chunk, msg_type: 0 }
    if (msgId !== undefined) {
      body.msg_id = msgId
      body.msg_seq = index + 1
    }
    try {
      const token = await tokenProvider.get()
      const response = await fetch(`${baseUrl}${scope}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      const raw = await response.text()
      if (!response.ok) return { ok: false, mode, error: `HTTP ${response.status} ${raw.slice(0, 160)}` }
      progress?.on_sent(index)
      try {
        const parsed = JSON.parse(raw) as { id?: string }
        if (typeof parsed.id === 'string') lastId = parsed.id
      } catch { /* 官方成功时也可能返回非 JSON，忽略 */ }
    } catch (error) {
      return { ok: false, mode, error: String(error).slice(0, 160) }
    }
  }
  return { ok: true, mode, ...lastId === undefined ? {} : { id: lastId } }
}

/**
 * 按扩展名判断 QQ 媒体类型：1=图片 2=视频 3=语音 4=文件。
 *
 * 实测（2026-10-27）：mp3 用 file_type=3 发送后，QQ 客户端**正常显示为语音条**，
 * 不需要额外转 SILK —— 不要优化成先转码，否则反而多一道依赖。
 */
function media_type_of(path: string): number {
  const dot = path.lastIndexOf('.')
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 1
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 2
  if (['silk', 'amr', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 3
  return 4
}

/**
 * 发一个本地文件/图片到 QQ（官方富媒体：先上传拿 file_info，再发 msg_type=7）。
 *
 * 为什么要先上传：QQ 的富媒体消息不带本地路径，必须先调 `/files` 拿到 `file_info`。
 * 被动回复优先（带 msg_id）；失败回退主动消息（不带 msg_id）。
 */
export async function send_qq_media(
  tokenProvider: { get(): Promise<string> },
  target: QqSendTarget,
  filePath: string,
  msgId?: string,
  baseUrl = 'https://api.bot.qq.com',
): Promise<QqSendResult> {
  const scope = target.groupOpenid !== undefined
    ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}`
    : target.userOpenid !== undefined
      ? `/v2/users/${encodeURIComponent(target.userOpenid)}`
      : undefined
  if (scope === undefined) return { ok: false, mode: 'passive', error: '没有发送目标' }

  let data: Buffer
  try {
    const { readFile } = await import('node:fs/promises')
    data = await readFile(filePath)
  } catch (error) {
    return { ok: false, mode: 'passive', error: `读取文件失败：${String(error).slice(0, 120)}` }
  }
  if (data.byteLength > 20 * 1024 * 1024) {
    return { ok: false, mode: 'passive', error: `文件过大（${(data.byteLength / 1024 / 1024).toFixed(1)}MB，上限 20MB）` }
  }

  try {
    const token = await tokenProvider.get()
    const upload = await fetch(`${baseUrl}${scope}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      body: JSON.stringify({
        file_type: media_type_of(filePath),
        file_data: data.toString('base64'),
        srv_send_msg: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const uploadRaw = await upload.text()
    if (!upload.ok) return { ok: false, mode: 'passive', error: `上传失败 HTTP ${upload.status} ${uploadRaw.slice(0, 160)}` }
    const info = JSON.parse(uploadRaw) as { file_info?: string, ttl?: number }
    if (typeof info.file_info !== 'string' || info.file_info === '') {
      return { ok: false, mode: 'passive', error: `上传未返回 file_info：${uploadRaw.slice(0, 160)}` }
    }

    const send_once = async (passive: boolean): Promise<QqSendResult> => {
      const body: Record<string, unknown> = { content: ' ', msg_type: 7, media: { file_info: info.file_info } }
      if (passive && msgId !== undefined) {
        body.msg_id = msgId
        body.msg_seq = 1
      }
      const response = await fetch(`${baseUrl}${scope}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const raw = await response.text()
      const mode = passive && msgId !== undefined ? 'passive' : 'active'
      if (!response.ok) return { ok: false, mode, error: `HTTP ${response.status} ${raw.slice(0, 160)}` }
      try {
        const parsed = JSON.parse(raw) as { id?: string }
        return { ok: true, mode, ...parsed.id === undefined ? {} : { id: parsed.id } }
      } catch {
        return { ok: true, mode }
      }
    }

    const first = await send_once(true)
    if (first.ok) return first
    console.error(`[webhook-qq] 媒体被动发送失败，改主动重试：${first.error ?? ''}`)
    return await send_once(false)
  } catch (error) {
    return { ok: false, mode: 'passive', error: String(error).slice(0, 160) }
  }
}
