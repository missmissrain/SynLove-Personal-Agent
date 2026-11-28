/**
 * 本地观测记录器：维护非权威的轮次关联，记录模型、工具和轮次的元数据。
 * 注册参数：无需注册；DSH_OBSERVATION_LOG 指定日志，默认使用模型探针同目录的 observations.jsonl。
 * 默认参数从探针目录旁 config/observationConfig.json 读取；未设置任何探针路径时关闭。
 * 不记录提示词、聊天正文、工具参数、密钥；写入失败和队列溢出均不影响业务。
 * @module dsh-llm/observation-recorder
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** 共享进程内的观测副本写入器，不拥有业务会话或消息生命周期。 */
export class ObservationRecorder {
    static roots = new Map();
    static turns = new Map();
    static outbound = new Map();
    static queue = [];
    static pending;
    static remote_queue = [];
    static remote_pending;
    static config = { maxFileBytes: 8_388_608, retainedFiles: 4, maxQueuedEvents: 2048 };
    static configuredPath = '';
    static dropped = 0;
    /**
     * 返回完整 SHA-256，不保存正文。
     * @param value - 需取指纹的数据。
     * @returns 内容指纹。
     */
    static fingerprint(value) {
        return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
    }
    /**
     * 返回当前轮次副本，供探针关联，不参与业务决策。
     * @param session_id - 会话 ID。
     * @returns 当前关联；未观察到轮次时为 undefined。
     */
    static current(session_id) {
        const root = this.roots.get(session_id);
        return root ? { ...root } : undefined;
    }
    /**
     * 只返回本进程实际观察到的关联，不猜测重启前的数据。
     * @param session_id - 会话 ID。
     * @param turn - 已提交的轮次编号。
     * @returns 已观察到的关联副本，或 undefined。
     */
    static turn_context(session_id, turn) {
        const root = this.turns.get(JSON.stringify([session_id, turn]));
        return root ? { ...root } : undefined;
    }
    /**
     * 固定已创建发送记录的关联，避免后续轮次覆盖。
     * @param id - 发送记录 ID。
     * @param session_id - 所属会话。
     * @param turn - 发送记录所属轮次。
     */
    static bind_outbound(id, session_id, turn) {
        const root = this.turn_context(session_id, turn);
        if (!root)
            return;
        if (this.outbound.size >= 4096)
            this.outbound.delete(this.outbound.keys().next().value);
        this.outbound.set(id, { traceId: root.traceId, spanId: root.spanId, sessionId: session_id });
    }
    /**
     * 恢复发送不伪造 trace。
     * @param id - 发送记录 ID。
     * @returns 原入队关联的副本；未知关联为 undefined。
     */
    static outbound_context(id) {
        const root = this.outbound.get(id);
        return root ? { ...root } : undefined;
    }
    /**
     * 删除已释放会话的非权威关联，不改变执行状态。
     * @param session_id - 已释放会话。
     */
    static forget_session(session_id) {
        this.roots.delete(session_id);
        for (const [key] of this.turns)
            if (JSON.parse(key)[0] === session_id)
                this.turns.delete(key);
        for (const [key, item] of this.outbound)
            if (item.sessionId === session_id)
                this.outbound.delete(key);
    }
    /**
     * 只提取轮次、工具名和结果状态。
     * @param session_id - 事件所属会话。
     * @param event - 已提交会话事件的只读投影。
     */
    static observe_event(session_id, event) {
        if (!this.log_path())
            return;
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        if (event.type === 'turn/start') {
            const root = { traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), turn: Number(data.turn) };
            if (this.roots.size >= 4096)
                this.roots.delete(this.roots.keys().next().value);
            this.roots.set(session_id, root);
            if (this.turns.size >= 4096)
                this.turns.delete(this.turns.keys().next().value);
            this.turns.set(JSON.stringify([session_id, root.turn]), root);
            this.emit({ ...root, sessionId: session_id, kind: 'turn', phase: 'start', name: '用户轮次' });
            return;
        }
        const root = this.roots.get(session_id);
        if (!root)
            return;
        const base = { traceId: root.traceId, sessionId: session_id, turn: root.turn };
        if (event.type === 'turn/end') {
            const reason = data.reason;
            const status = reason?.kind === 'completed' ? 'ok' : reason?.kind === 'error' ? 'error' : reason?.kind === 'aborted' ? 'cancelled' : 'incomplete';
            this.emit({ ...base, spanId: root.spanId, kind: 'turn', phase: 'end', status, reason: reason?.kind });
            this.roots.delete(session_id);
        }
        else if (event.type === 'tool/call') {
            this.emit({
                ...base, spanId: this.fingerprint([root.traceId, data.step, data.callId]).slice(0, 16),
                parentSpanId: root.spanId, kind: 'tool', phase: 'start', name: String(data.name ?? 'tool'),
                callId: String(data.callId ?? ''), step: data.step,
            });
        }
        else if (event.type === 'tool/result') {
            const message = data.message;
            this.emit({
                ...base, spanId: this.fingerprint([root.traceId, data.step, message?.callId]).slice(0, 16),
                parentSpanId: root.spanId, kind: 'tool', phase: 'end',
                status: message?.isError ? 'error' : 'ok', step: data.step,
            });
        }
    }
    /**
     * 关闭观测时模型适配器不添加追踪头。
     * @returns 是否配置本地观测输出。
     */
    static enabled() {
        return this.log_path() !== undefined || this.remote_url() !== undefined;
    }
    /**
     * 参数 options：实际模型输入；source：接收观测标识的原始流工厂。
     * 原样转发流，独立记录请求、用量、首字延迟和终态；取消与错误不会算作成功。
     * @param options - 实际模型请求。
     * @param source - 接收观测标识的原始流工厂。
     * @returns 原样转发的异步模型流。
     */
    static async *model_stream(options, source) {
        const root = options.sessionId && !options.purpose ? this.current(String(options.sessionId)) : undefined;
        const observation = {
            traceId: root?.traceId ?? randomBytes(16).toString('hex'),
            spanId: randomBytes(8).toString('hex'),
            parentSpanId: root?.spanId,
            sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
            promptVersion: this.fingerprint([options.system ?? '', options.messages.filter(item => item.role === 'system').map(item => item.content)]),
            toolsVersion: this.fingerprint(options.tools ?? []),
            personaVersion: this.persona_version(options),
            model: options.model,
            provider: options.provider,
            purpose: options.purpose,
        };
        const started = Date.now();
        let first;
        let status = 'incomplete';
        let usage;
        this.emit({ ...observation, kind: 'model', phase: 'start', name: options.model });
        try {
            for await (const chunk of source(observation)) {
                if (first === undefined && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'))
                    first = Date.now() - started;
                if (chunk.type === 'usage')
                    usage = chunk.usage;
                if (chunk.type === 'finish')
                    status = chunk.reason.kind === 'error' ? 'error' : chunk.reason.kind === 'aborted' ? 'cancelled' : chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls' ? 'ok' : 'incomplete';
                yield chunk;
            }
        }
        catch (error) {
            status = options.signal?.aborted ? 'cancelled' : 'error';
            throw error;
        }
        finally {
            this.emit({
                ...observation, kind: 'model', phase: 'end', status,
                durationMs: Date.now() - started, ttftMs: first, usage,
            });
        }
    }
    /**
     * 异步有界写入，满队列丢弃观测，不阻塞业务。
     * @param record - 仅提取允许字段的观测元数据。
     */
    static emit(record) {
        try {
            const path = this.log_path();
            const remote = this.remote_url();
            if (!path && !remote)
                return;
            if (this.queue.length >= this.config.maxQueuedEvents) {
                this.dropped++;
                return;
            }
            const safe = {};
            for (const key of ['traceId', 'spanId', 'parentSpanId', 'sessionId', 'promptVersion', 'toolsVersion', 'personaVersion', 'model', 'provider', 'purpose', 'kind', 'phase', 'name', 'status', 'reason', 'callId', 'turn', 'step', 'durationMs', 'ttftMs', 'deliveryId', 'outboxId', 'outcome']) {
                const value = record[key];
                if (typeof value === 'string')
                    safe[key] = value.slice(0, 300);
                else if (typeof value === 'number' && Number.isFinite(value))
                    safe[key] = value;
            }
            if (record.usage && typeof record.usage === 'object') {
                const usage = record.usage;
                safe.usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'].filter(key => typeof usage[key] === 'number' && Number.isFinite(usage[key])).map(key => [key, usage[key]]));
            }
            const safeRecord = { ...safe, at: new Date().toISOString(), droppedEvents: this.dropped };
            if (remote !== undefined) {
                if (this.remote_queue.length >= this.config.maxQueuedEvents) {
                    this.dropped++;
                    return;
                }
                this.remote_queue.push({ url: remote.url, apiKey: remote.apiKey, record: safeRecord });
                this.start_remote_writer();
                return;
            }
            if (path === undefined)
                return;
            const line = JSON.stringify(safeRecord) + '\n';
            if (Buffer.byteLength(line) > 16_384) {
                this.dropped++;
                return;
            }
            this.queue.push({ path, line });
            this.start_writer();
        }
        catch {
            // 观测序列化或配置错误不能改变业务执行结果。
            this.dropped++;
        }
    }
    /** 参数 options：实际请求；只在独立人格原文确实进入系统消息时记录其稳定版本。 */
    static persona_version(options) {
        const log = this.log_path();
        if (!log)
            return undefined;
        const path = process.env.DSH_PERSONA_FILE ?? join(dirname(log), '..', '..', '提示词', '欣爱人格提示词.md');
        try {
            if (statSync(path).size > 131_072)
                return undefined;
            const persona = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
            if (!persona)
                return undefined;
            const system = [options.system ?? '', ...options.messages.filter(item => item.role === 'system').map(item => typeof item.content === 'string'
                    ? item.content : item.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))].join('\n').replace(/\r\n/g, '\n');
            return system.includes(persona) ? this.fingerprint(persona) : undefined;
        }
        catch {
            // 不匹配或不可读时使用完整系统指纹，不能把编辑中但未生效的人格当作已生效。
            return undefined;
        }
    }
    /**
     * 等待当前诊断队列排空，供测试和受控关闭使用。
     * @returns 排空完成的 Promise；写入失败计入丢弃数。
     */
    static async flush() {
        this.start_writer();
        this.start_remote_writer();
        while (this.pending || this.remote_pending) {
            if (this.pending)
                await this.pending;
            if (this.remote_pending)
                await this.remote_pending;
        }
    }
    /** 无参数；单写者收尾时检查新入队事件，避免微任务切换时遗留最后一条。 */
    static start_writer() {
        if (this.pending || !this.queue.length)
            return;
        this.pending = this.drain().finally(() => {
            this.pending = undefined;
            this.start_writer();
        });
    }
    /** 读取观测远程端点；未配置时保持本地 JSONL 行为。 */
    static remote_url() {
        if ((process.env.SYNLOVE_OBSERVATION_MODE ?? 'local').trim().toLowerCase() !== 'remote')
            return undefined;
        const raw = process.env.SYNLOVE_OBSERVATION_BASE_URL?.trim();
        if (!raw || process.env.DSH_OBSERVATION_ENABLED === '0')
            return undefined;
        return {
            url: `${raw.replace(/\/+$/, '')}/rpc`,
            apiKey: process.env.SYNLOVE_OBSERVATION_API_KEY ?? '',
        };
    }
    /** 启动单写者远程队列，不阻塞模型调用。 */
    static start_remote_writer() {
        if (this.remote_pending || !this.remote_queue.length)
            return;
        this.remote_pending = this.drain_remote().finally(() => {
            this.remote_pending = undefined;
            this.start_remote_writer();
        });
    }
    /** 顺序提交远程观测；网络失败只累计丢弃，不影响模型主流程。 */
    static async drain_remote() {
        while (this.remote_queue.length) {
            const item = this.remote_queue.shift();
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5_000);
                try {
                    const response = await fetch(item.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(item.apiKey === '' ? {} : { Authorization: `Bearer ${item.apiKey}` }),
                        },
                        body: JSON.stringify({
                            requestId: `observation-${randomBytes(8).toString('hex')}`,
                            message: {
                                jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name: 'observation_append', arguments: { record: item.record } },
                            },
                        }),
                        signal: controller.signal,
                    });
                    if (!response.ok)
                        throw new Error(`observation 服务 HTTP ${response.status}`);
                    let body = await response.json();
                    while (body.state === 'running') {
                        await new Promise(resolve => setTimeout(resolve, 50));
                        const poll = await fetch(`${item.url.replace(/\/rpc$/, '')}/operations/${encodeURIComponent(String(body.requestId ?? ''))}`, {
                            headers: item.apiKey === '' ? {} : { Authorization: `Bearer ${item.apiKey}` },
                            signal: controller.signal,
                        });
                        if (!poll.ok)
                            throw new Error(`observation 任务 HTTP ${poll.status}`);
                        body = await poll.json();
                    }
                    if (body.state !== undefined && body.state !== 'done')
                        throw new Error(`observation 任务状态 ${String(body.state)}`);
                }
                finally {
                    clearTimeout(timer);
                }
            }
            catch {
                this.dropped++;
            }
        }
    }
    /** 无参数；解析日志位置与有界轮转配置，配置损坏时沿用安全默认值。 */
    static log_path() {
        const probe = process.env.DSH_LLM_PROBE_LOG ?? process.env.DSH_WEIXIN_PROBE_LOG;
        const path = process.env.DSH_OBSERVATION_LOG ?? (probe ? join(dirname(probe), 'observations.jsonl') : undefined);
        if (!path || process.env.DSH_OBSERVATION_ENABLED === '0')
            return undefined;
        if (this.configuredPath !== path) {
            this.configuredPath = path;
            this.config = { maxFileBytes: 8_388_608, retainedFiles: 4, maxQueuedEvents: 2048 };
            try {
                const cfg = JSON.parse(readFileSync(join(dirname(path), '..', 'config', 'observationConfig.json'), 'utf8'));
                for (const key of ['maxFileBytes', 'retainedFiles', 'maxQueuedEvents']) {
                    if (Number.isSafeInteger(cfg[key]) && cfg[key] > 0)
                        this.config[key] = Math.min(cfg[key], key === 'maxFileBytes' ? 67_108_864 : key === 'retainedFiles' ? 16 : 8192);
                }
            }
            catch {
                // 可选配置不存在或损坏时不向主流程抛错。
            }
        }
        return path;
    }
    /** 无参数；单写者按顺序落盘与轮转，任何 I/O 故障仅累计丢弃数。 */
    static async drain() {
        while (this.queue.length) {
            const item = this.queue.shift();
            try {
                await mkdir(dirname(item.path), { recursive: true });
                let bytes = 0;
                try {
                    bytes = (await stat(item.path)).size;
                }
                catch { /* 首次创建没有日志。 */ }
                if (bytes + Buffer.byteLength(item.line) > this.config.maxFileBytes) {
                    for (let i = this.config.retainedFiles - 1; i >= 1; i--) {
                        const from = i === 1 ? item.path : `${item.path}.${i - 1}`;
                        const to = `${item.path}.${i}`;
                        try {
                            await unlink(to);
                        }
                        catch { /* 目标不存在，无需清理。 */ }
                        try {
                            await rename(from, to);
                        }
                        catch (error) {
                            if (error.code !== 'ENOENT')
                                throw error;
                        }
                    }
                    if (this.config.retainedFiles === 1)
                        await unlink(item.path);
                }
                await appendFile(item.path, item.line, { encoding: 'utf8', mode: 0o600 });
            }
            catch {
                this.dropped++;
            }
        }
    }
}
//# sourceMappingURL=ObservationRecorder.js.map