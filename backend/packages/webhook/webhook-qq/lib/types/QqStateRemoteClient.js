function normalize_row(row) {
    return {
        ...row,
        ...typeof row.msg_id === 'string' ? {
            msgId: row.msg_id
        } : {},
        ...Array.isArray(row.sent_parts) ? {
            sent_parts: row.sent_parts
        } : {
            sent_parts: []
        }
    };
}
export class QqStateRemoteClient {
    base_url;
    api_key;
    timeout_ms;
    constructor(options = {}){
        this.base_url = (options.base_url ?? process.env.SYNLOVE_QQSTATE_BASE_URL ?? 'http://127.0.0.1:8799/v1').replace(/\/+$/, '');
        this.api_key = options.api_key ?? process.env.SYNLOVE_QQSTATE_API_KEY ?? '';
        this.timeout_ms = Math.max(1_000, Math.min(120_000, options.timeout_ms ?? 30_000));
    }
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
                    requestId: `qqstate-${crypto.randomUUID()}`,
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
            if (!response.ok) throw new Error(`qqstate 服务 HTTP ${response.status}`);
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
            if (operation.state !== 'done') throw new Error(`qqstate 服务任务状态 ${String(operation.state)}`);
            const outer = operation.result ?? {};
            const rpc = outer.result ?? outer;
            if (rpc.isError === true) throw new Error(String(rpc.content ?? 'qqstate 服务调用失败'));
            return rpc.structuredContent ?? {};
        } finally{
            clearTimeout(timer);
        }
    }
    async enqueue(reply) {
        return normalize_row((await this.call('qq_enqueue', {
            reply
        })).outbox);
    }
    async list_pending(limit = 1024) {
        const rows = (await this.call('qq_list_pending', {
            limit
        })).outbox;
        return Array.isArray(rows) ? rows.map((row)=>normalize_row(row)) : [];
    }
    async mark_part_sent(id, index) {
        await this.call('qq_mark_part_sent', {
            id,
            index
        });
    }
    async mark_sent(id) {
        await this.call('qq_mark_sent', {
            id
        });
    }
    async mark_failed(id, error, next_at, terminal) {
        await this.call('qq_mark_failed', {
            id,
            error,
            nextAt: next_at,
            terminal
        });
    }
    async acquire_lease(input) {
        return (await this.call('qq_acquire_lease', input)).acquired === true;
    }
    async heartbeat_lease(owner_id) {
        return (await this.call('qq_heartbeat_lease', {
            ownerId: owner_id
        })).updated === true;
    }
    async release_lease(owner_id) {
        await this.call('qq_release_lease', {
            ownerId: owner_id
        });
    }
}
