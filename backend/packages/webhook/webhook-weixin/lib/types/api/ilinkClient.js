import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
import { decrypt_aes_ecb, parse_aes_key } from '../media/mediaCrypto.js';
const ILINK_APP_ID = process.env.WEIXIN_ILINK_APP_ID?.trim() || 'bot';
const ILINK_APP_CLIENT_VERSION = process.env.WEIXIN_ILINK_APP_VERSION?.trim() || '132105';
function token_marker_path() {
    return process.env.DSH_WEIXIN_TOKEN_MARKER ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'weixin-token-invalid.flag');
}
function mark_token_invalid(reason) {
    const path = token_marker_path();
    void import('node:fs/promises').then(async (fs)=>{
        const stat = await fs.stat(path).catch(()=>undefined);
        if (stat !== undefined && Date.now() - stat.mtimeMs < 60_000) return;
        await fs.appendFile(path, `${new Date().toISOString()} ${reason}\n`, 'utf8');
    }).catch(()=>undefined);
}
function clear_token_invalid() {
    void import('node:fs/promises').then((fs)=>fs.unlink(token_marker_path())).catch(()=>undefined);
}
export class IlinkClient {
    options;
    fetch_impl;
    wechat_uin;
    constructor(options){
        if (!options.base_url || !options.token) throw new Error('iLink base_url and token are required');
        this.options = {
            ...options,
            base_url: options.base_url.replace(/\/$/, ''),
            token: options.token,
            timeout_ms: options.timeout_ms ?? 15_000,
            long_poll_timeout_ms: options.long_poll_timeout_ms ?? 35_000
        };
        this.fetch_impl = options.fetch_impl ?? fetch;
        this.wechat_uin = options.random_uin ?? Buffer.from(randomBytes(4)).toString('base64');
    }
    async get_updates(cursor, signal) {
        return this.post_json('ilink/bot/getupdates', {
            get_updates_buf: cursor,
            base_info: this.base_info()
        }, this.options.long_poll_timeout_ms, signal);
    }
    async send_message(input, signal) {
        const response = await this.post_json('ilink/bot/sendmessage', {
            msg: {
                from_user_id: '',
                to_user_id: input.to_user_id,
                client_id: input.client_id ?? `dsh-${Date.now()}`,
                ...input.context_token === undefined ? {} : {
                    context_token: input.context_token
                },
                message_type: 2,
                message_state: 2,
                item_list: input.item_list ?? (input.text ? [
                    {
                        type: 1,
                        text_item: {
                            text: input.text
                        }
                    }
                ] : []),
                ...input.run_id === undefined ? {} : {
                    run_id: input.run_id
                }
            },
            base_info: this.base_info()
        }, this.options.timeout_ms, signal);
        if (response.ret !== undefined && response.ret !== 0) {
            const rate_limited = response.ret === -2;
            const effective_items = (input.item_list ?? (input.text ? [
                1
            ] : [])).length;
            if (response.errcode === -14) mark_token_invalid(response.errmsg ?? 'session timeout');
            const shown = input.context_token === undefined ? 'none' : `${input.context_token.slice(0, 12)}…${input.context_token.slice(-8)}`;
            if (rate_limited) {
                probe('outbound', 'send.rejected', {
                    ret: response.ret,
                    errmsg: response.errmsg,
                    app_id: ILINK_APP_ID,
                    app_client_version: ILINK_APP_CLIENT_VERSION,
                    has_context_token: input.context_token !== undefined,
                    context_token_hash: input.context_token === undefined ? undefined : createHash('sha256').update(input.context_token).digest('hex').slice(0, 12),
                    token_hash: createHash('sha256').update(this.options.token).digest('hex').slice(0, 12),
                    items: effective_items,
                    text_len: (input.text ?? '').length
                });
            }
            const error = new Error(`iLink sendMessage failed: ${response.errmsg ?? response.ret} (ret=${response.ret}, errcode=${response.errcode ?? '-'}, items=${effective_items}, len=${(input.text ?? '').length}, token=${shown})`);
            error.retryable = rate_limited || response.ret >= 500 || response.ret === 429;
            error.rate_limited = rate_limited;
            throw error;
        }
        clear_token_invalid();
    }
    async send_message_with_retry(input, signal) {
        const attempts = Math.max(1, (this.options.send_retry_count ?? 2) + 1);
        const client_id = input.client_id ?? `dsh-${Date.now()}-${randomBytes(6).toString('hex')}`;
        for(let attempt = 0; attempt < attempts; attempt += 1){
            try {
                await this.send_message({
                    ...input,
                    client_id
                }, signal);
                return;
            } catch (error) {
                const rate_limited = error?.rate_limited === true;
                const retryable = !rate_limited && !(error && typeof error === 'object' && 'retryable' in error && error.retryable === false);
                if (!retryable || signal?.aborted || error instanceof Error && error.name === 'AbortError' || attempt === attempts - 1) throw error;
                const delay = Math.max(0, this.options.send_retry_delay_ms ?? 250) * 2 ** attempt;
                await new Promise((resolve, reject)=>{
                    const timer = setTimeout(resolve, delay);
                    const on_abort = ()=>{
                        clearTimeout(timer);
                        reject(signal?.reason ?? new Error('aborted'));
                    };
                    signal?.addEventListener('abort', on_abort, {
                        once: true
                    });
                });
            }
        }
    }
    async notify_start(signal) {
        await this.post_json('ilink/bot/msg/notifystart', {
            base_info: this.base_info()
        }, this.options.timeout_ms, signal);
    }
    async notify_stop(signal) {
        await this.post_json('ilink/bot/msg/notifystop', {
            base_info: this.base_info()
        }, this.options.timeout_ms, signal);
    }
    async download_media(media, signal) {
        const url = media.full_url ?? (media.encrypt_query_param && this.options.cdn_base_url ? `${this.options.cdn_base_url.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : undefined);
        if (!url) throw new Error('iLink media full_url or cdn_base_url/encrypt_query_param is required');
        const response = await this.fetch_impl(url, signal === undefined ? {} : {
            signal
        });
        if (!response.ok) throw new Error(`iLink media download failed: ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        return media.aes_key ? decrypt_aes_ecb(bytes, parse_aes_key(media.aes_key)) : bytes;
    }
    async get_upload_url(input, signal) {
        return this.post_json('ilink/bot/getuploadurl', {
            ...input,
            base_info: this.base_info()
        }, this.options.timeout_ms, signal);
    }
    async upload_media(input, signal) {
        const raw = Buffer.from(input.data);
        const key = randomBytes(16);
        const filekey = randomBytes(16).toString('hex');
        const encrypted = this.encrypt_aes_ecb(raw, key);
        const request = {
            filekey,
            media_type: input.media_type,
            to_user_id: input.to_user_id,
            rawsize: raw.length,
            rawfilemd5: createHash('md5').update(raw).digest('hex'),
            filesize: encrypted.length,
            no_need_thumb: true,
            aeskey: key.toString('hex')
        };
        const result = await this.get_upload_url(request, signal);
        const upload_url = result.upload_full_url ?? (result.upload_param && this.options.cdn_base_url ? `${this.options.cdn_base_url.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param)}&filekey=${encodeURIComponent(filekey)}` : undefined);
        if (!upload_url) throw new Error('iLink getuploadurl returned no upload URL');
        const uploaded = await this.fetch_impl(upload_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body: new Uint8Array(encrypted),
            ...signal === undefined ? {} : {
                signal
            }
        });
        if (!uploaded.ok) throw new Error(`iLink CDN upload failed: ${uploaded.status}`);
        const encrypted_query_param = uploaded.headers.get('x-encrypted-param');
        if (!encrypted_query_param) throw new Error('iLink CDN upload missing x-encrypted-param');
        return {
            filekey,
            encrypted_query_param,
            aes_key: key.toString('base64'),
            rawsize: raw.length,
            filesize: encrypted.length
        };
    }
    async send_image(input, signal) {
        const uploaded = await this.upload_media({
            data: input.data,
            to_user_id: input.to_user_id,
            media_type: 1
        }, signal);
        const item_list = [];
        if (input.caption) item_list.push({
            type: 1,
            text_item: {
                text: input.caption
            }
        });
        item_list.push({
            type: 2,
            image_item: {
                media: {
                    encrypt_query_param: uploaded.encrypted_query_param,
                    aes_key: uploaded.aes_key,
                    encrypt_type: 1
                },
                mid_size: uploaded.filesize
            }
        });
        await this.send_message({
            to_user_id: input.to_user_id,
            text: '',
            ...input.context_token === undefined ? {} : {
                context_token: input.context_token
            },
            item_list
        }, signal);
    }
    base_info() {
        return {
            channel_version: this.options.channel_version ?? 'dsh-webhook-weixin',
            bot_agent: this.options.bot_agent ?? 'DeepSeekHarness'
        };
    }
    async post_json(endpoint, body, timeout_ms, signal) {
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), timeout_ms);
        const on_abort = ()=>controller.abort(signal?.reason);
        signal?.addEventListener('abort', on_abort, {
            once: true
        });
        try {
            const response = await this.fetch_impl(`${this.options.base_url}/${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.options.token}`,
                    AuthorizationType: 'ilink_bot_token',
                    'X-WECHAT-UIN': this.wechat_uin,
                    'iLink-App-Id': ILINK_APP_ID,
                    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const text = await response.text();
            if (!response.ok) throw new Error(`iLink ${endpoint} failed: HTTP ${response.status}`);
            return JSON.parse(text);
        } finally{
            clearTimeout(timer);
            signal?.removeEventListener('abort', on_abort);
        }
    }
    encrypt_aes_ecb(data, key) {
        const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null);
        return Buffer.concat([
            cipher.update(Buffer.from(data)),
            cipher.final()
        ]);
    }
}
