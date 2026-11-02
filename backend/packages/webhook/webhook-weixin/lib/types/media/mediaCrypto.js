import { createDecipheriv } from 'node:crypto';
export function parse_aes_key(value) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 16) return decoded;
    const text = decoded.toString('ascii');
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex');
    throw new Error(`invalid iLink AES key length: ${decoded.length}`);
}
export function decrypt_aes_ecb(data, key) {
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null);
    decipher.setAutoPadding(true);
    return Buffer.concat([
        decipher.update(Buffer.from(data)),
        decipher.final()
    ]);
}
