/**
 * 远程 Session 持久化适配器。
 *
 * 负责：把 Harness 原生 SessionPersistence 契约转发到唯一的远程 session
 * 服务端；本类不维护本地副本、不回退本地存储。注册参数为 Context、服务端
 * endpoint、可选 API key 和请求超时，默认超时 30 秒。
 */
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionPersistence, SessionPersistenceNotFoundError, SessionReadOnlyError, } from '@deepseek-ai/dsh-session-persistence';
function errorFor(text) {
    const match = text.match(/session "([^"]+)"/);
    const id = (match?.[1] ?? 'remote');
    if (text.includes('already exists'))
        return new SessionAlreadyExistsError(id);
    if (text.includes('already owned'))
        return new SessionAlreadyOwnedError(id);
    if (text.includes('not found'))
        return new SessionPersistenceNotFoundError(id);
    if (text.includes('read-only'))
        return new SessionReadOnlyError(id, 'mutation');
    return new Error(text);
}
class RemoteSessionHandle {
    owner;
    info;
    id;
    header;
    inheritedEventCount;
    access;
    closed = false;
    constructor(owner, info) {
        this.owner = owner;
        this.info = info;
        this.id = info.sessionId;
        this.header = info.header;
        this.inheritedEventCount = info.inheritedEventCount;
        this.access = info.access;
    }
    /** 读取远程 session 的连续事件切片。 */
    async read(offset = 0, length) {
        this.assertOpen();
        const result = await this.owner.call('session_read', {
            handleId: this.info.handleId, offset, ...(length === undefined ? {} : { length }),
        });
        return {
            eventState: (result?.eventState ?? 'owned'),
            events: (result?.events ?? []),
        };
    }
    /** 向远程唯一写者追加连续事件。 */
    async append(events) {
        this.assertOpen();
        if (this.access !== 'write')
            throw new SessionReadOnlyError(this.id, 'append');
        await this.owner.call('session_append', { handleId: this.info.handleId, events });
    }
    /** 等待远程服务端把当前写入刷到持久介质。 */
    async flush() {
        this.assertOpen();
        if (this.access !== 'write')
            throw new SessionReadOnlyError(this.id, 'flush');
        await this.owner.call('session_flush', { handleId: this.info.handleId });
    }
    /** 释放远程句柄；重复关闭保持幂等。 */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.owner.call('session_close', { handleId: this.info.handleId });
    }
    assertOpen() {
        if (this.closed)
            throw new SessionHandleClosedError(this.id, 'operation');
    }
    /** 为 using 语法提供与 close 相同的异步释放语义。 */
    async [Symbol.asyncDispose]() {
        await this.close();
    }
}
/** 只负责远程 RPC 的无状态传输客户端，供本地 JSONL 插件按模式委托。 */
export class RemoteSessionClient {
    endpoint;
    apiKey;
    timeoutMs;
    constructor(config) {
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.apiKey = config.apiKey;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }
    /** 在远程服务端创建 session 并取得单写者句柄。 */
    async create(header, options = {}) {
        const info = await this.call('session_create', {
            header,
            ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        });
        return new RemoteSessionHandle(this, info);
    }
    /** 打开远程已有 session，读取模式不抢写锁，写入模式由服务端原子裁决。 */
    async open(id, access, _options = {}) {
        const info = await this.call('session_open', { sessionId: id, access });
        return new RemoteSessionHandle(this, info);
    }
    /** 请求服务端刷新所有活动写句柄。 */
    async flush() {
        await this.call('session_flush_all', {});
    }
    /** 读取单个 session 的轻量快照。 */
    async stat(id, _options = {}) {
        const result = await this.call('session_stat', { sessionId: id });
        return (result?.snapshot ?? undefined);
    }
    /** 列出远程服务端当前可见的全部 session 快照。 */
    async list(_options = {}) {
        const result = await this.call('session_list', {});
        return (result?.snapshots ?? []);
    }
    /** 供远程句柄调用的单次 RPC；网络失败直接抛错，禁止回退本地。 */
    async call(name, arguments_) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`${this.endpoint}/rpc`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    message: { method: 'tools/call', params: { name, arguments: arguments_ } },
                }),
                signal: controller.signal,
            });
            const envelope = await response.json();
            if (!response.ok || envelope.result?.isError) {
                throw errorFor(envelope.result?.content?.[0]?.text ?? `remote session HTTP ${response.status}`);
            }
            return envelope.result?.result?.structuredContent;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/** 保留可独立挂载的原生插件，供需要显式远程 profile 的部署使用。 */
export class RemoteSessionPersistence extends SessionPersistence {
    client;
    constructor(ctx, config) {
        super(ctx);
        this.client = new RemoteSessionClient(config);
    }
    /** 创建远程 session。 */
    create(header, options) {
        return this.client.create(header, options);
    }
    /** 打开远程 session。 */
    open(id, access, options) {
        return this.client.open(id, access, options);
    }
    /** 刷新远程所有写入。 */
    flush() { return this.client.flush(); }
    /** 查询远程 session。 */
    stat(id, options) {
        return this.client.stat(id, options);
    }
    /** 列出远程 session。 */
    list(options) {
        return this.client.list(options);
    }
    /** 转发远程 RPC。 */
    call(name, arguments_) {
        return this.client.call(name, arguments_);
    }
}
export default RemoteSessionPersistence;
//# sourceMappingURL=remote.js.map