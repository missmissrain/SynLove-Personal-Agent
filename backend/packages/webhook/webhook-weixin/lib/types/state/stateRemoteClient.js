export class StateRemoteClient {
    base_url;
    api_key;
    timeout_ms;
    constructor(options = {}){
        this.base_url = (options.base_url ?? process.env.SYNLOVE_STATE_BASE_URL ?? 'http://127.0.0.1:8798/v1').replace(/\/+$/, '');
        this.api_key = options.api_key ?? process.env.SYNLOVE_STATE_API_KEY ?? '';
        this.timeout_ms = Math.max(1_000, Math.min(120_000, options.timeout_ms ?? 30_000));
    }
    close() {}
    async call(name, arguments_ = {}) {
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), this.timeout_ms);
        try {
            const response = await fetch(`${this.base_url}/rpc`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.api_key === '' ? {} : {
                        Authorization: `Bearer ${this.api_key}`
                    }
                },
                body: JSON.stringify({
                    requestId: `state-${crypto.randomUUID()}`,
                    message: {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/call',
                        params: {
                            name,
                            arguments: arguments_
                        }
                    }
                }),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`state 服务 HTTP ${response.status}`);
            let operation = await response.json();
            while(operation.state === 'running'){
                await new Promise((resolve)=>setTimeout(resolve, 100));
                const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(String(operation.requestId ?? ''))}`, {
                    headers: this.api_key === '' ? {} : {
                        Authorization: `Bearer ${this.api_key}`
                    },
                    signal: controller.signal
                });
                operation = await status.json();
            }
            if (operation.state !== 'done') throw new Error(`state 服务任务状态 ${String(operation.state)}`);
            const outer = operation.result ?? {};
            const rpc = outer.result ?? outer;
            if (rpc.isError === true) throw new Error(String(rpc.content ?? 'state 服务调用失败'));
            return rpc.structuredContent ?? {};
        } finally{
            clearTimeout(timer);
        }
    }
    async get_cursor() {
        return String((await this.call('state_get_cursor')).cursor ?? '');
    }
    async set_cursor(cursor) {
        await this.call('state_set_cursor', {
            cursor
        });
    }
    async get_session_id(user_id) {
        const value = (await this.call('state_get_session', {
            userId: user_id
        })).sessionId;
        return typeof value === 'string' ? value : undefined;
    }
    async set_session_id(user_id, session_id) {
        await this.call('state_set_session', {
            userId: user_id,
            sessionId: session_id
        });
    }
    async get_meta(key) {
        const value = (await this.call('state_get_meta', {
            key
        })).value;
        return typeof value === 'string' ? value : undefined;
    }
    async set_meta(key, value) {
        await this.call('state_set_meta', {
            key,
            value
        });
    }
    async list_meta_prefix(prefix) {
        const items = (await this.call('state_list_meta_prefix', {
            prefix
        })).items;
        return Array.isArray(items) ? items : [];
    }
    async delete_meta(key) {
        await this.call('state_delete_meta', {
            key
        });
    }
    async session_id_for(user_id) {
        return String((await this.call('state_session_id_for', {
            userId: user_id
        })).sessionId ?? `weixin-${user_id}`);
    }
    async context_epoch(user_id) {
        return Number((await this.call('state_context_epoch', {
            userId: user_id
        })).epoch ?? 0);
    }
    async bump_context_epoch(user_id) {
        return Number((await this.call('state_bump_context_epoch', {
            userId: user_id
        })).epoch ?? 0);
    }
    async clear_session_id(user_id) {
        await this.call('state_clear_session', {
            userId: user_id
        });
    }
    async list_users() {
        const users = (await this.call('state_list_users')).users;
        return Array.isArray(users) ? users.filter((item)=>typeof item === 'string') : [];
    }
    async clear_queue() {
        return Number((await this.call('state_clear_queue')).removed ?? 0);
    }
    async snapshot() {
        return this.call('state_snapshot');
    }
    async put_delivery_if_absent(record) {
        return (await this.call('state_put_delivery', {
            record
        })).first === true;
    }
    async get_delivery(delivery_id) {
        return (await this.call('state_get_delivery', {
            deliveryId: delivery_id
        })).delivery;
    }
    async delivery_context_token(delivery_id) {
        const value = (await this.call('state_delivery_context_token', {
            deliveryId: delivery_id
        })).contextToken;
        return typeof value === 'string' ? value : undefined;
    }
    async update_delivery(delivery_id, status, patch) {
        return (await this.call('state_update_delivery', {
            deliveryId: delivery_id,
            status,
            patch
        })).updated === true;
    }
    async list_unfinished_deliveries(limit = 200) {
        const rows = (await this.call('state_list_unfinished_deliveries', {
            limit
        })).deliveries;
        return Array.isArray(rows) ? rows : [];
    }
    async batch_committable(delivery_ids) {
        return (await this.call('state_batch_committable', {
            deliveryIds: [
                ...delivery_ids
            ]
        })).committable === true;
    }
    async latest_user_id() {
        const value = (await this.call('state_latest_user')).userId;
        return typeof value === 'string' ? value : undefined;
    }
    async enqueue_outbox(input) {
        return (await this.call('state_enqueue_outbox', {
            input
        })).outbox;
    }
    async next_outbox(session_id, now) {
        return (await this.call('state_next_outbox', {
            sessionId: session_id,
            ...now === undefined ? {} : {
                now
            }
        })).outbox;
    }
    async next_outbox_per_session(now) {
        const rows = (await this.call('state_next_outbox_per_session', now === undefined ? {} : {
            now
        })).outbox;
        return Array.isArray(rows) ? rows : [];
    }
    async list_pending_outbox(limit = 500) {
        const rows = (await this.call('state_list_pending_outbox', {
            limit
        })).outbox;
        return Array.isArray(rows) ? rows : [];
    }
    async get_outbox(outbound_id) {
        return (await this.call('state_get_outbox', {
            outboundId: outbound_id
        })).outbox;
    }
    async mark_outbox_sending(outbound_id) {
        await this.call('state_mark_outbox_sending', {
            outboundId: outbound_id
        });
    }
    async mark_outbox_sent(outbound_id) {
        await this.call('state_mark_outbox_sent', {
            outboundId: outbound_id
        });
    }
    async mark_outbox_failed(outbound_id, status, error, next_retry_at) {
        await this.call('state_mark_outbox_failed', {
            outboundId: outbound_id,
            status,
            error,
            ...next_retry_at === undefined ? {} : {
                nextRetryAt: next_retry_at
            }
        });
    }
    async mark_outbox_part_sent(outbound_id, index) {
        await this.call('state_mark_outbox_part_sent', {
            outboundId: outbound_id,
            index
        });
    }
    async parked_results(limit = 20) {
        const rows = (await this.call('state_parked_results', {
            limit
        })).results;
        return Array.isArray(rows) ? rows : [];
    }
    async prune_parked_results(max_age_ms, now) {
        const result = await this.call('state_prune_parked_results', {
            maxAgeMs: max_age_ms,
            ...now === undefined ? {} : {
                now
            }
        });
        return Number(result.removed ?? 0);
    }
    async trim_pending_notices(session_id, keep = 3) {
        const result = await this.call('state_trim_pending_notices', {
            sessionId: session_id,
            keep
        });
        return Number(result.removed ?? 0);
    }
    async bind_turn_context(input) {
        await this.call('state_bind_turn_context', {
            input
        });
    }
    async get_turn_context(session_id, turn) {
        return (await this.call('state_get_turn_context', {
            sessionId: session_id,
            turn
        })).context;
    }
    async latest_delivery_for_session(session_id) {
        return (await this.call('state_latest_delivery_for_session', {
            sessionId: session_id
        })).delivery;
    }
    async prune_turn_context(session_id, keep = 20) {
        await this.call('state_prune_turn_context', {
            sessionId: session_id,
            keep
        });
    }
    async get_lease() {
        return (await this.call('state_get_lease')).lease;
    }
    async try_acquire_lease(input) {
        return (await this.call('state_try_acquire_lease', {
            input
        })).acquired === true;
    }
    async heartbeat_lease(owner_id) {
        return (await this.call('state_heartbeat_lease', {
            ownerId: owner_id
        })).updated === true;
    }
    async release_lease(owner_id) {
        await this.call('state_release_lease', {
            ownerId: owner_id
        });
    }
}
