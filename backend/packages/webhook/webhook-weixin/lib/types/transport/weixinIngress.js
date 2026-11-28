import { probe } from '../diagnostics/probe.js';
import { MessageNormalizer } from '../message/messageNormalizer.js';
export class WeixinIngress {
    normalizer = new MessageNormalizer();
    client;
    observer;
    constructor(options){
        this.client = options.client;
        this.observer = options.observer ?? {};
    }
    async notify_start(signal) {
        await this.client.notify_start(signal);
        probe('ingress', 'notify_start.ok');
    }
    async notify_stop(signal) {
        try {
            await this.client.notify_stop(signal);
            probe('ingress', 'notify_stop.ok');
        } catch (error) {
            probe('ingress', 'notify_stop.failed', {
                error: String(error)
            });
        }
    }
    async poll(cursor, signal) {
        let response;
        try {
            response = await this.client.get_updates(cursor, signal);
        } catch (error) {
            if (signal?.aborted) throw error;
            const aborted = error instanceof Error && error.name === 'AbortError';
            if (aborted) {
                probe('ingress', 'poll.long_poll_timeout');
                return {
                    kind: 'session_timeout'
                };
            }
            probe('ingress', 'poll.network_error', {
                error: String(error)
            });
            this.observer.on_error?.(error);
            return {
                kind: 'protocol_error',
                detail: error instanceof Error ? error.message : String(error)
            };
        }
        const errmsg = response.errmsg?.toLowerCase() ?? '';
        if (errmsg.includes('session timeout')) {
            probe('ingress', 'poll.session_timeout');
            return {
                kind: 'session_timeout'
            };
        }
        const ret = response.ret ?? 0;
        const errcode = response.errcode ?? 0;
        if (ret !== 0 || errcode !== 0) {
            const detail = response.errmsg ?? String(ret !== 0 ? ret : errcode);
            if (ret === 401 || ret === 403 || errcode === 401 || errcode === 403 || /token|auth|unauthor|login|expired/i.test(detail)) {
                probe('ingress', 'poll.auth_required', {
                    ret,
                    errcode,
                    detail
                });
                this.observer.on_status?.('auth_required', detail);
                return {
                    kind: 'auth_required',
                    detail
                };
            }
            probe('ingress', 'poll.protocol_error', {
                ret,
                errcode,
                detail
            });
            this.observer.on_error?.(new Error(`iLink getUpdates failed: ${detail}`));
            return {
                kind: 'protocol_error',
                detail
            };
        }
        const raw = response.msgs ?? [];
        const cursor_next = response.get_updates_buf;
        if (raw.length === 0) {
            probe('ingress', 'poll.idle');
            return {
                kind: 'idle',
                cursor: cursor_next
            };
        }
        const messages = raw.map((message)=>this.normalizer.normalize_message(message));
        probe('ingress', 'poll.messages', {
            count: messages.length,
            users: [
                ...new Set(messages.map((m)=>m.user_id))
            ],
            delivery_ids: messages.map((m)=>m.delivery_id)
        });
        return {
            kind: 'messages',
            messages,
            cursor: cursor_next
        };
    }
    async download_media(media) {
        return this.client.download_media(media);
    }
    get media_normalizer() {
        return this.normalizer;
    }
}
