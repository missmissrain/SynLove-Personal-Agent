/** 微信媒体加密层：负责 AES-128-ECB 解密和 AES key 编码解析，不负责消息路由。 */

import { createDecipheriv } from 'node:crypto'

/** 解析 iLink 的 base64 原始 key 或 base64(hex) key。 */
export function parse_aes_key(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 16) return decoded
  const text = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex')
  throw new Error(`invalid iLink AES key length: ${decoded.length}`)
}

/** 使用 AES-128-ECB 解密微信 CDN 返回的媒体字节。 */
export function decrypt_aes_ecb(data: Uint8Array, key: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()])
}
