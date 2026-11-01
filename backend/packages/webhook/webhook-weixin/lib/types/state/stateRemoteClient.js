/** 微信状态远程客户端。 */
export class StateRemoteClient {
    base_url;
    api_key;
    timeout_ms;
    /** 读取配置并创建远程状态客户端。 */
    constructor(options = {}) {
        this.base_url = (options.base_url ?? process.env.SYNLOVE_STATE_BASE_URL
            ?? 'http://127.0.0.1:8798/v1').replace(/\/+$/, '');
        this.api_key = options.api_key ?? process.env.SYNLOVE_STATE_API_KEY ?? '';
        this.timeout_ms = Math.max(1_000, Math.min(120_000, options.timeout_ms ?? 30_000));
    }
    /** 关闭远程客户端；HTTP 无持久连接，方法保持与本地状态库对称。 */
    close() { }
    /** 调用远程工具并返回结构化结果。 */
    async call(name, arguments_ = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout_ms);
        try {
            const response = await fetch(`${this.base_url}/rpc`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` }),
                },
                body: JSON.stringify({
                    requestId: `state-${crypto.randomUUID()}`,
                    message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } },
                }),
                signal: controller.signal,
            });
            if (!response.ok)
                throw new Error(`state 服务 HTTP ${response.status}`);
            let operation = await response.json();
            while (operation.state === 'running') {
                await new Promise(resolve => setTimeout(resolve, 100));
                const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(String(operation.requestId ?? ''))}`, {
                    headers: this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` },
                    signal: controller.signal,
                });
                operation = await status.json();
            }
            if (operation.state !== 'done')
                throw new Error(`state 服务任务状态 ${String(operation.state)}`);
            const outer = operation.result ?? {};
            const rpc = outer.result ?? outer;
            if (rpc.isError === true)
                throw new Error(String(rpc.content ?? 'state 服务调用失败'));
            return rpc.structuredContent ?? {};
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** 读取游标。 */
    async get_cursor() { return String((await this.call('state_get_cursor')).cursor ?? ''); }
    /** 写入游标。 */
    async set_cursor(cursor) { await this.call('state_set_cursor', { cursor }); }
    /** 读取用户会话路由。 */
    async get_session_id(user_id) {
        const value = (await this.call('state_get_session', { userId: user_id })).sessionId;
        return typeof value === 'string' ? value : undefined;
    }
    /** 写入用户会话路由。 */
    async set_session_id(user_id, session_id) {
        await this.call('state_set_session', { userId: user_id, sessionId: session_id });
    }
    /** 读取元数据。 */
    async get_meta(key) {
        const value = (await this.call('state_get_meta', { key })).value;
        return typeof value === 'string' ? value : undefined;
    }
    /** 写入元数据。 */
    async set_meta(key, value) {
        await this.call('state_set_meta', { key, value });
    }
    /** 按前缀读取元数据。 */
    async list_meta_prefix(prefix) {
        const items = (await this.call('state_list_meta_prefix', { prefix })).items;
        return Array.isArray(items) ? items : [];
    }
    /** 删除元数据。 */
    async delete_meta(key) {
        await this.call('state_delete_meta', { key });
    }
    /** 生成用户当前会话 ID。 */
    async session_id_for(user_id) {
        return String((await this.call('state_session_id_for', { userId: user_id })).sessionId ?? `weixin-${user_id}`);
    }
    /** 读取上下文代次。 */
    async context_epoch(user_id) {
        return Number((await this.call('state_context_epoch', { userId: user_id })).epoch ?? 0);
    }
    /** 递增上下文代次。 */
    async bump_context_epoch(user_id) {
        return Number((await this.call('state_bump_context_epoch', { userId: user_id })).epoch ?? 0);
    }
    /** 清除用户路由。 */
    async clear_session_id(user_id) {
        await this.call('state_clear_session', { userId: user_id });
    }
    /** 列出已有路由的用户。 */
    async list_users() {
        const users = (await this.call('state_list_users')).users;
        return Array.isArray(users) ? users.filter((item) => typeof item === 'string') : [];
    }
    /** 清空未完成出站队列。 */
    async clear_queue() {
        return Number((await this.call('state_clear_queue')).removed ?? 0);
    }
    /** 读取状态服务诊断快照。 */
    async snapshot() {
        return this.call('state_snapshot');
    }
    /** 幂等登记入站投递。 */
    async put_delivery_if_absent(record) {
        return (await this.call('state_put_delivery', { record })).first === true;
    }
    /** 读取入站投递。 */
    async get_delivery(delivery_id) {
        return (await this.call('state_get_delivery', { deliveryId: delivery_id })).delivery;
    }
    /** 读取入站投递的上下文令牌。 */
    async delivery_context_token(delivery_id) {
        const value = (await this.call('state_delivery_context_token', { deliveryId: delivery_id })).contextToken;
        return typeof value === 'string' ? value : undefined;
    }
    /** 更新入站投递状态。 */
    async update_delivery(delivery_id, status, patch) {
        return (await this.call('state_update_delivery', { deliveryId: delivery_id, status, patch })).updated === true;
    }
    /** 列出未完成入站投递。 */
    async list_unfinished_deliveries(limit = 200) {
        const rows = (await this.call('state_list_unfinished_deliveries', { limit })).deliveries;
        return Array.isArray(rows) ? rows : [];
    }
    /** 检查一批投递是否可提交游标。 */
    async batch_committable(delivery_ids) {
        return (await this.call('state_batch_committable', { deliveryIds: [...delivery_ids] })).committable === true;
    }
    /** 读取最近入站用户。 */
    async latest_user_id() {
        const value = (await this.call('state_latest_user')).userId;
        return typeof value === 'string' ? value : undefined;
    }
    /** 写入出站队列。 */
    async enqueue_outbox(input) {
        return (await this.call('state_enqueue_outbox', { input })).outbox;
    }
    /** 读取指定会话下一条出站消息。 */
    async next_outbox(session_id, now) {
        return (await this.call('state_next_outbox', { sessionId: session_id, ...(now === undefined ? {} : { now }) })).outbox;
    }
    /** 读取各会话下一条待发送消息。 */
    async next_outbox_per_session(now) {
        const rows = (await this.call('state_next_outbox_per_session', now === undefined ? {} : { now })).outbox;
        return Array.isArray(rows) ? rows : [];
    }
    /** 列出需要恢复的出站消息。 */
    async list_pending_outbox(limit = 500) {
        const rows = (await this.call('state_list_pending_outbox', { limit })).outbox;
        return Array.isArray(rows) ? rows : [];
    }
    /** 读取出站消息。 */
    async get_outbox(outbound_id) {
        return (await this.call('state_get_outbox', { outboundId: outbound_id })).outbox;
    }
    /** 标记出站消息发送中。 */
    async mark_outbox_sending(outbound_id) {
        await this.call('state_mark_outbox_sending', { outboundId: outbound_id });
    }
    /** 标记出站消息已发送。 */
    async mark_outbox_sent(outbound_id) {
        await this.call('state_mark_outbox_sent', { outboundId: outbound_id });
    }
    /** 标记出站消息失败。 */
    async mark_outbox_failed(outbound_id, status, error, next_retry_at) {
        await this.call('state_mark_outbox_failed', {
            outboundId: outbound_id, status, error, ...(next_retry_at === undefined ? {} : { nextRetryAt: next_retry_at }),
        });
    }
    /** 记录出站消息分段。 */
    async mark_outbox_part_sent(outbound_id, index) {
        await this.call('state_mark_outbox_part_sent', { outboundId: outbound_id, index });
    }
    /** 读取停放通知。 */
    async parked_results(limit = 20) {
        const rows = (await this.call('state_parked_results', { limit })).results;
        return Array.isArray(rows) ? rows : [];
    }
    /** 清理过期停放通知。 */
    async prune_parked_results(max_age_ms, now) {
        const result = await this.call('state_prune_parked_results', { maxAgeMs: max_age_ms, ...(now === undefined ? {} : { now }) });
        return Number(result.removed ?? 0);
    }
    /** 限制待发通知数量。 */
    async trim_pending_notices(session_id, keep = 3) {
        const result = await this.call('state_trim_pending_notices', { sessionId: session_id, keep });
        return Number(result.removed ?? 0);
    }
    /** 记录轮次上下文。 */
    async bind_turn_context(input) {
        await this.call('state_bind_turn_context', { input });
    }
    /** 读取轮次上下文。 */
    async get_turn_context(session_id, turn) {
        return (await this.call('state_get_turn_context', { sessionId: session_id, turn })).context;
    }
    /** 读取会话最近一条已处理入站消息。 */
    async latest_delivery_for_session(session_id) {
        return (await this.call('state_latest_delivery_for_session', { sessionId: session_id })).delivery;
    }
    /** 清理旧轮次上下文。 */
    async prune_turn_context(session_id, keep = 20) {
        await this.call('state_prune_turn_context', { sessionId: session_id, keep });
    }
    /** 读取当前消费者租约。 */
    async get_lease() { return (await this.call('state_get_lease')).lease; }
    /** 原子获取消费者租约。 */
    async try_acquire_lease(input) {
        return (await this.call('state_try_acquire_lease', { input })).acquired === true;
    }
    /** 续租。 */
    async heartbeat_lease(owner_id) {
        return (await this.call('state_heartbeat_lease', { ownerId: owner_id })).updated === true;
    }
    /** 释放租约。 */
    async release_lease(owner_id) { await this.call('state_release_lease', { ownerId: owner_id }); }
}
//# sourceMappingURL=stateRemoteClient.js.map