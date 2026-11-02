import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { brandString } from '@deepseek-ai/dsh-brand';
import { ObservationRecorder } from '@deepseek-ai/dsh-llm';
import { IlinkClient } from '../api/ilinkClient.js';
import { probe, probe_timer } from '../diagnostics/probe.js';
import { start_inject_server } from '../diagnostics/injectServer.js';
import { clear_directory_contents, delete_session_artifacts, directory_bytes, session_dir_path, session_log_stats, sessions_root } from '../session/sessionFiles.js';
import { ConsumerLease, preflight_openclaw_isolation } from '../lifecycle/consumerLease.js';
import { CodexBridge, parse_codex_command } from '../coordination/codexBridge.js';
import { CodexWatcher } from '../coordination/codexWatcher.js';
import { OpencodeBridge, parse_opencode_command } from '../coordination/opencodeBridge.js';
import { OpencodeWatcher } from '../coordination/opencodeWatcher.js';
import { InboundCoordinator } from '../coordination/inboundCoordinator.js';
import { OutboundCoordinator } from '../coordination/outboundCoordinator.js';
import { ReplyAggregator } from '../reply/replyAggregator.js';
import { HarnessSessionHost } from '../session/weixinSessionHost.js';
import { migrate_legacy_route_state } from '../state/migrateLegacyRouteState.js';
import { TimelineStore } from '../memory/timelineStore.js';
import { MemoryRemoteClient } from '../memory/memoryRemoteClient.js';
import { register_timeline_tools } from '../memory/timelineTools.js';
import { KnowledgeGraphStore } from '../memory/graphStore.js';
import { register_graph_tools } from '../memory/graphTools.js';
import { start_graph_scheduler } from '../memory/graphScheduler.js';
import { create_gemma_gate } from '../memory/gemmaGate.js';
import { create_notify_settings } from '../coordination/notifySettings.js';
import { register_notify_tools } from '../coordination/notifyTools.js';
import { register_bridge_result_tools } from '../memory/bridgeResultTools.js';
import { register_bridge_session_tools } from '../coordination/bridgeSessionTools.js';
import { kill_external_runs } from '../coordination/externalRuns.js';
import { ModelHealth, classify_llm_failure, cooldown_ms, find_model_config, next_alive_candidate, parse_failover_config } from './modelFailover.js';
import { create_gemma_summarizer } from '../memory/gemmaSummarizer.js';
import { create_memory_model } from '../memory/memoryModel.js';
import { start_timeline_scheduler } from '../memory/timelineScheduler.js';
import { set_shared_memory } from '../memory/sharedMemory.js';
import { INFLIGHT_TURN_PREFIX, WeixinStateStore } from '../state/weixinStateStore.js';
import { StateRemoteClient } from '../state/stateRemoteClient.js';
import { TurnContextStore } from '../state/turnContextStore.js';
import { WeixinIngress } from '../transport/weixinIngress.js';
const PROJECT_CONFIG_DIR = process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd();
function port_open(port) {
    return new Promise((resolve)=>{
        const socket = createConnection({
            port,
            host: '127.0.0.1'
        });
        const finish = (value)=>{
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(1_500);
        socket.once('connect', ()=>finish(true));
        socket.once('timeout', ()=>finish(false));
        socket.once('error', ()=>finish(false));
    });
}
const BACKOFF_STEPS = [
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    30_000
];
const PROGRESS_MIN_INTERVAL_MS = Number(process.env.DSH_WEIXIN_PROGRESS_INTERVAL_MS ?? '25000');
const PROGRESS_MIN_CHARS = 12;
const BINDING_TTL_MS = Number(process.env.DSH_WEIXIN_BINDING_TTL_MS ?? String(30 * 60_000));
const AGENT_ERROR_GRACE_MS = Number(process.env.DSH_WEIXIN_AGENT_ERROR_GRACE_MS ?? '60000');
const INFLIGHT_RESCUE_MIN_AGE_MS = 5_000;
function account_fingerprint(token) {
    if (token === undefined || token === '') return 'unknown';
    return 'acct-' + createHash('sha256').update(token).digest('hex').slice(0, 12);
}
function read_json_file(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch  {
        return {};
    }
}
export class WeixinConnector {
    store;
    remote_state;
    turn_context;
    ingress;
    inbound;
    outbound;
    host;
    lease;
    client;
    codex_bridge;
    codex_watcher;
    opencode_bridge;
    opencode_watcher;
    controller = new AbortController();
    stream_disposers = new Map();
    stream_agents = new Map();
    observation_disposers;
    tool_calls_seen = new Map();
    current_turn = new Map();
    turn_failure_timers = new Map();
    current_model = {
        provider: '',
        model: ''
    };
    model_health = new ModelHealth();
    last_user_message = new Map();
    turn_error = new Map();
    turn_visible = new Set();
    compacting_sessions = new Set();
    compact_ack_sent = new Set();
    last_progress_at = new Map();
    aggregators = new Map();
    running;
    stopped = false;
    inject_server;
    timeline;
    graph;
    workspace_path = process.cwd();
    notify;
    timeline_scheduler;
    graph_scheduler;
    memory;
    gemma;
    ctx;
    constructor(ctx, options){
        this.ctx = ctx;
        this.observation_disposers = [
            ctx.on('session/event', (session, event)=>{
                try {
                    ObservationRecorder.observe_event(String(session.id), event);
                } catch  {}
            }),
            ctx.on('session/disposed', (session)=>{
                ObservationRecorder.forget_session(String(session.id));
            })
        ];
        const db_path = options.state_db ?? join(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')), 'weixin-state.db');
        const remote_state = process.env.SYNLOVE_STATE_MODE === 'remote';
        this.remote_state = remote_state;
        this.store = remote_state ? new StateRemoteClient() : new WeixinStateStore({
            path: db_path
        });
        if (!remote_state) {
            const legacy_path = options.state_file ?? join(process.env.DSH_WEIXIN_STATE_FILE ?? join(process.cwd(), 'runtime', 'weixin-route-state.json'));
            const migration = migrate_legacy_route_state(this.store, legacy_path);
            probe('lifecycle', 'migration.result', {
                ...migration
            });
        } else {
            probe('lifecycle', 'state.remote', {
                base_url: process.env.SYNLOVE_STATE_BASE_URL ?? 'default'
            });
        }
        this.turn_context = new TurnContextStore(this.store);
        const timeline_enabled = process.env.DSH_TIMELINE_ENABLED !== '0';
        const remote_timeline = process.env.SYNLOVE_MEMORY_TIMELINE_MODE === 'remote';
        const remote_memory = remote_timeline ? new MemoryRemoteClient() : undefined;
        this.timeline = timeline_enabled ? remote_timeline ? remote_memory : new TimelineStore({
            dir: options.timeline_dir ?? process.env.DSH_TIMELINE_DIR ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'timeline'),
            ...process.env.DSH_TIMELINE_TIMEZONE === undefined ? {} : {
                timezone: process.env.DSH_TIMELINE_TIMEZONE
            }
        }) : undefined;
        this.graph = remote_memory ?? new KnowledgeGraphStore({
            dir: options.graph_dir ?? process.env.DSH_GRAPH_DIR ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'graph')
        });
        if (this.timeline !== undefined) set_shared_memory({
            timeline: this.timeline,
            graph: this.graph
        });
        try {
            const center_result = this.graph.ensure_center();
            if (center_result instanceof Promise) {
                void center_result.catch((error)=>probe('graph', 'center.failed', {
                        error: String(error)
                    }));
            }
            probe('graph', 'center.ready', {
                remote: this.graph instanceof MemoryRemoteClient
            });
        } catch (error) {
            probe('graph', 'center.failed', {
                error: String(error)
            });
        }
        this.notify = create_notify_settings(this.store);
        const engine = process.env.DSH_MEMORY_ENGINE === 'cloud' ? 'cloud' : 'gemma';
        this.memory = create_memory_model({
            engine,
            ...process.env.DSH_MEMORY_CLOUD_MODEL === undefined ? {} : {
                cloud_model: process.env.DSH_MEMORY_CLOUD_MODEL
            },
            config_path: find_model_config(PROJECT_CONFIG_DIR) ?? join(PROJECT_CONFIG_DIR, 'config', 'modelConfig.json')
        });
        this.gemma = create_gemma_gate({
            min_free_vram_mb: engine === 'gemma' && process.env.SYNLOVE_LLM_MANAGEMENT !== 'external' ? Number(process.env.DSH_GEMMA_MIN_FREE_VRAM_MB ?? '5200') : 0,
            ...engine === 'gemma' && process.env.SYNLOVE_LLM_MANAGEMENT !== 'external' ? {
                ensure_ready: ()=>this.ensure_gemma_running()
            } : {}
        });
        probe('lifecycle', 'memory_engine', {
            engine,
            label: this.memory.label
        });
        this.client = new IlinkClient(options);
        this.workspace_path = options.workspace_path ?? process.cwd();
        this.current_model = {
            provider: options.provider ?? '',
            model: options.model ?? ''
        };
        this.host = new HarnessSessionHost(ctx, {
            ...options.agent_preset === undefined ? {} : {
                agent_preset: options.agent_preset
            },
            workspace_path: options.workspace_path ?? process.cwd(),
            ...options.provider === undefined ? {} : {
                provider: options.provider
            },
            ...options.model === undefined ? {} : {
                model: options.model
            },
            ...options.reasoning_effort === undefined ? {} : {
                reasoning_effort: options.reasoning_effort
            }
        });
        if (this.host.tasks) this.host.tasks.worker_setup = (child, task)=>{
            if (task.kind === 'coding') return;
            if (this.timeline !== undefined) register_timeline_tools(child, this.timeline);
            register_graph_tools(child, this.graph);
            if (task.kind === 'research') return;
            register_notify_tools(child, this.notify);
            register_bridge_result_tools(child, this.store);
            register_bridge_session_tools(child);
        };
        this.host.tasks?.register_channel('weixin', {
            resolve: async (origin)=>{
                const session = await this.store.get_session_id(origin.userId) ?? origin.sessionId;
                const agent = this.host.get_agent(brandString(session)) ?? await this.host.resume_agent(brandString(session));
                this.bind_agent_stream(agent);
                return agent;
            },
            send: async (task, text)=>{
                if (!await this.lease.is_held()) throw new Error('微信消费者所有权已丢失，结果保留待投递');
                const session = await this.store.get_session_id(task.origin.userId) ?? task.origin.sessionId;
                const token = await this.turn_context.latest_token_if_fresh_async(session);
                const row = await this.store.enqueue_outbox({
                    session_id: session,
                    user_id: task.origin.userId,
                    kind: 'assistant',
                    text,
                    client_id: `task-${task.id}`,
                    ...token ? {
                        context_token: token
                    } : {}
                });
                void this.outbound.drain();
                return row.outbound_id;
            }
        });
        this.lease = new ConsumerLease({
            store: this.store,
            account_id: account_fingerprint(options.token),
            ...options.lease_marker === undefined ? {} : {
                marker_path: options.lease_marker
            }
        });
        this.ingress = new WeixinIngress({
            client: this.client,
            observer: {
                on_error: (error)=>probe('ingress', 'observer.error', {
                        error: String(error)
                    }),
                on_status: (status, detail)=>probe('ingress', 'observer.status', {
                        status,
                        detail
                    })
            }
        });
        this.outbound = new OutboundCoordinator({
            store: this.store,
            turn_context: this.turn_context,
            sender: async (input)=>{
                if (!await this.lease.is_held()) throw new Error('微信消费者所有权已丢失，停止发送');
                await this.client.send_message_with_retry({
                    to_user_id: input.user_id,
                    text: input.text,
                    client_id: input.client_id,
                    ...input.context_token === undefined ? {} : {
                        context_token: input.context_token
                    }
                });
            },
            record_entry: (entry)=>this.record_timeline(entry),
            classify_retryable: (error)=>{
                const retryable = error?.retryable;
                return retryable !== false;
            }
        });
        const attachments = ctx.get('attachments');
        this.codex_bridge = new CodexBridge(this.store, (user_id, session_id, text, kind, context_token)=>{
            this.queue_notice({
                session_id,
                user_id,
                kind,
                text,
                ...context_token === undefined ? {} : {
                    context_token
                }
            });
            void this.outbound.drain();
        }, options.codex_workspace ?? process.env.DSH_CODEX_WORKSPACE);
        this.opencode_bridge = new OpencodeBridge(this.store, (user_id, session_id, text, kind, context_token)=>{
            this.queue_notice({
                session_id,
                user_id,
                kind,
                text,
                ...context_token === undefined ? {} : {
                    context_token
                }
            });
            void this.outbound.drain();
        });
        this.opencode_watcher = new OpencodeWatcher({
            store: this.store,
            push: async (user_id, text)=>{
                const enabled = this.notify.is_enabled_async === undefined ? this.notify.is_enabled('opencode') : await this.notify.is_enabled_async('opencode');
                if (!enabled) {
                    probe('opencode-watch', 'notify.suppressed');
                    return;
                }
                const session_id = await this.store.get_session_id(user_id) ?? `weixin-${user_id}`;
                this.queue_notice({
                    session_id,
                    user_id,
                    kind: 'assistant',
                    text
                });
                await this.outbound.drain();
            }
        });
        this.codex_watcher = new CodexWatcher({
            store: this.store,
            push: async (user_id, text)=>{
                const enabled = this.notify.is_enabled_async === undefined ? this.notify.is_enabled('codex') : await this.notify.is_enabled_async('codex');
                if (!enabled) {
                    probe('codex-watch', 'notify.suppressed');
                    return;
                }
                const session_id = await this.store.get_session_id(user_id) ?? `weixin-${user_id}`;
                this.queue_notice({
                    session_id,
                    user_id,
                    kind: 'assistant',
                    text
                });
                await this.outbound.drain();
            }
        });
        this.inbound = new InboundCoordinator({
            store: this.store,
            turn_context: this.turn_context,
            host: this.host,
            ...attachments === undefined ? {} : {
                attachments
            },
            enqueue_outbound: (input)=>{
                this.queue_notice(input);
            },
            send_media: async (user_id, path, context_token)=>{
                if (!await this.lease.is_held()) throw new Error('微信消费者所有权已丢失，停止发送媒体');
                const { readFile } = await import('node:fs/promises');
                const data = new Uint8Array(await readFile(path));
                if (!await this.lease.is_held()) throw new Error('微信消费者所有权已丢失，停止发送媒体');
                await this.client.send_image({
                    to_user_id: user_id,
                    data,
                    ...context_token === undefined ? {} : {
                        context_token
                    }
                });
                probe('outbound', 'weixin.send_image', {
                    user_id,
                    bytes: data.byteLength
                });
            },
            on_agent_ready: (agent)=>{
                this.bind_agent_stream(agent);
            },
            on_user_message: (session_id, user_id, text)=>{
                this.remember_user_message(session_id, user_id, text);
            },
            on_cancel: async (user_id)=>{
                this.opencode_bridge.stop(user_id);
                this.codex_bridge.stop(user_id);
                const result = kill_external_runs();
                probe('inbound', 'cancel.external_runs', {
                    user_id,
                    killed: result.killed,
                    pids: [
                        ...result.pids
                    ]
                });
                return {
                    killed: result.killed,
                    pids: result.pids
                };
            },
            on_turn_cancelled: (session_id)=>{
                void this.finalize_turn(session_id);
            },
            codex_bridge: {
                parse: (text)=>parse_codex_command(text),
                handle: (user_id, session_id, command, context_token)=>this.codex_bridge.handle(user_id, session_id, command, context_token)
            },
            opencode_bridge: {
                parse: (text)=>parse_opencode_command(text),
                handle: (user_id, session_id, command, context_token)=>this.opencode_bridge.handle(user_id, session_id, command, context_token)
            },
            hydrate_message: async (message)=>{
                const hydrated = await this.ingress.media_normalizer.hydrate_media(message, (media)=>this.ingress.download_media(media));
                await this.record_media_to_timeline(hydrated, attachments).catch((error)=>{
                    probe('timeline', 'media.record_failed', {
                        error: String(error)
                    });
                });
                return hydrated;
            },
            record_entry: (entry)=>this.record_timeline(entry)
        });
        probe('lifecycle', 'connector.constructed', {
            db_path,
            preset: options.agent_preset ?? '(default)',
            workspace: options.workspace_path
        });
    }
    queue_notice(input) {
        if (this.remote_state) void this.outbound.enqueue_notice_async(input);
        else this.outbound.enqueue_notice(input);
    }
    queue_assistant(input) {
        if (this.remote_state) void this.outbound.enqueue_assistant_async(input);
        else this.outbound.enqueue_assistant(input);
    }
    queue_progress(session_id, text) {
        if (this.remote_state) void this.outbound.enqueue_progress_async(session_id, text);
        else this.outbound.enqueue_progress(session_id, text);
    }
    async start() {
        if (this.running !== undefined) return this.running;
        this.running = this.run();
        return this.running;
    }
    async run() {
        if (process.env.DSH_WEIXIN_SKIP_OPENCLAW_CHECK !== '1') {
            const isolation = preflight_openclaw_isolation();
            if (!isolation.ok) {
                throw new Error('webhook-weixin: OpenClaw 隔离检查未通过，拒绝启动：\n  - ' + isolation.problems.join('\n  - ') + '\n请先停用 OpenClaw 的微信通道（openclaw-weixin.enabled=false）。');
            }
        }
        this.host.assert_capabilities();
        await this.reload_preset();
        await this.lease.acquire();
        const rescued = await this.rescue_interrupted_turns();
        const recovered = await this.inbound.recover_unfinished();
        const pending = await this.outbound.recover_pending();
        probe('lifecycle', 'recover.summary', {
            ...recovered,
            outbox_pending: pending,
            rescued_turns: rescued
        });
        console.error(`[webhook-weixin] 启动恢复：delivery=${recovered.recovered} outbox=${pending}` + `${rescued > 0 ? `，补跑被打断的轮次=${rescued}` : ''}；` + `状态快照 ${JSON.stringify(await this.store.snapshot())}`);
        this.codex_watcher.start();
        this.opencode_watcher.start();
        this.start_inject_server_if_configured();
        this.start_timeline_scheduler_if_enabled();
        try {
            await this.ingress.notify_start(this.controller.signal);
            await this.poll_loop();
        } finally{
            await this.ingress.notify_stop(this.controller.signal);
        }
    }
    start_inject_server_if_configured() {
        const port = Number(process.env.DSH_WEIXIN_INJECT_PORT ?? '0');
        if (!Number.isInteger(port) || port <= 0) return;
        this.inject_server = start_inject_server({
            port,
            inject: (input)=>this.inject_test_message(input),
            admin: (action, body)=>this.admin_action(action, body)
        });
    }
    async admin_action(action, body) {
        const user_id = typeof body.user_id === 'string' && body.user_id !== '' ? body.user_id : undefined;
        switch(action){
            case 'clear-context':
                return this.clear_context(user_id === undefined ? {} : {
                    user_id
                });
            case 'clear-memory':
                {
                    const target = String(body.target ?? '');
                    if (target !== 'timeline' && target !== 'graph') {
                        throw new Error(`clear-memory 的 target 只能是 timeline 或 graph，收到：${target}`);
                    }
                    return await this.clear_memory(target);
                }
            case 'memory-stats':
                return await this.memory_stats();
            case 'clear-queue':
                return {
                    removed: await this.store.clear_queue()
                };
            case 'failover-status':
                {
                    const path = find_model_config(PROJECT_CONFIG_DIR);
                    const config = path === undefined ? {} : read_json_file(path);
                    return {
                        current: this.current_model,
                        order: parse_failover_config(config).order,
                        dead: this.model_health.snapshot()
                    };
                }
            case 'reload-preset':
                return this.reload_preset();
            default:
                throw new Error(`未知的管理动作：${action}`);
        }
    }
    async clear_memory(target) {
        if (target === 'timeline') {
            if (this.timeline === undefined) {
                return {
                    target,
                    files: 0,
                    bytes: 0,
                    dir: '',
                    note: '时间线记忆未启用（DSH_TIMELINE_ENABLED=0）'
                };
            }
            if (!(this.timeline instanceof TimelineStore)) {
                return {
                    target,
                    files: 0,
                    bytes: 0,
                    dir: 'remote',
                    note: '远程时间线必须由 memory 服务执行清空；本地控制器不会绕过 API 删除服务端数据'
                };
            }
            const removed = clear_directory_contents(this.timeline.dir_path());
            this.timeline.ensure_dirs();
            this.timeline.forget_caches();
            probe('memory', 'timeline.cleared', {
                ...removed
            });
            return {
                target,
                ...removed
            };
        }
        if (!(this.graph instanceof KnowledgeGraphStore)) {
            return {
                target,
                files: 0,
                bytes: 0,
                dir: 'remote',
                note: '远程图谱必须由 memory 服务执行清空；本地控制器不会绕过 API 删除服务端数据'
            };
        }
        const removed = clear_directory_contents(this.graph.dir_path());
        this.graph.ensure_center();
        this.graph.reset_watermark();
        probe('memory', 'graph.cleared', {
            ...removed
        });
        return {
            target,
            ...removed,
            note: `已重建中心（欣爱 · 主人），并归零水位；下次空闲时会从现有历史里重新积累`
        };
    }
    async memory_stats() {
        const stats = this.timeline === undefined ? {
            error: '时间线记忆未启用'
        } : this.timeline instanceof MemoryRemoteClient ? (()=>{
            return {
                error: '时间线由远程 memory 服务托管；目录大小由服务端统计'
            };
        })() : (()=>{
            const summary = this.timeline.stats();
            return {
                days: summary.days ?? 0,
                entries: summary.entries ?? 0,
                bytes: directory_bytes(this.timeline.dir_path()),
                dir: this.timeline.dir_path()
            };
        })();
        const graph_stats = this.graph instanceof MemoryRemoteClient ? {
            error: '图谱由远程 memory 服务托管；目录大小由服务端统计'
        } : (()=>{
            const summary = this.graph.stats();
            return {
                people: summary.people,
                relations: summary.relations,
                bytes: directory_bytes(this.graph.dir_path()),
                dir: this.graph.dir_path()
            };
        })();
        const root = sessions_root();
        const users = [];
        for (const user_id of (await this.store.list_users())){
            const route = await this.store.get_session_id(user_id);
            const session_id = route ?? await this.store.session_id_for(user_id);
            const log = session_log_stats(session_dir_path(root, this.workspace_path, session_id));
            users.push({
                user_id,
                session_id,
                epoch: await this.store.context_epoch(user_id),
                online: this.host.get_agent(brandString(session_id)) !== undefined,
                bytes: log?.bytes ?? 0,
                modified_at: log?.modified_at ?? 0
            });
        }
        return {
            timeline: stats,
            graph: graph_stats,
            context: {
                users,
                bytes: users.reduce((sum, item)=>sum + item.bytes, 0)
            }
        };
    }
    async clear_context(input) {
        const users = input.user_id === undefined || input.user_id === '' ? await this.store.list_users() : [
            input.user_id
        ];
        const epochs = {};
        const results = [];
        for (const user_id of users){
            const session_id = await this.store.get_session_id(user_id) ?? await this.store.session_id_for(user_id);
            const disposed = await this.host.dispose_agent(session_id);
            this.forget_session(session_id);
            const deletion = delete_session_artifacts({
                root: sessions_root(),
                cwd: this.workspace_path,
                id: session_id
            });
            await this.store.clear_session_id(user_id);
            epochs[user_id] = await this.store.bump_context_epoch(user_id);
            results.push({
                user_id,
                session_id,
                disposed,
                deleted: deletion.deleted,
                ...deletion.reason === undefined ? {} : {
                    note: deletion.reason
                }
            });
            probe('lifecycle', 'context.cleared', {
                user_id,
                session_id,
                disposed,
                deleted: deletion.deleted,
                epoch: epochs[user_id]
            });
        }
        return {
            users: results,
            epochs
        };
    }
    async reload_preset() {
        this.host.reset_composition();
        const probe_id = `preset-check-${Date.now().toString(36)}`;
        let failure = '';
        try {
            const agent = await this.host.create_agent(brandString(probe_id));
            if (this.timeline !== undefined && !this.host.tasks) {
                register_timeline_tools(agent.ctx, this.timeline);
                register_graph_tools(agent.ctx, this.graph);
            }
            this.bind_agent_stream(agent);
            this.bind_agent_stream(agent);
            if (this.host.tasks) {
                const tools = agent.ctx.tools.schemas(agent);
                if (tools.length !== 5 || tools.some((tool)=>!tool.name.startsWith('mcp__synlove-task__'))) throw new Error('主人格五工具隔离检查失败：' + tools.map((tool)=>tool.name).join(','));
                const worker_tools = await this.host.tasks.check_worker(this.current_model, this.workspace_path);
                probe('agent-task', 'roles.checked', {
                    presenter_tools: tools.length,
                    worker_tools
                });
            }
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        } finally{
            this.forget_session(probe_id);
            await this.host.dispose_agent(probe_id);
            delete_session_artifacts({
                root: sessions_root(),
                cwd: this.workspace_path,
                id: probe_id
            });
        }
        if (failure !== '') {
            probe('lifecycle', 'preset.reload_failed', {
                error: failure
            });
            throw new Error(`preset 组装失败，已回滚：${failure}`);
        }
        probe('lifecycle', 'preset.reloaded', {});
        return {
            reloaded: true,
            routing_checked: true
        };
    }
    forget_session(session_id) {
        try {
            this.stream_disposers.get(session_id)?.();
        } catch (error) {
            probe('lifecycle', 'context.dispose_failed', {
                session_id,
                error: String(error)
            });
        }
        this.stream_disposers.delete(session_id);
        this.stream_agents.delete(session_id);
        this.tool_calls_seen.delete(session_id);
        this.current_turn.delete(session_id);
        this.last_progress_at.delete(session_id);
        this.aggregators.delete(session_id);
    }
    async inject_test_message(input) {
        const user_id = input.user_id ?? await this.store.latest_user_id();
        if (user_id === undefined) {
            throw new Error('还没有任何入站用户，无法确定收件人；请先用真实微信发一条消息');
        }
        const delivery_id = `inject-${Date.now()}-${randomBytes(4).toString('hex')}`;
        probe('inbound', 'inject.accepted', {
            delivery_id,
            user_id,
            text_len: input.text.length,
            text: input.text.slice(0, 120)
        });
        await this.handle_inbound([
            {
                delivery_id,
                user_id,
                text: input.text,
                media: [],
                received_at: Date.now()
            }
        ], undefined);
        const route = await this.store.get_session_id(user_id);
        return {
            delivery_id,
            ...route === undefined ? {} : {
                session_id: route
            }
        };
    }
    async record_media_to_timeline(message, attachments) {
        if (this.timeline === undefined || attachments === undefined) return;
        const images = message.media.filter((item)=>item.kind === 'image' && item.data !== undefined);
        if (images.length === 0) return;
        const date = this.timeline.day_key(message.received_at);
        const refs = [];
        for (const item of images){
            try {
                const ref = await attachments.saveImage({
                    data: item.data,
                    mediaType: item.mime_type ?? 'image/jpeg',
                    ...item.name === undefined ? {} : {
                        name: item.name
                    }
                });
                refs.push({
                    id: String(ref.attachmentId),
                    media_type: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...ref.name === undefined ? {} : {
                        name: ref.name
                    }
                });
            } catch (error) {
                probe('timeline', 'media.save_failed', {
                    error: String(error)
                });
            }
        }
        if (refs.length === 0) return;
        await this.timeline.update_entry(date, message.delivery_id, {
            attachments: refs
        });
        probe('timeline', 'media.recorded', {
            date,
            delivery_id: message.delivery_id,
            count: refs.length
        });
        for (const [index, item] of images.entries()){
            const ref = refs[index];
            if (ref === undefined) continue;
            void this.describe_image(item, date, message.delivery_id, ref.id);
        }
    }
    async describe_image(media, date, entry_id, attachment_id) {
        if (this.timeline === undefined || media.data === undefined) return;
        try {
            const text = await this.gemma.run('image-describe', ()=>this.memory.describe_image({
                    data: media.data,
                    media_type: media.mime_type ?? 'image/jpeg'
                }));
            if (text.trim() === '') return;
            await this.timeline.update_attachment_description(date, entry_id, attachment_id, text.trim());
        } catch (error) {
            probe('timeline', 'media.describe_failed', {
                attachment_id,
                error: String(error)
            });
        }
    }
    async record_timeline(entry) {
        if (this.timeline === undefined) return;
        try {
            await this.timeline.append(entry);
        } catch (error) {
            probe('timeline', 'append.failed', {
                id: entry.id,
                error: String(error)
            });
        }
    }
    start_timeline_scheduler_if_enabled() {
        if (this.timeline === undefined) return;
        const summarize = create_gemma_summarizer({
            complete: (prompt, max_tokens)=>this.memory.complete(prompt, max_tokens)
        });
        this.timeline_scheduler = start_timeline_scheduler({
            store: this.timeline,
            summarizer: (request)=>this.gemma.run('timeline-summary', ()=>summarize(request)),
            on_update: (dates)=>probe('timeline', 'summary.updated_days', {
                    dates
                })
        });
        if (this.timeline instanceof TimelineStore && this.graph instanceof KnowledgeGraphStore || this.timeline instanceof MemoryRemoteClient && this.graph instanceof MemoryRemoteClient) {
            this.graph_scheduler = start_graph_scheduler({
                graph: this.graph,
                timeline: this.timeline,
                complete: (prompt)=>this.gemma.run('graph-extract', ()=>this.memory.complete(prompt)),
                on_update: (result)=>probe('graph', 'updated', {
                        ...result
                    })
            });
        } else {
            probe('graph', 'scheduler.deferred_mixed_memory_backend');
        }
    }
    async ensure_gemma_running() {
        if (process.env.SYNLOVE_LLM_MANAGEMENT === 'external') return;
        if (await port_open(Number(process.env.GEMMA_SERVER_PORT ?? '8080'))) return;
        const binary = process.env.GEMMA_SERVER_BIN;
        const model = process.env.GEMMA_MODEL_PATH;
        if (binary === undefined || model === undefined) {
            throw new Error('不知道 Gemma 怎么启动（缺 GEMMA_SERVER_BIN/GEMMA_MODEL_PATH），请重启一次链路。');
        }
        const args = [
            '-m',
            model,
            '--host',
            '127.0.0.1',
            '--port',
            process.env.GEMMA_SERVER_PORT ?? '8080',
            '-c',
            process.env.GEMMA_CONTEXT ?? '32768',
            '-ngl',
            '99',
            '--jinja',
            '--reasoning',
            'off',
            '-np',
            '1',
            '-fa',
            'on',
            '--alias',
            process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M',
            '--sleep-idle-seconds',
            process.env.DSH_GEMMA_SLEEP_IDLE_SECONDS ?? '120'
        ];
        if (process.env.GEMMA_MMPROJ_PATH !== undefined && process.env.GEMMA_MMPROJ_PATH !== '') {
            args.push('--mmproj', process.env.GEMMA_MMPROJ_PATH);
        }
        probe('gemma', 'server.start_on_demand', {
            binary,
            model
        });
        const child = spawn(binary, args, {
            windowsHide: true,
            stdio: 'ignore',
            detached: true
        });
        child.unref();
        for(let attempt = 0; attempt < 120; attempt += 1){
            if (await port_open(Number(process.env.GEMMA_SERVER_PORT ?? '8080'))) return;
            await new Promise((resolve)=>setTimeout(resolve, 2_000));
        }
        throw new Error('Gemma 服务启动后一直没就绪');
    }
    async poll_loop() {
        let backoff_index = 0;
        let cursor_stall = 0;
        while(!this.controller.signal.aborted && !this.stopped){
            if (!await this.lease.is_held()) {
                this.controller.abort();
                this.outbound.stop();
                await this.inbound.dispose();
                probe('lifecycle', 'lease.lost_stop');
                return;
            }
            void this.outbound.drain();
            const cursor = await this.store.get_cursor();
            const result = await this.ingress.poll(cursor, this.controller.signal);
            if (!await this.lease.is_held()) continue;
            switch(result.kind){
                case 'messages':
                    {
                        backoff_index = 0;
                        const committable = await this.handle_inbound(result.messages, result.cursor);
                        if (committable && result.cursor !== undefined) {
                            await this.store.set_cursor(result.cursor);
                            cursor_stall = 0;
                        } else if (!committable) {
                            probe('inbound', 'cursor.held', {
                                reason: '有 delivery 未达终态，等待重投或恢复',
                                delivery_ids: result.messages.map((m)=>m.delivery_id),
                                stall: cursor_stall + 1
                            });
                            cursor_stall += 1;
                            await sleep(Math.min(5_000, 500 * cursor_stall), this.controller.signal);
                        }
                        await this.outbound.drain();
                        break;
                    }
                case 'idle':
                    {
                        backoff_index = 0;
                        if (result.cursor !== undefined) await this.store.set_cursor(result.cursor);
                        await this.outbound.drain();
                        break;
                    }
                case 'session_timeout':
                    {
                        probe('ingress', 'session_timeout.recover');
                        await this.ingress.notify_start(this.controller.signal).catch((error)=>{
                            probe('ingress', 'session_timeout.notify_failed', {
                                error: String(error)
                            });
                        });
                        break;
                    }
                case 'auth_required':
                    {
                        probe('lifecycle', 'auth_required', {
                            detail: result.detail
                        });
                        this.write_auth_marker(result.detail);
                        this.stopped = true;
                        return;
                    }
                case 'protocol_error':
                    {
                        const wait = BACKOFF_STEPS[Math.min(backoff_index, BACKOFF_STEPS.length - 1)];
                        backoff_index += 1;
                        probe('ingress', 'backoff', {
                            wait_ms: wait,
                            attempt: backoff_index,
                            detail: result.detail
                        });
                        await sleep(wait, this.controller.signal);
                        break;
                    }
            }
        }
    }
    write_auth_marker(detail) {
        const marker = process.env.DSH_WEIXIN_TOKEN_MARKER ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'weixin-token-invalid.flag');
        void import('node:fs/promises').then((fs)=>fs.writeFile(marker, `${new Date().toISOString()} ${detail}\n`, 'utf8')).catch(()=>undefined);
        console.error('[webhook-weixin] 认证失效，已停止消费；请运行 weixin_login.py 重新扫码。标记：' + marker);
    }
    bind_agent_stream(agent) {
        const session_id = String(agent.id);
        if (this.stream_agents.get(session_id) === agent) return;
        this.stream_disposers.get(session_id)?.();
        if (this.timeline !== undefined && !this.host.tasks) {
            agent.ctx.effect(()=>{
                register_timeline_tools(agent.ctx, this.timeline);
                register_graph_tools(agent.ctx, this.graph);
                register_notify_tools(agent.ctx, this.notify);
                register_bridge_result_tools(agent.ctx, this.store);
                register_bridge_session_tools(agent.ctx);
                return ()=>{};
            }, 'webhook-weixin.memory-tools()');
        }
        const dispose = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame })=>{
            if (subject !== agent) return;
            if (this.host.tasks?.is_presenting(session_id)) return;
            if (frame.type === 'chunk') this.handle_chunk(session_id, frame);
        });
        const dispose_pre_step = agent.ctx.on('agent/pre-step', async ({ agent: subject, turn, step }, next)=>{
            if (subject === agent && (step === 1 || this.current_turn.get(session_id) !== turn)) {
                if (this.host.tasks?.is_presenting(session_id)) return next();
                await this.begin_turn_once(session_id, turn);
            }
            return next();
        });
        const dispose_turn_stopping = agent.ctx.on('agent/turn-stopping', ({ agent: subject, turn })=>{
            if (subject !== agent) return;
            if (this.host.tasks?.is_presenting(session_id)) return;
            void this.handle_turn_end(session_id, turn);
        });
        const dispose_error = agent.ctx.on('agent/error', ({ error })=>{
            if (this.host.tasks?.is_presenting(session_id)) return;
            const detail = error instanceof Error ? error.message : String(error);
            probe('inbound', 'agent.error', {
                session_id,
                error: detail
            });
            console.error(`[webhook-weixin] agent error session=${session_id}: ${detail}`);
            this.turn_error.set(session_id, detail);
            this.arm_turn_failure(session_id, detail);
            const reason = classify_llm_failure(detail);
            if (reason !== undefined) void this.failover_model(session_id, detail, reason);
        });
        const dispose_compaction = agent.ctx.on('session/event', (session, event)=>{
            if (session !== agent.session) return;
            if (event.type === 'compaction/start') {
                this.compacting_sessions.add(session_id);
                probe('lifecycle', 'compaction.suspend_inbound', {
                    session_id
                });
                return;
            }
            if (event.type !== 'compaction/end') return;
            this.compacting_sessions.delete(session_id);
            this.compact_ack_sent.delete(session_id);
            probe('lifecycle', 'compaction.resume_inbound', {
                session_id
            });
            void this.inbound.recover_unfinished().then((result)=>{
                if (result.recovered > 0) {
                    probe('lifecycle', 'compaction.requeued', {
                        session_id,
                        recovered: result.recovered
                    });
                    void this.outbound.drain();
                }
            }).catch((error)=>{
                probe('lifecycle', 'compaction.requeue_failed', {
                    session_id,
                    error: String(error)
                });
            });
        });
        this.stream_disposers.set(session_id, ()=>{
            dispose();
            dispose_error();
            dispose_pre_step();
            dispose_turn_stopping();
            dispose_compaction();
            ObservationRecorder.forget_session(session_id);
        });
        this.stream_agents.set(session_id, agent);
        probe('lifecycle', 'stream.bound', {
            session_id
        });
    }
    async rescue_interrupted_turns() {
        let rescued = 0;
        for (const item of (await this.store.list_meta_prefix(INFLIGHT_TURN_PREFIX))){
            const session_id = item.key.slice(INFLIGHT_TURN_PREFIX.length);
            let detail = {};
            try {
                detail = JSON.parse(item.value);
            } catch  {}
            await this.store.delete_meta(item.key);
            if (typeof detail.delivery_id !== 'string') continue;
            if (typeof detail.at === 'number' && Date.now() - detail.at < INFLIGHT_RESCUE_MIN_AGE_MS) continue;
            const record = await this.store.get_delivery(detail.delivery_id);
            if (record === undefined || record.status === 'failed_terminal') continue;
            try {
                await this.store.update_delivery(detail.delivery_id, 'received', {
                    last_error: '重启打断了这一轮，自动重投'
                });
                rescued += 1;
                probe('inbound', 'turn.rescued', {
                    session_id,
                    turn: detail.turn,
                    delivery_id: detail.delivery_id
                });
                this.queue_notice({
                    session_id,
                    user_id: record.user_id,
                    kind: 'assistant',
                    text: '刚才那轮被重启打断了，我重跑一遍。'
                });
            } catch (error) {
                probe('inbound', 'turn.rescue_failed', {
                    session_id,
                    delivery_id: detail.delivery_id,
                    error: String(error)
                });
            }
        }
        if (rescued > 0) console.error(`[webhook-weixin] 补跑被打断的轮次：${rescued} 条`);
        return rescued;
    }
    async handle_inbound(messages, cursor) {
        const compacting = [];
        for (const item of messages){
            const session = await this.store.session_id_for(item.user_id);
            if (this.compacting_sessions.has(session)) compacting.push(item);
        }
        if (compacting.length > 0) {
            for (const item of compacting)await this.notify_compacting(item.user_id);
            await this.inbound.handle_batch(messages, cursor, {
                hold: true
            });
            probe('inbound', 'batch.held_for_compaction', {
                count: messages.length
            });
            await this.outbound.drain();
            return false;
        }
        return this.inbound.handle_batch(messages, cursor);
    }
    async notify_compacting(user_id) {
        const key = await this.store.session_id_for(user_id);
        if (this.compact_ack_sent.has(key)) return;
        this.compact_ack_sent.add(key);
        probe('outbound', 'compaction_ack', {
            user_id,
            session_id: key
        });
        this.queue_notice({
            session_id: key,
            user_id,
            kind: 'assistant',
            text: '（正在压缩上下文，稍后回复；你这条已经排上队了）'
        });
    }
    async finalize_turn(session_id) {
        const turn = this.current_turn.get(session_id);
        this.outbound.end_turn(session_id);
        await this.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
        this.turn_error.delete(session_id);
        this.turn_visible.delete(session_id);
        this.clear_turn_failure(session_id);
        this.aggregators.delete(session_id);
        this.tool_calls_seen.delete(session_id);
        this.current_turn.delete(session_id);
        probe('lifecycle', 'turn.finalized_after_cancel', {
            session_id,
            turn
        });
    }
    async begin_turn_once(session_id, turn) {
        const already = await this.turn_context.resolve_async(session_id, turn);
        this.current_turn.set(session_id, turn);
        this.aggregators.set(session_id, new ReplyAggregator());
        this.tool_calls_seen.set(session_id, new Set());
        this.outbound.begin_turn(session_id, turn);
        if (already !== undefined && await this.binding_is_fresh(already.delivery_id)) {
            probe('outbound', 'turn.start_reuse', {
                session_id,
                turn,
                delivery_id: already.delivery_id
            });
            await this.store.set_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`, JSON.stringify({
                turn,
                delivery_id: already.delivery_id,
                at: Date.now()
            }));
            return;
        }
        if (already !== undefined) {
            probe('outbound', 'turn.rebind_stale', {
                session_id,
                turn,
                delivery_id: already.delivery_id
            });
        }
        const latest = await this.store.latest_delivery_for_session(session_id);
        if (latest !== undefined) {
            const delivery = await this.store.get_delivery(latest.delivery_id);
            const context_token = await this.store.delivery_context_token(latest.delivery_id);
            await this.turn_context.bind_async(session_id, turn, {
                delivery_id: latest.delivery_id,
                user_id: delivery?.user_id ?? latest.user_id,
                ...context_token === undefined ? {} : {
                    context_token
                }
            });
        }
        const context = await this.turn_context.resolve_async(session_id, turn);
        probe('outbound', 'turn.start', {
            session_id,
            turn,
            delivery_id: context?.delivery_id,
            has_token: context?.context_token !== undefined
        });
        await this.store.set_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`, JSON.stringify({
            turn,
            delivery_id: context?.delivery_id,
            at: Date.now()
        }));
    }
    async binding_is_fresh(delivery_id) {
        const record = await this.store.get_delivery(delivery_id);
        if (record === undefined) return false;
        return Date.now() - record.received_at < BINDING_TTL_MS;
    }
    async failover_model(session_id, detail, reason) {
        try {
            const config_path = find_model_config(PROJECT_CONFIG_DIR);
            if (config_path === undefined) {
                probe('failover', 'config_missing', {
                    workspace: PROJECT_CONFIG_DIR
                });
                return;
            }
            const config = read_json_file(config_path);
            const failover = parse_failover_config(config);
            if (!failover.enabled) return;
            const current = this.current_model;
            const dead = this.model_health.mark_dead(current, reason, detail, cooldown_ms(reason, failover));
            probe('failover', 'model.dead', {
                provider: current.provider,
                model: current.model,
                reason,
                until: dead.until,
                detail: detail.slice(0, 120)
            });
            const next = next_alive_candidate(failover.order, current, (candidate)=>this.model_health.is_dead(candidate));
            if (next === undefined) {
                probe('failover', 'no_candidate', {
                    tried: current
                });
                const user_id = await this.store.latest_user_id();
                if (user_id !== undefined) {
                    const session_key = await this.store.get_session_id(user_id) ?? session_id;
                    this.queue_notice({
                        session_id: session_key,
                        user_id,
                        kind: 'assistant',
                        text: `配置里的模型接口都不可用了（${current.model}：${detail.slice(0, 80)}）。` + '换个 key 或等额度恢复后我再试；也可以让我用别的模型。'
                    });
                    await this.outbound.drain();
                }
                return;
            }
            const controller = this.ctx.get('sessionController');
            if (controller?.selectModel === undefined) {
                probe('failover', 'controller_missing', {});
                return;
            }
            await controller.selectModel({
                sessionId: brandString(session_id),
                provider: next.provider,
                model: next.model
            });
            this.current_model = {
                provider: next.provider,
                model: next.model
            };
            this.persist_default_model(config_path, config, next);
            probe('failover', 'model.switched', {
                from: `${current.provider}/${current.model}`,
                to: `${next.provider}/${next.model}`,
                reason
            });
            const user_id = await this.store.latest_user_id();
            if (user_id !== undefined) {
                const session_key = await this.store.get_session_id(user_id) ?? session_id;
                this.queue_notice({
                    session_id: session_key,
                    user_id,
                    kind: 'assistant',
                    text: `「${current.model}」这个接口用不了了（${reason === 'quota' ? '额度用完' : reason === 'auth' ? 'key 失效' : '模型下线'}），` + `我先换成「${next.model}」，把你刚才那条重做一遍。`
                });
                await this.outbound.drain();
                await this.retry_last_message(session_id, user_id);
            }
        } catch (error) {
            probe('failover', 'failed', {
                error: String(error).slice(0, 200)
            });
        }
    }
    persist_default_model(config_path, config, next) {
        try {
            const parsed = config;
            parsed.defaultModel = {
                provider: next.provider,
                model: next.model
            };
            parsed.updatedAt = new Date().toISOString();
            copyFileSync(config_path, `${config_path}.bak-failover`);
            writeFileSync(config_path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        } catch (error) {
            probe('failover', 'persist_failed', {
                error: String(error).slice(0, 160)
            });
        }
    }
    remember_user_message(session_id, user_id, text) {
        this.last_user_message.set(session_id, {
            user_id,
            text,
            at: Date.now(),
            retried: false
        });
    }
    async retry_last_message(session_id, user_id) {
        const remembered = this.last_user_message.get(session_id);
        if (remembered === undefined || remembered.text.trim() === '') return;
        if (remembered.retried) {
            probe('failover', 'retry.skipped_already', {
                session_id
            });
            return;
        }
        remembered.retried = true;
        const delivery_id = `retry-${Date.now()}-${randomBytes(3).toString('hex')}`;
        probe('failover', 'retry.start', {
            session_id,
            delivery_id,
            chars: remembered.text.length
        });
        try {
            await this.handle_inbound([
                {
                    delivery_id,
                    user_id,
                    text: remembered.text,
                    media: [],
                    received_at: Date.now()
                }
            ], undefined);
        } catch (error) {
            probe('failover', 'retry.failed', {
                session_id,
                error: String(error).slice(0, 160)
            });
        }
    }
    arm_turn_failure(session_id, detail) {
        const existing = this.turn_failure_timers.get(session_id);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(()=>{
            this.turn_failure_timers.delete(session_id);
            void this.fail_turn(session_id, detail);
        }, AGENT_ERROR_GRACE_MS);
        this.turn_failure_timers.set(session_id, timer);
    }
    clear_turn_failure(session_id) {
        const timer = this.turn_failure_timers.get(session_id);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.turn_failure_timers.delete(session_id);
        }
    }
    explain_llm_failure(detail) {
        const text = detail.toLowerCase();
        if (/connection error|fetch failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|network|transport|proxy/.test(text)) {
            return '这是**网络/接口连接**问题（不是额度）：接口那边这一小会儿没连上或把连接断了。让我重试一般就恢复。';
        }
        if (/quota|insufficient|余额|欠费|限额|额度/.test(text)) {
            return '这是**额度/限额**问题：等额度恢复，或在控制台「模型选择」换一个模型。';
        }
        if (/401|403|unauthor|invalid.*key|api.?key|鉴权|auth/.test(text)) {
            return '这是**鉴权**失败（key 失效或没权限）：需要换 key，或换一个模型。';
        }
        if (/429|rate.?limit|too many|限流/.test(text)) {
            return '这是被**限流**了：稍等一下就好，我可以再试一次。';
        }
        return '可以让我再试一次；如果反复出现，就在控制台「模型选择」换一个模型。';
    }
    async fail_turn(session_id, detail) {
        const turn = this.current_turn.get(session_id);
        if (turn === undefined) return;
        const user_id = (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? '';
        probe('inbound', 'turn.failed', {
            session_id,
            turn,
            detail
        });
        this.turn_error.delete(session_id);
        this.queue_assistant({
            session_id,
            user_id,
            turn,
            text: `我这轮没做成：模型接口报错「${detail.slice(0, 140)}」。\n${this.explain_llm_failure(detail)}`
        });
        await this.handle_turn_end(session_id, turn);
    }
    async handle_turn_end(session_id, turn) {
        this.clear_turn_failure(session_id);
        await this.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
        const error = this.turn_error.get(session_id);
        const visible = this.turn_visible.has(session_id);
        this.turn_error.delete(session_id);
        this.turn_visible.delete(session_id);
        if (error !== undefined && !visible) {
            probe('outbound', 'turn.failed_notice', {
                session_id,
                turn
            });
            this.queue_notice({
                session_id,
                user_id: (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? '',
                kind: 'assistant',
                text: `我这轮没做成：模型接口报错「${error.slice(0, 120)}」。\n${this.explain_llm_failure(error)}`
            });
        }
        const aggregator = this.aggregators.get(session_id);
        this.aggregators.delete(session_id);
        if (aggregator !== undefined) {
            const tail = aggregator.finish();
            if (tail) {
                this.queue_assistant({
                    session_id,
                    user_id: (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? '',
                    turn,
                    text: tail
                });
            }
        }
        this.outbound.end_turn(session_id);
        this.tool_calls_seen.delete(session_id);
        this.current_turn.delete(session_id);
        this.last_progress_at.delete(session_id);
        await this.turn_context.prune_async(session_id);
        await this.outbound.drain();
        probe('outbound', 'turn.done', {
            session_id,
            turn
        });
    }
    handle_chunk(session_id, frame) {
        if (frame.type !== 'chunk') return;
        this.clear_turn_failure(session_id);
        const chunk = frame.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            const aggregator = this.aggregators.get(session_id) ?? new ReplyAggregator();
            this.aggregators.set(session_id, aggregator);
            const turn = this.current_turn.get(session_id) ?? 0;
            for (const segment of aggregator.accept_chunk(chunk.text)){
                this.outbound.note_visible(session_id);
                this.turn_visible.add(session_id);
                this.queue_assistant({
                    session_id,
                    user_id: '',
                    turn,
                    text: segment
                });
            }
            this.outbound.note_visible(session_id);
            void this.outbound.drain();
            return;
        }
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            const aggregator = this.aggregators.get(session_id) ?? new ReplyAggregator();
            this.aggregators.set(session_id, aggregator);
            aggregator.accept_reasoning(chunk.text);
            this.maybe_push_progress(session_id, aggregator);
            return;
        }
        if (chunk?.type === 'tool-call-delta' && typeof chunk.name === 'string' && chunk.name.length > 0) {
            const seen = this.tool_calls_seen.get(session_id) ?? new Set();
            const call_id = typeof chunk.id === 'string' && chunk.id.length > 0 ? chunk.id : `${chunk.name}:${seen.size}`;
            if (seen.has(call_id)) return;
            seen.add(call_id);
            this.tool_calls_seen.set(session_id, seen);
        }
    }
    maybe_push_progress(session_id, aggregator) {
        if (PROGRESS_MIN_INTERVAL_MS <= 0) return;
        const now = Date.now();
        const last = this.last_progress_at.get(session_id) ?? 0;
        if (now - last < PROGRESS_MIN_INTERVAL_MS) return;
        const excerpt = aggregator.take_reasoning_excerpt(120);
        if (excerpt === undefined || excerpt.length < PROGRESS_MIN_CHARS) return;
        const cjk = (excerpt.match(/[\u4e00-\u9fff]/g) ?? []).length;
        if (cjk < PROGRESS_MIN_CHARS) return;
        this.last_progress_at.set(session_id, now);
        this.queue_progress(session_id, `（进度·欣爱在想）${excerpt}`);
        probe('outbound', 'progress.pushed', {
            session_id,
            chars: excerpt.length
        });
        void this.outbound.drain();
    }
    async stop() {
        if (this.stopped && this.running === undefined) return;
        this.stopped = true;
        this.controller.abort();
        await this.running?.catch(()=>undefined);
        this.codex_watcher.stop();
        this.opencode_watcher.stop();
        this.outbound.stop();
        if (this.inject_server !== undefined) {
            this.inject_server.close();
            this.inject_server = undefined;
        }
        this.timeline_scheduler?.stop();
        this.timeline_scheduler = undefined;
        try {
            if (this.timeline instanceof TimelineStore) this.timeline.flush_views();
        } catch (error) {
            probe('timeline', 'flush.failed', {
                error: String(error)
            });
        }
        this.graph_scheduler?.stop();
        this.graph_scheduler = undefined;
        for (const dispose of this.stream_disposers.values())dispose();
        this.stream_disposers.clear();
        this.stream_agents.clear();
        await this.inbound.dispose();
        this.aggregators.clear();
        this.tool_calls_seen.clear();
        await this.outbound.drain().catch(()=>undefined);
        await this.host.dispose_agents();
        for (const dispose of this.observation_disposers)dispose();
        await this.lease.release();
        this.store.close();
        probe('lifecycle', 'connector.stopped');
    }
}
function sleep(ms, signal) {
    return new Promise((resolve)=>{
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, {
            once: true
        });
    });
}
export function install_weixin_connector(ctx, options) {
    const connector = new WeixinConnector(ctx, options);
    ctx.effect(async ()=>{
        const done = probe_timer('lifecycle', 'connector.start');
        try {
            await connector.start();
            done({
                outcome: 'ok'
            });
        } catch (error) {
            probe('lifecycle', 'connector.start_failed', {
                error: error instanceof Error ? error.message : String(error)
            });
            console.error('[webhook-weixin] 连接器启动失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)));
            throw error;
        }
        return ()=>connector.stop();
    }, 'webhook-weixin.lifecycle()');
    return connector;
}
