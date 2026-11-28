/** 微信媒体加密层：负责 AES-128-ECB 解密和 AES key 编码解析，不负责消息路由。 */
/** 解析 iLink 的 base64 原始 key 或 base64(hex) key。 */
export declare function parse_aes_key(value: string): Buffer;
/** 使用 AES-128-ECB 解密微信 CDN 返回的媒体字节。 */
export declare function decrypt_aes_ecb(data: Uint8Array, key: Uint8Array): Buffer;
//# sourceMappingURL=mediaCrypto.d.ts.map