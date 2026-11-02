import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import { probe, probe_timer } from '../diagnostics/probe.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { INFLIGHT_TURN_PREFIX } from '../state/weixinStateStore.js';
import { is_cursor_committable } from '../types/domain.js';
function serialize_payload(message) {
    return JSON.stringify({
        delivery_id: message.delivery_id,
        user_id: message.user_id,
        ...message.context_token === undefined ? {} : {
            context_token: message.context_token
        },
        text: message.text,
        received_at: message.received_at,
        media: message.media.map((item)=>({
                kind: item.kind,
                ...item.name === undefined ? {} : {
                    name: item.name
                },
                ...item.mime_type === undefined ? {} : {
                    mime_type: item.mime_type
                },
                ...item.source_text === undefined ? {} : {
                    source_text: item.source_text
                },
                ...item.media === undefined ? {} : {
                    media: item.media
                }
            }))
    });
}
function deserialize_payload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.delivery_id !== 'string' || typeof parsed.user_id !== 'string') return undefined;
        return {
            delivery_id: parsed.delivery_id,
            user_id: parsed.user_id,
            ...parsed.context_token === undefined ? {} : {
                context_token: parsed.context_token
            },
            text: typeof parsed.text === 'string' ? parsed.text : '',
            media: Array.isArray(parsed.media) ? parsed.media : [],
            received_at: typeof parsed.received_at === 'number' ? parsed.received_at : Date.now()
        };
    } catch  {
        return undefined;
    }
}
export function merge_messages(messages) {
    const last = messages[messages.length - 1];
    const first = messages[0];
    const text = messages.map((item)=>item.text.trim()).filter((item)=>item !== '').join('\n');
    const media = messages.flatMap((item)=>[
            ...item.media
        ]);
    return {
        ...last,
        delivery_id: first.delivery_id,
        text,
        media,
        received_at: last.received_at
    };
}
const PENDING_MEDIA_LIMIT = 20;
const COALESCE_MS = Number(process.env.DSH_WEIXIN_COALESCE_MS ?? '6000');
const MEDIA_TIMEOUT_MS = Number(process.env.DSH_WEIXIN_MEDIA_TIMEOUT_MS ?? '120000');
const MAX_DELIVERY_ATTEMPTS = Number(process.env.DSH_WEIXIN_DELIVERY_MAX_ATTEMPTS ?? '3');
const MAX_SHARD_DEPTH = Number(process.env.DSH_WEIXIN_MAX_INBOUND_DEPTH ?? '30');
const CANCEL_CLEARS_PENDING = true;
const CANCEL_COMMANDS = new Set([
    '停止',
    '取消',
    '中断',
    '别做了',
    '停下',
    'stop',
    'cancel',
    'abort',
    '中断任务',
    '停止任务'
]);
const CANCEL_KEEP_COMMANDS = new Set([
    '停止当前但保留队列',
    '取消当前但保留队列',
    'stop-keep-queue'
]);
const STEER_PREFIXES = [
    '插话：',
    '插话:',
    '补充：',
    '补充:',
    '纠正：',
    '纠正:',
    'steer:',
    'steer：'
];
const STATUS_COMMANDS = new Set([
    '状态',
    'status'
]);
export function parse_control_command(text) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    if (CANCEL_COMMANDS.has(lower)) return {
        kind: 'cancel_current',
        clear_pending: CANCEL_CLEARS_PENDING
    };
    if (CANCEL_KEEP_COMMANDS.has(lower)) return {
        kind: 'cancel_current',
        clear_pending: false
    };
    if (STATUS_COMMANDS.has(lower)) return {
        kind: 'status'
    };
    for (const prefix of STEER_PREFIXES){
        if (lower.startsWith(prefix.toLowerCase())) {
            const rest = trimmed.slice(prefix.length).trim();
            if (rest.length > 0) return {
                kind: 'steer_current',
                text: rest
            };
        }
    }
    return undefined;
}
export class InboundCoordinator {
    options;
    disposed = false;
    shards = new Map();
    pending_media = new Map();
    latest_token = new Map();
    coalesced = new Map();
    coalesced_last_at = new Map();
    delivery_sessions = new Map();
    constructor(options){
        this.options = options;
    }
    session_for_delivery(delivery_id) {
        return this.delivery_sessions.get(delivery_id);
    }
    async handle_batch(messages, cursor = undefined, options) {
        const done = probe_timer('inbound', 'batch.start', {
            count: messages.length,
            has_cursor: cursor !== undefined,
            hold: options?.hold === true
        });
        const tasks = [];
        for (const message of messages){
            const put_result = this.options.store.put_delivery_if_absent({
                delivery_id: message.delivery_id,
                user_id: message.user_id,
                received_at: message.received_at,
                ...message.context_token === undefined ? {} : {
                    context_token: message.context_token
                },
                payload_json: serialize_payload(message)
            });
            const first = put_result instanceof Promise ? await put_result : put_result;
            if (!first) {
                probe('inbound', 'batch.skip_duplicate', {
                    delivery_id: message.delivery_id
                });
                const duplicate = this.options.store.get_delivery(message.delivery_id);
                const duplicate_record = duplicate instanceof Promise ? await duplicate : duplicate;
                if (duplicate_record?.status === 'failed_retryable') {
                    tasks.push(this.enqueue_for_user(message));
                }
                continue;
            }
            const route_result = this.options.store.get_session_id(message.user_id);
            const route = route_result instanceof Promise ? await route_result : route_result;
            const recorded = this.options.record_entry?.({
                id: message.delivery_id,
                ts: message.received_at,
                role: 'user',
                text: message.text,
                user_id: message.user_id,
                ...route === undefined ? {} : {
                    session_id: route
                }
            });
            if (recorded !== undefined) await recorded;
            if (options?.hold === true) {
                probe('inbound', 'batch.held', {
                    delivery_id: message.delivery_id,
                    user_id: message.user_id
                });
                continue;
            }
            tasks.push(this.enqueue_for_user(message));
        }
        const settled = await Promise.allSettled(tasks);
        const rejected = settled.filter((item)=>item.status === 'rejected').length;
        if (rejected > 0) probe('inbound', 'batch.task_rejected', {
            rejected
        });
        const ids = messages.map((message)=>message.delivery_id);
        const committable = await this.options.store.batch_committable(ids);
        done({
            committable,
            rejected
        });
        return committable;
    }
    async enqueue_for_user(message, run) {
        if (this.disposed) return Promise.resolve();
        const previous = this.shards.get(message.user_id) ?? {
            chain: Promise.resolve(),
            depth: 0
        };
        if (previous.depth >= MAX_SHARD_DEPTH) {
            probe('inbound', 'shard.overflow', {
                user_id: message.user_id,
                depth: previous.depth,
                limit: MAX_SHARD_DEPTH
            });
            const updated = this.options.store.update_delivery(message.delivery_id, 'failed_terminal', {
                last_error: `入站队列过深（${previous.depth} ≥ ${MAX_SHARD_DEPTH}），已丢弃`,
                increment_attempt: true
            });
            if (updated instanceof Promise) await updated;
            const route = this.options.store.get_session_id(message.user_id);
            if (route instanceof Promise) {
                const session_id = await route ?? `weixin-${message.user_id}`;
                this.options.enqueue_outbound({
                    session_id,
                    user_id: message.user_id,
                    kind: 'error',
                    text: `消息一下有点多啦，这条我先放一放（队列已满 ${MAX_SHARD_DEPTH} 条）😅 稍后再发一次好吗？`
                });
                return;
            }
            this.options.enqueue_outbound({
                session_id: route instanceof Promise ? `weixin-${message.user_id}` : route ?? `weixin-${message.user_id}`,
                user_id: message.user_id,
                kind: 'error',
                text: `消息一下有点多啦，这条我先放一放（队列已满 ${MAX_SHARD_DEPTH} 条）😅 稍后再发一次好吗？`
            });
            return;
        }
        const shard = {
            chain: previous.chain,
            depth: previous.depth + 1
        };
        this.shards.set(message.user_id, shard);
        probe('inbound', 'shard.enqueue', {
            user_id: message.user_id,
            depth: shard.depth
        });
        const task = shard.chain.then(async ()=>{
            await (run === undefined ? this.process_message(message) : run());
        });
        shard.chain = task.catch((error)=>{
            probe('inbound', 'shard.task_failed', {
                user_id: message.user_id,
                delivery_id: message.delivery_id,
                error: String(error)
            });
        }).finally(()=>{
            const current = this.shards.get(message.user_id);
            if (current !== undefined) {
                current.depth = Math.max(0, current.depth - 1);
                if (current.depth === 0) this.shards.delete(message.user_id);
            }
        });
        return task;
    }
    async process_message(message) {
        if (this.options.hydrate_message !== undefined && message.media.length > 0) {
            try {
                message = await this.options.hydrate_message(message);
            } catch (error) {
                probe('inbound', 'media.hydrate_failed', {
                    delivery_id: message.delivery_id,
                    error: String(error)
                });
            }
        }
        const control = parse_control_command(message.text);
        try {
            const oc_command = this.options.opencode_bridge?.parse(message.text);
            if (!this.options.host.tasks && oc_command !== undefined && this.options.opencode_bridge !== undefined) {
                const session_id = await this.options.store.get_session_id(message.user_id) ?? `weixin-${message.user_id}`;
                await this.options.store.update_delivery(message.delivery_id, 'control_applied', {
                    injected_at: Date.now()
                });
                probe('inbound', 'opencode.command', {
                    delivery_id: message.delivery_id,
                    action: oc_command.action
                });
                await this.options.opencode_bridge.handle(message.user_id, session_id, oc_command, message.context_token);
                return;
            }
            const codex_command = this.options.codex_bridge?.parse(message.text);
            if (!this.options.host.tasks && codex_command !== undefined && this.options.codex_bridge !== undefined) {
                const session_id = await this.options.store.get_session_id(message.user_id) ?? `weixin-${message.user_id}`;
                await this.options.store.update_delivery(message.delivery_id, 'control_applied', {
                    injected_at: Date.now()
                });
                probe('inbound', 'codex.command', {
                    delivery_id: message.delivery_id,
                    action: codex_command.action
                });
                await this.options.codex_bridge.handle(message.user_id, session_id, codex_command, message.context_token);
                return;
            }
            if (control !== undefined && !(this.options.host.tasks && control.kind === 'cancel_current')) {
                await this.apply_control(message, control);
                return;
            }
            await this.coalesce_message(message);
        } catch (error) {
            await this.handle_message_failure(message, error);
        }
    }
    async handle_message_failure(message, error) {
        if (this.disposed) return;
        const current = await this.options.store.get_delivery(message.delivery_id);
        if (current !== undefined && is_cursor_committable(current.status)) return;
        const detail = error instanceof Error ? error.message : String(error);
        const attempt = ((await this.options.store.get_delivery(message.delivery_id))?.attempt ?? 0) + 1;
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
            await this.options.store.update_delivery(message.delivery_id, 'failed_terminal', {
                last_error: detail,
                increment_attempt: true
            });
            probe('inbound', 'message.failed_terminal', {
                delivery_id: message.delivery_id,
                attempt,
                error: detail
            });
            this.options.enqueue_outbound({
                session_id: await this.options.store.get_session_id(message.user_id) ?? `weixin-${message.user_id}`,
                user_id: message.user_id,
                kind: 'error',
                text: '（这条消息处理失败了，我已经记录下来；请稍后再发一次或告诉我换种说法）',
                ...message.context_token === undefined ? {} : {
                    context_token: message.context_token
                }
            });
            return;
        }
        await this.options.store.update_delivery(message.delivery_id, 'failed_retryable', {
            last_error: detail,
            increment_attempt: true
        });
        probe('inbound', 'message.failed', {
            delivery_id: message.delivery_id,
            attempt,
            error: detail
        });
    }
    async apply_control(message, control) {
        const done = probe_timer('inbound', 'control.apply', {
            delivery_id: message.delivery_id,
            user_id: message.user_id,
            command: control.kind
        });
        const session_id = await this.options.store.get_session_id(message.user_id);
        if (session_id === undefined) {
            await this.options.store.update_delivery(message.delivery_id, 'control_applied');
            this.options.enqueue_outbound({
                session_id: `weixin-unrouted:${message.user_id}`,
                user_id: message.user_id,
                kind: 'control_ack',
                text: '（当前没有正在进行的任务）',
                ...message.context_token === undefined ? {} : {
                    context_token: message.context_token
                }
            });
            done({
                outcome: 'no_route'
            });
            return;
        }
        const agent = this.options.host.get_agent(brandString(session_id));
        if (agent === undefined) {
            await this.options.store.update_delivery(message.delivery_id, 'control_applied');
            this.options.enqueue_outbound({
                session_id,
                user_id: message.user_id,
                kind: 'control_ack',
                text: control.kind === 'status' ? '（当前空闲，没有正在进行的任务）' : '（当前没有正在进行的任务）',
                ...message.context_token === undefined ? {} : {
                    context_token: message.context_token
                }
            });
            done({
                outcome: 'no_agent'
            });
            return;
        }
        if (control.kind === 'cancel_current') {
            if (agent.status === 'idle') {
                this.options.enqueue_outbound({
                    session_id,
                    user_id: message.user_id,
                    kind: 'control_ack',
                    text: '（当前没有正在进行的任务）',
                    ...message.context_token === undefined ? {} : {
                        context_token: message.context_token
                    }
                });
            } else {
                agent.cancel({
                    kind: 'user'
                }, {
                    keepInbox: !control.clear_pending
                });
                await this.options.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
                this.options.on_turn_cancelled?.(session_id);
                const stopped = await this.options.on_cancel?.(message.user_id);
                const external = stopped === undefined || stopped.killed === 0 ? '' : `，并中断了 ${stopped.killed} 个外部任务`;
                this.options.enqueue_outbound({
                    session_id,
                    user_id: message.user_id,
                    kind: 'control_ack',
                    text: `（已取消当前这一轮${external}${control.clear_pending ? '，排队消息已清空' : '，排队消息保留'}）`,
                    ...message.context_token === undefined ? {} : {
                        context_token: message.context_token
                    }
                });
            }
        } else if (control.kind === 'steer_current') {
            if (agent.status === 'idle') {
                this.options.enqueue_outbound({
                    session_id,
                    user_id: message.user_id,
                    kind: 'control_ack',
                    text: '（没有正在进行的任务，插话未生效；请直接发消息）',
                    ...message.context_token === undefined ? {} : {
                        context_token: message.context_token
                    }
                });
            } else {
                agent.steer(createUserMessage({
                    content: [
                        {
                            type: 'text',
                            text: control.text
                        }
                    ],
                    source: {
                        kind: 'plugin',
                        plugin: 'dsh-webhook-weixin',
                        form: 'notice',
                        summary: '微信插话'
                    }
                }));
                this.options.enqueue_outbound({
                    session_id,
                    user_id: message.user_id,
                    kind: 'control_ack',
                    text: '（已把你的补充插进当前任务）',
                    ...message.context_token === undefined ? {} : {
                        context_token: message.context_token
                    }
                });
            }
        } else {
            this.options.enqueue_outbound({
                session_id,
                user_id: message.user_id,
                kind: 'control_ack',
                text: `（状态：Agent ${agent.status}）`,
                ...message.context_token === undefined ? {} : {
                    context_token: message.context_token
                }
            });
        }
        await this.options.store.update_delivery(message.delivery_id, 'control_applied', {
            session_id,
            injected_at: Date.now()
        });
        done({
            outcome: 'applied',
            agent_status: agent.status
        });
    }
    async coalesce_message(message) {
        const text = message.text.trim();
        if (COALESCE_MS <= 0 || text === '' && message.media.length > 0) {
            await this.inject_message(message);
            return;
        }
        this.begin_routing(message.delivery_id);
        const existing = this.coalesced.get(message.user_id);
        if (existing !== undefined) clearTimeout(existing.timer);
        const messages = [
            ...existing?.messages ?? [],
            message
        ];
        const first_at = existing?.first_at ?? Date.now();
        const timer = setTimeout(()=>{
            const task = this.enqueue_for_user(message, ()=>this.flush_coalesced(message.user_id));
            void task.catch((error)=>probe('inbound', 'coalesce.scheduler_failed', {
                    error: String(error)
                }));
        }, COALESCE_MS);
        this.coalesced.set(message.user_id, {
            messages,
            timer,
            first_at
        });
        this.coalesced_last_at.set(message.user_id, Date.now());
        probe('inbound', 'coalesce.buffered', {
            user_id: message.user_id,
            pending: messages.length,
            window_ms: COALESCE_MS
        });
    }
    async flush_coalesced(user_id) {
        const bucket = this.coalesced.get(user_id);
        if (bucket === undefined) return;
        this.coalesced.delete(user_id);
        const waited = Date.now() - (this.coalesced_last_at.get(user_id) ?? Date.now());
        this.coalesced_last_at.delete(user_id);
        const merged = merge_messages(bucket.messages);
        const extras = bucket.messages.slice(1).map((item)=>item.delivery_id);
        probe('inbound', 'coalesce.flushed', {
            user_id,
            messages: bucket.messages.length,
            chars: merged.text.length,
            waited_ms: Date.now() - bucket.first_at,
            idle_ms: waited
        });
        try {
            await this.inject_message(merged, extras);
        } catch (error) {
            probe('inbound', 'coalesce.inject_failed', {
                user_id,
                error: String(error)
            });
            for (const message of bucket.messages)await this.handle_message_failure(message, error);
        }
    }
    async begin_routing(delivery_id) {
        const row = await this.options.store.get_delivery(delivery_id);
        if (row?.status === 'routing') return;
        const status = row?.status ?? 'received';
        if (status !== 'received' && status !== 'failed_retryable') throw new Error(`delivery 不可路由：${status}`);
        const claimed = await this.options.store.update_delivery(delivery_id, 'routing', {
            expect: status
        });
        if (claimed === false) {
            throw new Error('delivery 状态已变更，路由未获得所有权');
        }
    }
    async dispose() {
        this.disposed = true;
        for (const bucket of this.coalesced.values())clearTimeout(bucket.timer);
        this.coalesced.clear();
        this.coalesced_last_at.clear();
        await Promise.allSettled([
            ...this.shards.values()
        ].map((shard)=>shard.chain));
    }
    async inject_message(message, also_mark = []) {
        if (this.disposed) return;
        const done = probe_timer('inbound', 'message.inject', {
            delivery_id: message.delivery_id,
            user_id: message.user_id
        });
        await this.begin_routing(message.delivery_id);
        const text = message.text.trim();
        if (!text && message.media.length > 0) {
            const pending = this.pending_media.get(message.user_id) ?? [];
            pending.push(...message.media);
            while(pending.length > PENDING_MEDIA_LIMIT)pending.shift();
            this.pending_media.set(message.user_id, pending);
            await this.options.store.update_delivery(message.delivery_id, 'control_applied', {
                injected_at: Date.now()
            });
            done({
                outcome: 'media_buffered',
                buffered: pending.length
            });
            return;
        }
        const buffered = this.pending_media.get(message.user_id);
        if (buffered !== undefined && buffered.length > 0) this.pending_media.delete(message.user_id);
        const media = buffered === undefined || buffered.length === 0 ? message.media : [
            ...buffered,
            ...message.media
        ];
        let session_id = await this.options.store.get_session_id(message.user_id);
        let agent;
        if (session_id !== undefined) {
            const branded = brandString(session_id);
            agent = this.options.host.get_agent(branded) ?? await this.options.host.resume_agent(branded);
        } else {
            session_id = await this.options.store.session_id_for(message.user_id);
            agent = await this.options.host.create_agent(brandString(session_id));
            await this.options.store.set_session_id(message.user_id, session_id);
        }
        const session_key = String(agent.id);
        if (this.disposed) return;
        this.options.on_agent_ready?.(agent);
        this.options.on_agent_bound?.(agent);
        if (message.context_token !== undefined) this.latest_token.set(message.user_id, message.context_token);
        if (this.options.send_media !== undefined) {
            const send_media = this.options.send_media;
            const latest_token = this.latest_token;
            const user_id = message.user_id;
            const media_tool = defineTool({
                name: 'send_file',
                description: '把本地图片发到当前微信聊天（只支持 jpg/png/gif/webp 等图片；文件暂不支持）。用户说"发我""发过来""截图给我"时用它。',
                parameters: {
                    path: {
                        type: 'string',
                        description: '本地图片绝对路径'
                    }
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: {
                                type: 'boolean',
                                required: true
                            },
                            text: {
                                type: 'string',
                                required: true
                            }
                        }
                    },
                    render: (_args, value)=>[
                            {
                                type: 'text',
                                text: value.text
                            }
                        ]
                },
                async execute (args) {
                    const file = String(args.path ?? '').trim();
                    if (file === '') return {
                        ok: false,
                        text: 'path 不能为空'
                    };
                    try {
                        await send_media(user_id, file, latest_token.get(user_id));
                        return {
                            ok: true,
                            text: `已发送：${file}`
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            text: `发送失败：${String(error).slice(0, 160)}`
                        };
                    }
                }
            });
            const current = agent.ctx.tools.get('send_file', agent);
            if (current === undefined) {
                agent.ctx.tools.register(media_tool);
            } else {
                current.description = media_tool.description;
                current.parameters = media_tool.parameters;
                current.execute = media_tool.execute;
            }
        }
        this.options.on_user_message?.(session_key, message.user_id, text);
        const content = await this.build_content(text, media);
        if (content.length === 0) content.push({
            type: 'text',
            text: '[微信空消息]'
        });
        const taskOriginId = this.options.host.tasks?.note_input(agent, {
            channel: 'weixin',
            messageId: message.delivery_id,
            userId: message.user_id,
            owner: (process.env.DSH_SESSION_SHARED ?? '').trim() ? 'shared-household' : `weixin:${message.user_id}`,
            originalText: text
        });
        const incoming = createUserMessage({
            content,
            source: {
                kind: 'plugin',
                plugin: 'dsh-webhook-weixin',
                form: 'notice',
                summary: '微信消息',
                ...taskOriginId ? {
                    taskOriginId
                } : {}
            }
        });
        if (this.disposed) return;
        const steering = !this.options.host.tasks && agent.status !== 'idle';
        if (steering) {
            agent.steer(incoming);
            probe('inbound', 'message.steer', {
                delivery_id: message.delivery_id,
                session_id: session_key
            });
        } else {
            agent.followup(incoming);
        }
        this.delivery_sessions.set(message.delivery_id, session_key);
        await this.options.store.update_delivery(message.delivery_id, 'injected', {
            session_id: session_key,
            injected_at: Date.now()
        });
        for (const delivery_id of also_mark){
            this.delivery_sessions.set(delivery_id, session_key);
            await this.options.store.update_delivery(delivery_id, 'injected', {
                session_id: session_key,
                injected_at: Date.now()
            });
        }
        done({
            outcome: 'injected',
            session_id: session_key,
            blocks: content.length,
            merged: also_mark.length
        });
    }
    async build_content(text, media) {
        const content = [];
        if (text) content.push({
            type: 'text',
            text
        });
        for (const item of media){
            try {
                if (item.data && item.kind === 'image' && this.options.attachments) {
                    const media_type = item.mime_type === 'image/png' || item.mime_type === 'image/webp' || item.mime_type === 'image/gif' ? item.mime_type : 'image/jpeg';
                    const attachment = await with_timeout(this.options.attachments.saveImage({
                        data: item.data,
                        mediaType: media_type,
                        ...item.name === undefined ? {} : {
                            name: item.name
                        }
                    }), MEDIA_TIMEOUT_MS, 'saveImage');
                    content.push({
                        type: 'image',
                        attachment
                    });
                } else if (item.data && item.kind === 'file' && this.options.attachments?.saveFile) {
                    const attachment = await with_timeout(this.options.attachments.saveFile({
                        data: item.data,
                        ...item.name === undefined ? {} : {
                            name: item.name
                        }
                    }), MEDIA_TIMEOUT_MS, 'saveFile');
                    content.push({
                        type: 'file',
                        attachment
                    });
                } else {
                    const note = `[微信媒体 ${item.kind}${item.source_text ? `:${item.source_text}` : ''}]`;
                    content.push({
                        type: 'text',
                        text: note
                    });
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                probe('inbound', 'media.failed', {
                    kind: item.kind,
                    error: detail
                });
                content.push({
                    type: 'text',
                    text: `[微信媒体 ${item.kind} 处理失败：${detail}]`
                });
            }
        }
        return content;
    }
    async recover_unfinished() {
        const unfinished = await this.options.store.list_unfinished_deliveries();
        let needs_reinject = 0;
        let reinjected = 0;
        for (const record of unfinished){
            if (record.payload_json !== undefined) {
                const message = deserialize_payload(record.payload_json);
                if (message !== undefined) {
                    needs_reinject += 1;
                    probe('inbound', 'recover.reinject', {
                        delivery_id: record.delivery_id,
                        user_id: record.user_id,
                        from_status: record.status
                    });
                    await this.enqueue_for_user(message);
                    reinjected += 1;
                    continue;
                }
            }
            needs_reinject += 1;
            await this.options.store.update_delivery(record.delivery_id, 'failed_terminal', {
                last_error: '无法恢复：入站载荷缺失，未重新执行'
            });
        }
        probe('inbound', 'recover.done', {
            unfinished: unfinished.length,
            needs_reinject,
            reinjected
        });
        return {
            recovered: unfinished.length,
            needs_reinject
        };
    }
    is_committable(delivery_id) {
        const record = this.options.store.get_delivery(delivery_id);
        return record !== undefined && is_cursor_committable(record.status);
    }
    async is_committable_async(delivery_id) {
        const record = await this.options.store.get_delivery(delivery_id);
        return record !== undefined && is_cursor_committable(record.status);
    }
}
async function with_timeout(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject)=>{
                timer = setTimeout(()=>reject(new Error(`${label} 超时（${ms}ms）`)), ms);
                timer.unref?.();
            })
        ]);
    } finally{
        if (timer !== undefined) clearTimeout(timer);
    }
}
