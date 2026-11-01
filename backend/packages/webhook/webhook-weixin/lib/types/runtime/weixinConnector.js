/**
 * 微信连接器：把传输层、入站协调器、出站协调器与生命周期装配到一起。
 *
 * 重构后的职责边界（设计文档 §3.1）：
 *   WeixinIngress       只拉取/规范化
 *   InboundCoordinator  幂等、路由、控制、投递、恢复
 *   OutboundCoordinator 唯一发送队列（含心跳与恢复）
 *   本文件              只做装配、生命周期与 assistant-stream 桥接
 *
 * 本文件**不再**维护：delivery 去重、user→session 路由、回复缓冲、发送队列、per-session 心跳。
 * @module dsh-webhook-weixin/connector
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { brandString } from '@deepseek-ai/dsh-brand';
import { ObservationRecorder } from '@deepseek-ai/dsh-llm';
import { IlinkClient } from "../api/ilinkClient.js";
import { probe, probe_timer } from "../diagnostics/probe.js";
import { start_inject_server } from "../diagnostics/injectServer.js";
import { clear_directory_contents, delete_session_artifacts, directory_bytes, session_dir_path, session_log_stats, sessions_root, } from "../session/sessionFiles.js";
import { ConsumerLease, preflight_openclaw_isolation } from "../lifecycle/consumerLease.js";
import { CodexBridge, parse_codex_command } from "../coordination/codexBridge.js";
import { CodexWatcher } from "../coordination/codexWatcher.js";
import { OpencodeBridge, parse_opencode_command } from "../coordination/opencodeBridge.js";
import { OpencodeWatcher } from "../coordination/opencodeWatcher.js";
import { InboundCoordinator } from "../coordination/inboundCoordinator.js";
import { OutboundCoordinator } from "../coordination/outboundCoordinator.js";
import { ReplyAggregator } from "../reply/replyAggregator.js";
import { HarnessSessionHost } from "../session/weixinSessionHost.js";
import { migrate_legacy_route_state } from "../state/migrateLegacyRouteState.js";
import { TimelineStore } from "../memory/timelineStore.js";
import { MemoryRemoteClient } from "../memory/memoryRemoteClient.js";
import { register_timeline_tools } from "../memory/timelineTools.js";
import { KnowledgeGraphStore } from "../memory/graphStore.js";
import { register_graph_tools } from "../memory/graphTools.js";
import { start_graph_scheduler } from "../memory/graphScheduler.js";
import { create_gemma_gate } from "../memory/gemmaGate.js";
import { create_notify_settings } from "../coordination/notifySettings.js";
import { register_notify_tools } from "../coordination/notifyTools.js";
import { register_bridge_result_tools } from "../memory/bridgeResultTools.js";
import { register_bridge_session_tools } from "../coordination/bridgeSessionTools.js";
import { kill_external_runs } from "../coordination/externalRuns.js";
import { ModelHealth, classify_llm_failure, cooldown_ms, find_model_config, next_alive_candidate, parse_failover_config, } from "./modelFailover.js";
import { create_gemma_summarizer } from "../memory/gemmaSummarizer.js";
import { create_memory_model } from "../memory/memoryModel.js";
import { start_timeline_scheduler } from "../memory/timelineScheduler.js";
import { set_shared_memory } from "../memory/sharedMemory.js";
import { INFLIGHT_TURN_PREFIX, WeixinStateStore } from "../state/weixinStateStore.js";
import { StateRemoteClient } from "../state/stateRemoteClient.js";
import { TurnContextStore } from "../state/turnContextStore.js";
import { WeixinIngress } from "../transport/weixinIngress.js";
/** 项目目录（启动器注入）；用它定位 `config/modelConfig.json` 等配置文件。 */
const PROJECT_CONFIG_DIR = process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd();
/** 探测某个本地端口是否在监听（用于判断 Gemma 服务是否就绪）。 */
function port_open(port) {
    return new Promise(resolve => {
        const socket = createConnection({ port, host: '127.0.0.1' });
        const finish = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(1_500);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}
/** 退避序列（毫秒）。 */
const BACKOFF_STEPS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
/**
 * 思考摘要推送的最小间隔（毫秒）。
 *
 * 旧逻辑是"每 2 次工具调用推一次"，但很多任务只调 1 次工具（甚至 0 次），
 * 于是用户全程看不到任何进度——明明模型一直在输出思考。
 * 改成按时间驱动：只要距上次推送超过该间隔，就把新累积的思考摘要发一条。
 * 可用 DSH_WEIXIN_PROGRESS_INTERVAL_MS 调整；设为 0 关闭。
 */
const PROGRESS_MIN_INTERVAL_MS = Number(process.env.DSH_WEIXIN_PROGRESS_INTERVAL_MS ?? '25000');
/** 摘要太短就不值得单独发一条（避免刷屏）。 */
const PROGRESS_MIN_CHARS = 12;
/**
 * turn 绑定的有效期（毫秒）。
 * 超过就认为是"重启前遗留的绑定"并强制重绑：turn 号会重复，但 context_token 可能已过期，
 * 复用旧 token 会让回复被判 `prepare failed`。
 */
const BINDING_TTL_MS = Number(process.env.DSH_WEIXIN_BINDING_TTL_MS ?? String(30 * 60_000));
/**
 * agent 报错后等多久没有恢复，就把这一轮按失败收尾（毫秒）。
 *
 * 取 60 秒：harness 的 llm-retry 是"秒级退避重试"，重试成功的话新分片很快就会到；
 * 60 秒还没有任何输出，基本就是额度/鉴权这类**重试也没用**的错误，早点告诉用户。
 */
const AGENT_ERROR_GRACE_MS = Number(process.env.DSH_WEIXIN_AGENT_ERROR_GRACE_MS ?? '60000');
/**
 * 状态库里"这一轮还在进行中"的标记（`inflight_turn:<session_id>` → {turn, delivery_id, at}）。
 *
 * 轮次开始写；**正常结束或用户取消时删**。进程被强杀（重启/崩溃）时会留下残留记录 ——
 * 启动时用它认出"哪一轮没跑完"，把那条 delivery 退回 received 让恢复流程重投。
 * 否则 delivery 停在 injected（终态），恢复流程不看它，用户就只看到"发出去了没回音"。
 * 前缀常量本身定义在 state/weixinStateStore（取消路径也要用，避免两处字符串漂移）。
 */
/** 补跑时的最小冷却：避免把"刚起 5 秒的一轮"误判成被杀掉的。 */
const INFLIGHT_RESCUE_MIN_AGE_MS = 5_000;
/**
 * 账号指纹：给日志/租约用的**不可逆**身份标识。
 *
 * 以前用的是 `token.slice(0, 16)`——那是 token 的明文片段，会出现在探针日志、
 * 租约标记文件和启动日志里，而它们都在项目目录内（会被一起拷走）。
 * 现在改成 sha256 前 12 位：同一账号稳定可区分，但反推不出 token。
 *
 * @param token - 微信 bot token；缺失时返回 `'unknown'`。
 */
function account_fingerprint(token) {
    if (token === undefined || token === '')
        return 'unknown';
    return 'acct-' + createHash('sha256').update(token).digest('hex').slice(0, 12);
}
/** 读一个 JSON 文件；读不到或坏了返回空对象（调用方都按"缺省"处理）。 */
function read_json_file(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return {};
    }
}
/** 微信连接器：装配 + 生命周期。 */
export class WeixinConnector {
    /** 本地 SQLite 或远程 state API；远程模式下所有调用点必须等待可能的 Promise。 */
    store;
    /** 是否使用远程状态服务；用于选择同步兼容入口或真正等待的异步入口。 */
    remote_state;
    turn_context;
    ingress;
    inbound;
    outbound;
    host;
    lease;
    client;
    /** Codex 远程桥（`/codex` 指令）。 */
    codex_bridge;
    /** Codex 任务完成监视器：任务一结束就主动推微信。 */
    codex_watcher;
    /** opencode 远程桥（`/opencode` 指令）。 */
    opencode_bridge;
    /** opencode 完成监视器：只汇报外部发起的任务。 */
    opencode_watcher;
    controller = new AbortController();
    stream_disposers = new Map();
    stream_agents = new Map();
    observation_disposers;
    /** 每个 Stream 的工具调用计数（用于"每 N 次工具调用推一次摘要"）。 */
    tool_calls_seen = new Map();
    /**
     * 每个 Session 当前所在的 turn。
     * 只有 `start` 帧带 `turn`；`chunk`/`end` 帧不带，因此必须记住最近一次的 turn，
     * 否则 turn context 会全部绑到 0（绑定/查询错位）。
     */
    current_turn = new Map();
    /**
     * 待定的"这一轮失败了"收尾定时器（agent 报错后等宽限期，没有恢复就收尾）。
     * 没有它的话，模型持续报错时这一轮会永远停在"处理中"。
     */
    turn_failure_timers = new Map();
    /** 当前在用的模型（故障转移会改它；初值来自配置）。 */
    current_model = { provider: '', model: '' };
    /** 模型健康表：失活的 API 在冷却期内不再被选。 */
    model_health = new ModelHealth();
    /** 每个会话最近一条用户消息（换模型后要重做它）。 */
    last_user_message = new Map();
    /** 本轮是否报过错（用于"整轮失败却一个字都没发"时补一条说明）。 */
    turn_error = new Map();
    /** 本轮有没有成功发出过正文。 */
    turn_visible = new Set();
    /**
     * 正在压缩上下文的会话（`session_id`）。
     *
     * 压缩要读完整段历史（实测 1–3 分钟），这期间**不应该再往会话里塞新消息**：
     * 否则新消息会和压缩抢同一个会话、甚至被压缩吞掉。做法是期间的新消息只入库不投递
     * （`handle_batch(..., { hold: true })`），压缩结束后由恢复流程统一重投。
     */
    compacting_sessions = new Set();
    /** 压缩期间已经回过"稍后回复"的会话（同一个压缩窗口只回一次，别刷屏）。 */
    compact_ack_sent = new Set();
    /** 每个 Session 上次推送思考摘要的时间（进度节流）。 */
    last_progress_at = new Map();
    aggregators = new Map();
    running;
    stopped = false;
    /** 本机调试注入口（仅当设置 DSH_WEIXIN_INJECT_PORT 时启用）。 */
    inject_server;
    /** 长期记忆（时间线）；DSH_TIMELINE_ENABLED=0 可整体关闭。 */
    timeline;
    /** 知识图谱（社交网络）：人物 + "谁称呼谁为什么"的有向边。 */
    graph;
    /** 会话工作目录（会话落盘路径由它推导，必须与 HarnessSessionHost 一致）。 */
    workspace_path = process.cwd();
    /** 通知开关：codex / opencode 的完成汇报是否推送。 */
    notify;
    /** 摘要调度器（低频、纯本地检查；与 iLink 轮询无关）。 */
    timeline_scheduler;
    /** 知识图谱的空闲增量更新调度器。 */
    graph_scheduler;
    /**
     * 记忆更新的模型客户端：本地 Gemma 或云端模型（由 `DSH_MEMORY_ENGINE` 决定）。
     *
     * 本地免费但要占约 5.3GB 显存；云端不占显存但花额度。用户可在控制台切换。
     */
    memory;
    /**
     * 后台任务的闸门（摘要 / 图谱 / 图片描述共用）。
     *
     * 本地引擎：并发 1 + **等显存空闲再启动**（用户可能在跑游戏/训练）；
     * 云端引擎：不等显存（本来就不占），但同样限制并发，避免把额度打爆。
     */
    gemma;
    /** 组装全部组件；构造期不做 IO 失败判定。 */
    /** 宿主 ctx（故障转移要经它取 sessionController）。 */
    ctx;
    constructor(ctx, options) {
        this.ctx = ctx;
        // 复用已提交事件；全局监听同时覆盖 QQ 和后台会话，不注册第二个遥测后端。
        this.observation_disposers = [
            ctx.on('session/event', (session, event) => {
                try {
                    ObservationRecorder.observe_event(String(session.id), event);
                }
                catch { /* 观测失败不能中断会话。 */ }
            }),
            ctx.on('session/disposed', session => { ObservationRecorder.forget_session(String(session.id)); }),
        ];
        const db_path = options.state_db ?? join(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')), 'weixin-state.db');
        const remote_state = process.env.SYNLOVE_STATE_MODE === 'remote';
        this.remote_state = remote_state;
        this.store = remote_state
            ? new StateRemoteClient()
            : new WeixinStateStore({ path: db_path });
        if (!remote_state) {
            // 阶段 5：把旧 JSON 路由状态迁移进 SQLite（只在目标库为空时执行；失败 fail closed）。
            // 旧文件保持只读，迁移会先复制一份 .migrated-<时间戳> 副本。
            const legacy_path = options.state_file
                ?? join(process.env.DSH_WEIXIN_STATE_FILE ?? join(process.cwd(), 'runtime', 'weixin-route-state.json'));
            const migration = migrate_legacy_route_state(this.store, legacy_path);
            probe('lifecycle', 'migration.result', { ...migration });
        }
        else {
            probe('lifecycle', 'state.remote', { base_url: process.env.SYNLOVE_STATE_BASE_URL ?? 'default' });
        }
        this.turn_context = new TurnContextStore(this.store);
        // 长期记忆（时间线）：默认开启，写到 ~/.dsh/timeline（可用 DSH_TIMELINE_DIR 改）。
        const timeline_enabled = process.env.DSH_TIMELINE_ENABLED !== '0';
        const remote_timeline = process.env.SYNLOVE_MEMORY_TIMELINE_MODE === 'remote';
        const remote_memory = remote_timeline ? new MemoryRemoteClient() : undefined;
        this.timeline = timeline_enabled
            ? remote_timeline
                ? remote_memory
                : new TimelineStore({
                    dir: options.timeline_dir
                        ?? process.env.DSH_TIMELINE_DIR
                        ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'timeline'),
                    ...process.env.DSH_TIMELINE_TIMEZONE === undefined
                        ? {}
                        : { timezone: process.env.DSH_TIMELINE_TIMEZONE },
                })
            : undefined;
        // 知识图谱与时间线同级存放（默认 ~/.dsh/graph）。
        this.graph = remote_memory ?? new KnowledgeGraphStore({
            dir: options.graph_dir
                ?? process.env.DSH_GRAPH_DIR
                ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'graph'),
        });
        // 把时间线+图谱共享给 QQ 等其它通道：QQ 只写记录、装查询工具，
        // 摘要/图谱更新仍由本连接器里的调度器统一做（避免双实例双写）。
        if (this.timeline !== undefined)
            set_shared_memory({ timeline: this.timeline, graph: this.graph });
        // 启动即把中心建好（幂等）：欣爱为绝对中心，另有主人节点与两人互相的称呼。
        // 不等到第一次空闲更新——否则刚启动时查询工具会告"图谱里还没有任何人物"。
        try {
            const center_result = this.graph.ensure_center();
            if (center_result instanceof Promise) {
                void center_result.catch(error => probe('graph', 'center.failed', { error: String(error) }));
            }
            probe('graph', 'center.ready', { remote: this.graph instanceof MemoryRemoteClient });
        }
        catch (error) {
            probe('graph', 'center.failed', { error: String(error) });
        }
        // 通知开关（codex / opencode 的完成汇报是否推送），存在状态库 meta 里。
        this.notify = create_notify_settings(this.store);
        // 记忆更新引擎：本地 Gemma（默认）或云端模型。后者在显存被占用时也能推进记忆。
        const engine = process.env.DSH_MEMORY_ENGINE === 'cloud' ? 'cloud' : 'gemma';
        this.memory = create_memory_model({
            engine,
            ...process.env.DSH_MEMORY_CLOUD_MODEL === undefined
                ? {}
                : { cloud_model: process.env.DSH_MEMORY_CLOUD_MODEL },
            // 同一个"路径要带 config/ 子目录"的坑：找不到就交给记忆模型自己回退到本地引擎
            config_path: find_model_config(PROJECT_CONFIG_DIR) ?? join(PROJECT_CONFIG_DIR, 'config', 'modelConfig.json'),
        });
        this.gemma = create_gemma_gate({
            // 只有本地引擎才需要等显存（云端不占显存，等了也没意义）
            min_free_vram_mb: engine === 'gemma' && process.env.SYNLOVE_LLM_MANAGEMENT !== 'external'
                ? Number(process.env.DSH_GEMMA_MIN_FREE_VRAM_MB ?? '5200')
                : 0,
            ...engine === 'gemma' && process.env.SYNLOVE_LLM_MANAGEMENT !== 'external'
                ? { ensure_ready: () => this.ensure_gemma_running() } : {},
        });
        probe('lifecycle', 'memory_engine', { engine, label: this.memory.label });
        this.client = new IlinkClient(options);
        // 会话文件的工程目录名由 cwd 推导，必须和 HarnessSessionHost 用的是同一个值。
        this.workspace_path = options.workspace_path ?? process.cwd();
        // 当前模型：故障转移的起点（之后由 selectModel 改动）
        this.current_model = {
            provider: options.provider ?? '',
            model: options.model ?? '',
        };
        this.host = new HarnessSessionHost(ctx, {
            ...options.agent_preset === undefined ? {} : { agent_preset: options.agent_preset },
            workspace_path: options.workspace_path ?? process.cwd(),
            ...options.provider === undefined ? {} : { provider: options.provider },
            ...options.model === undefined ? {} : { model: options.model },
            ...options.reasoning_effort === undefined ? {} : { reasoning_effort: options.reasoning_effort },
        });
        this.lease = new ConsumerLease({
            store: this.store,
            // 租约身份**不要用 token 片段**：日志、探针、租约标记文件里都会写它，
            // 而这些文件就在项目内（随项目一起被拷走/备份）。用不可逆哈希，既能区分账号，
            // 又不泄漏 token 的任何字符。
            account_id: account_fingerprint(options.token),
            ...options.lease_marker === undefined ? {} : { marker_path: options.lease_marker },
        });
        this.ingress = new WeixinIngress({
            client: this.client,
            observer: {
                on_error: error => probe('ingress', 'observer.error', { error: String(error) }),
                on_status: (status, detail) => probe('ingress', 'observer.status', { status, detail }),
            },
        });
        this.outbound = new OutboundCoordinator({
            store: this.store,
            turn_context: this.turn_context,
            sender: async (input) => {
                if (!await this.lease.is_held())
                    throw new Error('微信消费者所有权已丢失，停止发送');
                await this.client.send_message_with_retry({
                    to_user_id: input.user_id,
                    text: input.text,
                    client_id: input.client_id,
                    ...input.context_token === undefined ? {} : { context_token: input.context_token },
                });
            },
            record_entry: entry => this.record_timeline(entry),
            classify_retryable: error => {
                const retryable = error?.retryable;
                // 明确标注不可重试才放弃；未标注的按可重试处理（网络抖动居多）。
                return retryable !== false;
            },
        });
        const attachments = ctx.get('attachments');
        // Codex 远程桥：`/codex ...` 由它处理，输出通过同一 outbox 主动推回微信。
        this.codex_bridge = new CodexBridge(this.store, (user_id, session_id, text, kind, context_token) => {
            this.queue_notice({
                session_id,
                user_id,
                kind,
                text,
                ...context_token === undefined ? {} : { context_token },
            });
            void this.outbound.drain();
        }, options.codex_workspace ?? process.env.DSH_CODEX_WORKSPACE);
        // opencode 远程桥：`/opencode ...` 由它处理，输出主动推微信（带硬超时）。
        this.opencode_bridge = new OpencodeBridge(this.store, (user_id, session_id, text, kind, context_token) => {
            this.queue_notice({
                session_id, user_id, kind, text,
                ...context_token === undefined ? {} : { context_token },
            });
            void this.outbound.drain();
        });
        // opencode 完成监视器：只汇报"外部发起"的 opencode 任务（微信发起的由桥自己汇报）。
        this.opencode_watcher = new OpencodeWatcher({
            store: this.store,
            push: async (user_id, text) => {
                // 用户可以用 notify_control 关掉这类被动汇报（真实对话回复不受影响）。
                const enabled = this.notify.is_enabled_async === undefined
                    ? this.notify.is_enabled('opencode')
                    : await this.notify.is_enabled_async('opencode');
                if (!enabled) {
                    probe('opencode-watch', 'notify.suppressed');
                    return;
                }
                const session_id = await this.store.get_session_id(user_id) ?? `weixin-${user_id}`;
                this.queue_notice({ session_id, user_id, kind: 'assistant', text });
                await this.outbound.drain();
            },
        });
        // Codex 完成监视器：轮询 ~/.codex 的会话状态，任务结束就通过 outbox 主动推微信。
        this.codex_watcher = new CodexWatcher({
            store: this.store,
            push: async (user_id, text) => {
                const enabled = this.notify.is_enabled_async === undefined
                    ? this.notify.is_enabled('codex')
                    : await this.notify.is_enabled_async('codex');
                if (!enabled) {
                    probe('codex-watch', 'notify.suppressed');
                    return;
                }
                const session_id = await this.store.get_session_id(user_id) ?? `weixin-${user_id}`;
                this.queue_notice({ session_id, user_id, kind: 'assistant', text });
                await this.outbound.drain();
            },
        });
        this.inbound = new InboundCoordinator({
            store: this.store,
            turn_context: this.turn_context,
            host: this.host,
            ...attachments === undefined ? {} : { attachments },
            enqueue_outbound: input => { this.queue_notice(input); },
            // 媒体回传：iLink 目前只提供 send_image（图片），文件类走文本提示
            send_media: async (user_id, path, context_token) => {
                if (!await this.lease.is_held())
                    throw new Error('微信消费者所有权已丢失，停止发送媒体');
                const { readFile } = await import('node:fs/promises');
                const data = new Uint8Array(await readFile(path));
                if (!await this.lease.is_held())
                    throw new Error('微信消费者所有权已丢失，停止发送媒体');
                await this.client.send_image({
                    to_user_id: user_id,
                    data,
                    ...context_token === undefined ? {} : { context_token },
                });
                probe('outbound', 'weixin.send_image', { user_id, bytes: data.byteLength });
            },
            on_agent_ready: agent => { this.bind_agent_stream(agent); },
            on_user_message: (session_id, user_id, text) => { this.remember_user_message(session_id, user_id, text); },
            // 用户说"停止"：除了取消模型那一轮，还要**真的把外部任务杀掉**
            // （桥里的任务 + 模型用工具起的 opencode/codex 进程）。
            on_cancel: async (user_id) => {
                this.opencode_bridge.stop(user_id);
                this.codex_bridge.stop(user_id);
                const result = kill_external_runs();
                probe('inbound', 'cancel.external_runs', { user_id, killed: result.killed, pids: [...result.pids] });
                return { killed: result.killed, pids: result.pids };
            },
            // 取消后的收尾（abort 路径不会触发 agent/turn-stopping，必须在这里补：
            // 停心跳、清 inflight 标记、清聚合器，避免"还在处理中"和"取消的任务被复活"）。
            on_turn_cancelled: session_id => { void this.finalize_turn(session_id); },
            codex_bridge: {
                parse: text => parse_codex_command(text),
                handle: (user_id, session_id, command, context_token) => this.codex_bridge.handle(user_id, session_id, command, context_token),
            },
            opencode_bridge: {
                parse: text => parse_opencode_command(text),
                handle: (user_id, session_id, command, context_token) => this.opencode_bridge.handle(user_id, session_id, command, context_token),
            },
            // 媒体补全真正接上：不接的话图片/文件/语音只会变成 `[微信媒体 image]` 占位文字。
            // 顺带把媒体记进长期记忆（原图存附件库、只留引用；描述后台补写）。
            hydrate_message: async (message) => {
                const hydrated = await this.ingress.media_normalizer.hydrate_media(message, media => this.ingress.download_media(media));
                await this.record_media_to_timeline(hydrated, attachments).catch(error => {
                    probe('timeline', 'media.record_failed', { error: String(error) });
                });
                return hydrated;
            },
            // 长期记忆：用户上行落盘（幂等，重放不会重复记）。
            record_entry: entry => this.record_timeline(entry),
        });
        probe('lifecycle', 'connector.constructed', {
            db_path, preset: options.agent_preset ?? '(default)', workspace: options.workspace_path,
        });
    }
    /** 入队通知；远程状态模式等待 outbox 与 token 的异步提交。 */
    queue_notice(input) {
        if (this.remote_state)
            void this.outbound.enqueue_notice_async(input);
        else
            this.outbound.enqueue_notice(input);
    }
    /** 入队正式回复；远程状态模式等待轮次上下文和 outbox 提交。 */
    queue_assistant(input) {
        if (this.remote_state)
            void this.outbound.enqueue_assistant_async(input);
        else
            this.outbound.enqueue_assistant(input);
    }
    /** 入队思考进度；远程状态模式等待状态服务写入。 */
    queue_progress(session_id, text) {
        if (this.remote_state)
            void this.outbound.enqueue_progress_async(session_id, text);
        else
            this.outbound.enqueue_progress(session_id, text);
    }
    /**
     * 启动：preflight → 装配检查 → lease → 恢复 → 开轮询。
     * 任一步失败都抛出，让上层把"微信消费者未启动"如实暴露出来（禁止假成功）。
     */
    async start() {
        if (this.running !== undefined)
            return this.running;
        this.running = this.run();
        return this.running;
    }
    /** 真正的启动序列。 */
    async run() {
        // 1. OpenClaw 隔离 preflight（设计文档 §9.2）。
        if (process.env.DSH_WEIXIN_SKIP_OPENCLAW_CHECK !== '1') {
            const isolation = preflight_openclaw_isolation();
            if (!isolation.ok) {
                throw new Error('webhook-weixin: OpenClaw 隔离检查未通过，拒绝启动：\n  - ' + isolation.problems.join('\n  - ')
                    + '\n请先停用 OpenClaw 的微信通道（openclaw-weixin.enabled=false）。');
            }
        }
        // 2. Harness 能力装配检查（设计文档 §9.3）。
        this.host.assert_capabilities();
        // 3. 原子 lease（失败必须致命）。
        await this.lease.acquire();
        // 4. 上次进程死在一轮中途？先把那些 delivery 退回 received，让下面的恢复流程把它们重投。
        //    为什么需要：进程被强杀时 delivery 已经是 injected（终态），恢复流程不会再看它，
        //    用户就只看到"发出去没回音"（实测：重启撞进行中一轮 = 静默丢消息）。
        const rescued = await this.rescue_interrupted_turns();
        // 5. 恢复未完成状态。
        const recovered = await this.inbound.recover_unfinished();
        const pending = await this.outbound.recover_pending();
        probe('lifecycle', 'recover.summary', { ...recovered, outbox_pending: pending, rescued_turns: rescued });
        console.error(`[webhook-weixin] 启动恢复：delivery=${recovered.recovered} outbox=${pending}`
            + `${rescued > 0 ? `，补跑被打断的轮次=${rescued}` : ''}；` +
            `状态快照 ${JSON.stringify(await this.store.snapshot())}`);
        // 4.5 启动完成监视（被动通知：外部发起的任务一结束就推微信）。
        // 注意分工：微信 `/codex` `/opencode` 发起的任务由各自桥汇报，监视器只盯外部发起的。
        this.codex_watcher.start();
        this.opencode_watcher.start();
        // 4.6 本机调试注入口（默认关闭；仅在显式设置 DSH_WEIXIN_INJECT_PORT 时开启）。
        this.start_inject_server_if_configured();
        // 4.7 长期记忆摘要调度（低频、纯本地，与 iLink 轮询解耦）。
        this.start_timeline_scheduler_if_enabled();
        // 5. 通知上线并开始轮询。
        try {
            await this.ingress.notify_start(this.controller.signal);
            await this.poll_loop();
        }
        finally {
            await this.ingress.notify_stop(this.controller.signal);
        }
    }
    /**
     * 启动本机注入口（开发设施，默认关闭）。
     *
     * 用途：把一条"用户消息"塞进真实入站管线（delivery → 协调器 → agent → outbox → 微信），
     * 这样测试时不必每次都用真手机发微信。只绑 127.0.0.1，且只有设置端口才启用。
     */
    start_inject_server_if_configured() {
        const port = Number(process.env.DSH_WEIXIN_INJECT_PORT ?? '0');
        if (!Number.isInteger(port) || port <= 0)
            return;
        this.inject_server = start_inject_server({
            port,
            inject: input => this.inject_test_message(input),
            admin: (action, body) => this.admin_action(action, body),
        });
    }
    /**
     * 管理动作分发（控制台按钮走这里）。
     *
     * 之所以由本进程执行而不是让控制台直接删文件：时间线/图谱有内存缓存、
     * 会话上下文还被 agent 句柄持有——只有持有者才知道该怎么正确清。
     */
    async admin_action(action, body) {
        const user_id = typeof body.user_id === 'string' && body.user_id !== '' ? body.user_id : undefined;
        switch (action) {
            case 'clear-context':
                return this.clear_context(user_id === undefined ? {} : { user_id });
            case 'clear-memory': {
                const target = String(body.target ?? '');
                if (target !== 'timeline' && target !== 'graph') {
                    throw new Error(`clear-memory 的 target 只能是 timeline 或 graph，收到：${target}`);
                }
                return await this.clear_memory(target);
            }
            case 'memory-stats':
                return await this.memory_stats();
            case 'clear-queue':
                return { removed: await this.store.clear_queue() };
            case 'failover-status': {
                const path = find_model_config(PROJECT_CONFIG_DIR);
                const config = path === undefined ? {} : read_json_file(path);
                return {
                    current: this.current_model,
                    order: parse_failover_config(config).order,
                    dead: this.model_health.snapshot(),
                };
            }
            case 'reload-preset':
                return this.reload_preset();
            default:
                throw new Error(`未知的管理动作：${action}`);
        }
    }
    /**
     * 清空长期记忆。
     *
     * - `timeline`：删掉时间线目录内容，并清掉存储层的内存缓存（否则还会列出已删的天）；
     * - `graph`：删掉图谱目录内容 → **重建中心**（欣爱 + 主人，否则查询会说"图谱里没有人"）
     *   → 水位归零（让图谱从现有历史里重新长出来）。
     *
     * 与"清空上下文"是两件事：这里清的是"她长期记得什么"，上下文是"这次聊天记得什么"。
     */
    async clear_memory(target) {
        if (target === 'timeline') {
            if (this.timeline === undefined) {
                return { target, files: 0, bytes: 0, dir: '', note: '时间线记忆未启用（DSH_TIMELINE_ENABLED=0）' };
            }
            if (!(this.timeline instanceof TimelineStore)) {
                return { target, files: 0, bytes: 0, dir: 'remote', note: '远程时间线必须由 memory 服务执行清空；本地控制器不会绕过 API 删除服务端数据' };
            }
            const removed = clear_directory_contents(this.timeline.dir_path());
            // 清空会把 days/ 一起删掉；store 是长驻实例，必须显式重建目录，
            // 否则下一次记录会 ENOENT（2026-09-21 23:46 那轮踩过）。
            this.timeline.ensure_dirs();
            this.timeline.forget_caches();
            probe('memory', 'timeline.cleared', { ...removed });
            return { target, ...removed };
        }
        if (!(this.graph instanceof KnowledgeGraphStore)) {
            return { target, files: 0, bytes: 0, dir: 'remote', note: '远程图谱必须由 memory 服务执行清空；本地控制器不会绕过 API 删除服务端数据' };
        }
        const removed = clear_directory_contents(this.graph.dir_path());
        this.graph.ensure_center();
        this.graph.reset_watermark();
        probe('memory', 'graph.cleared', { ...removed });
        return {
            target, ...removed,
            note: `已重建中心（欣爱 · 主人），并归零水位；下次空闲时会从现有历史里重新积累`,
        };
    }
    /**
     * 三类记忆的体量（控制台展示用）。
     *
     * 上下文的体量按**落盘会话文件**算（用户 id → 会话 id → 会话目录），
     * 所以它显示的是真实占用，而不是一个估计值。
     */
    async memory_stats() {
        const stats = this.timeline === undefined
            ? { error: '时间线记忆未启用' }
            : this.timeline instanceof MemoryRemoteClient
                ? (() => {
                    return { error: '时间线由远程 memory 服务托管；目录大小由服务端统计' };
                })()
                : (() => {
                    const summary = this.timeline.stats();
                    return {
                        days: summary.days ?? 0,
                        entries: summary.entries ?? 0,
                        bytes: directory_bytes(this.timeline.dir_path()),
                        dir: this.timeline.dir_path(),
                    };
                })();
        const graph_stats = this.graph instanceof MemoryRemoteClient
            ? { error: '图谱由远程 memory 服务托管；目录大小由服务端统计' }
            : (() => {
                const summary = this.graph.stats();
                return {
                    people: summary.people,
                    relations: summary.relations,
                    bytes: directory_bytes(this.graph.dir_path()),
                    dir: this.graph.dir_path(),
                };
            })();
        const root = sessions_root();
        const users = [];
        for (const user_id of await this.store.list_users()) {
            const route = await this.store.get_session_id(user_id);
            const session_id = route ?? await this.store.session_id_for(user_id);
            const log = session_log_stats(session_dir_path(root, this.workspace_path, session_id));
            users.push({
                user_id,
                session_id,
                epoch: await this.store.context_epoch(user_id),
                online: this.host.get_agent(brandString(session_id)) !== undefined,
                bytes: log?.bytes ?? 0,
                modified_at: log?.modified_at ?? 0,
            });
        }
        return {
            timeline: stats,
            graph: graph_stats,
            context: { users, bytes: users.reduce((sum, item) => sum + item.bytes, 0) },
        };
    }
    /**
     * 清空对话上下文（控制台「清空上下文」按钮调这里）。
     *
     * 四步，顺序不能换：
     * 1. **dispose agent**：只有 owner 释放才会关掉会话日志的写句柄。
     *    若跳过这步直接删文件，残留句柄下次 append 会写出"没有 header 的坏文件"——
     *    那个会话以后再也恢复不起来（这是实测踩过的坑）。
     * 2. 丢掉该会话的内存残留（stream/turn/聚合器）。
     * 3. **尽力删除旧会话文件**：回收磁盘；删不掉也不影响结果（见第 4 步）。
     * 4. **清路由 + 代次 +1**：下一条消息因此拿到一个新会话 id → 必然是空上下文。
     *
     * 长期记忆（时间线/图谱）**不动**：上下文是"这次聊天记得什么"，
     * 长期记忆是"她这个人记得什么"，两者是分开的，各有各的清空入口。
     */
    async clear_context(input) {
        const users = input.user_id === undefined || input.user_id === ''
            ? await this.store.list_users()
            : [input.user_id];
        const epochs = {};
        const results = [];
        for (const user_id of users) {
            const session_id = await this.store.get_session_id(user_id)
                ?? await this.store.session_id_for(user_id);
            const disposed = await this.host.dispose_agent(session_id);
            this.forget_session(session_id);
            const deletion = delete_session_artifacts({
                root: sessions_root(),
                cwd: this.workspace_path,
                id: session_id,
            });
            await this.store.clear_session_id(user_id);
            epochs[user_id] = await this.store.bump_context_epoch(user_id);
            results.push({
                user_id,
                session_id,
                disposed,
                deleted: deletion.deleted,
                ...deletion.reason === undefined ? {} : { note: deletion.reason },
            });
            probe('lifecycle', 'context.cleared', {
                user_id, session_id, disposed, deleted: deletion.deleted, epoch: epochs[user_id],
            });
        }
        return { users: results, epochs };
    }
    /**
     * 重新解析 preset（GUI 挂载/卸载工具后调用），并**真的验证一次**。
     *
     * 为什么要在本进程做：preset 组合是宿主实例记忆的，必须由持有它的进程重置。
     * 验证方式是用一个探针会话真创建一次 Agent —— preset 里挂了个缺依赖的插件时，
     * 失败会在这里暴露（而不是等到用户下一条消息才发现 bot 不回话了），
     * 验证完立刻释放并删掉探针会话文件，不留痕迹。
     */
    async reload_preset() {
        this.host.reset_composition();
        const probe_id = `preset-check-${Date.now().toString(36)}`;
        let failure = '';
        try {
            const agent = await this.host.create_agent(brandString(probe_id));
            // 复现真实的 QQ 先注册、微信后绑定路径；不注入消息、不调用模型、不外发。
            if (this.timeline !== undefined) {
                register_timeline_tools(agent.ctx, this.timeline);
                register_graph_tools(agent.ctx, this.graph);
            }
            this.bind_agent_stream(agent);
            this.bind_agent_stream(agent);
        }
        catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
        finally {
            this.forget_session(probe_id);
            await this.host.dispose_agent(probe_id);
            delete_session_artifacts({ root: sessions_root(), cwd: this.workspace_path, id: probe_id });
        }
        if (failure !== '') {
            probe('lifecycle', 'preset.reload_failed', { error: failure });
            throw new Error(`preset 组装失败，已回滚：${failure}`);
        }
        probe('lifecycle', 'preset.reloaded', {});
        return { reloaded: true, routing_checked: true };
    }
    /** 丢掉某个会话在内存里的残留状态（上下文已经清掉，这些映射不能再留着）。 */
    forget_session(session_id) {
        try {
            this.stream_disposers.get(session_id)?.();
        }
        catch (error) {
            probe('lifecycle', 'context.dispose_failed', { session_id, error: String(error) });
        }
        this.stream_disposers.delete(session_id);
        this.stream_agents.delete(session_id);
        this.tool_calls_seen.delete(session_id);
        this.current_turn.delete(session_id);
        this.last_progress_at.delete(session_id);
        this.aggregators.delete(session_id);
    }
    /** 注入一条测试消息：复用真实入站管线，但不提交 iLink 游标（它本来就不是 iLink 来的）。 */
    async inject_test_message(input) {
        const user_id = input.user_id ?? await this.store.latest_user_id();
        if (user_id === undefined) {
            throw new Error('还没有任何入站用户，无法确定收件人；请先用真实微信发一条消息');
        }
        const delivery_id = `inject-${Date.now()}-${randomBytes(4).toString('hex')}`;
        probe('inbound', 'inject.accepted', {
            delivery_id, user_id, text_len: input.text.length, text: input.text.slice(0, 120),
        });
        await this.handle_inbound([{
                delivery_id,
                user_id,
                text: input.text,
                media: [],
                received_at: Date.now(),
            }], undefined);
        const route = await this.store.get_session_id(user_id);
        return {
            delivery_id,
            ...(route === undefined ? {} : { session_id: route }),
        };
    }
    /**
     * 把消息里的媒体记进长期记忆。
     *
     * 分两步，且都**不阻塞**用户这条消息的处理：
     * 1. 解析出附件引用（原图由 harness 附件服务按内容寻址存好，天然去重），
     *    把引用挂到当天那条记录上——**不复制文件**，所以"存原图"几乎零成本；
     * 2. 后台让视觉模型（Gemma + mmproj）写一句描述，回填到引用上——
     *    描述让"发了什么图"变成可检索文本，并会随当天摘要一起被总结。
     *
     * 原图永远是权威：描述错了、模型不在线，都不影响原始事实已经存下来了。
     */
    async record_media_to_timeline(message, attachments) {
        if (this.timeline === undefined || attachments === undefined)
            return;
        const images = message.media.filter(item => item.kind === 'image' && item.data !== undefined);
        if (images.length === 0)
            return;
        const date = this.timeline.day_key(message.received_at);
        const refs = [];
        for (const item of images) {
            try {
                const ref = await attachments.saveImage({
                    data: item.data,
                    mediaType: (item.mime_type ?? 'image/jpeg'),
                    ...item.name === undefined ? {} : { name: item.name },
                });
                refs.push({
                    id: String(ref.attachmentId),
                    media_type: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...ref.name === undefined ? {} : { name: ref.name },
                });
            }
            catch (error) {
                probe('timeline', 'media.save_failed', { error: String(error) });
            }
        }
        if (refs.length === 0)
            return;
        await this.timeline.update_entry(date, message.delivery_id, { attachments: refs });
        probe('timeline', 'media.recorded', { date, delivery_id: message.delivery_id, count: refs.length });
        // 后台补描述：失败只留痕（原图已经在附件库里，不会因为描述失败而丢）。
        for (const [index, item] of images.entries()) {
            const ref = refs[index];
            if (ref === undefined)
                continue;
            void this.describe_image(item, date, message.delivery_id, ref.id);
        }
    }
    /** 让视觉模型给一张图写一句描述并回填；全程 best-effort。 */
    async describe_image(media, date, entry_id, attachment_id) {
        if (this.timeline === undefined || media.data === undefined)
            return;
        try {
            // 图片描述也走同一个闸门与同一个引擎（本地 Gemma 需等显存；云端则直接调）。
            const text = await this.gemma.run('image-describe', () => this.memory.describe_image({
                data: media.data,
                media_type: media.mime_type ?? 'image/jpeg',
            }));
            if (text.trim() === '')
                return;
            await this.timeline.update_attachment_description(date, entry_id, attachment_id, text.trim());
        }
        catch (error) {
            probe('timeline', 'media.describe_failed', { attachment_id, error: String(error) });
        }
    }
    /** 写一条长期记忆；失败只留痕，绝不影响消息收发。 */
    async record_timeline(entry) {
        if (this.timeline === undefined)
            return;
        try {
            await this.timeline.append(entry);
        }
        catch (error) {
            probe('timeline', 'append.failed', { id: entry.id, error: String(error) });
        }
    }
    /**
     * 启动时间线摘要调度（低频、纯本地）。
     *
     * 刻意与 iLink 轮询解耦：这里只读本地文件，不发任何微信请求；
     * 触发条件是"某日已空闲 ≥3 小时"，所以 5 分钟看一次足够，也不会给微信链路添压力。
     */
    start_timeline_scheduler_if_enabled() {
        if (this.timeline === undefined)
            return;
        // 三条后台链路（摘要 / 图谱 / 图片描述）共用**同一个闸门**：
        // 用本地 Gemma 时只有一份显存，并发只会互相拖慢、还可能重复冷启动。
        // 用云端模型时不占显存，闸门也不再等显存（但保留并发上限，避免把额度打爆）。
        const summarize = create_gemma_summarizer({
            complete: (prompt, max_tokens) => this.memory.complete(prompt, max_tokens),
        });
        this.timeline_scheduler = start_timeline_scheduler({
            store: this.timeline,
            summarizer: request => this.gemma.run('timeline-summary', () => summarize(request)),
            on_update: dates => probe('timeline', 'summary.updated_days', { dates }),
        });
        // 知识图谱：同一个"空闲 N 小时"触发，读时间线做增量更新。
        if ((this.timeline instanceof TimelineStore && this.graph instanceof KnowledgeGraphStore)
            || (this.timeline instanceof MemoryRemoteClient && this.graph instanceof MemoryRemoteClient)) {
            this.graph_scheduler = start_graph_scheduler({
                graph: this.graph,
                timeline: this.timeline,
                complete: prompt => this.gemma.run('graph-extract', () => this.memory.complete(prompt)),
                on_update: result => probe('graph', 'updated', { ...result }),
            });
        }
        else {
            probe('graph', 'scheduler.deferred_mixed_memory_backend');
        }
    }
    /**
     * 确保本地 Gemma 服务在跑（运行期按需补拉）。
     *
     * 启动时如果显存被占用，启动器会跳过拉起；等显存空出来之后由这里补拉，
     * 路径/端口都从启动器注入的环境变量读取（**不在这里重新猜路径**，避免两处不一致）。
     */
    async ensure_gemma_running() {
        // 外部服务的生命周期由部署方负责，不探测或补拉本机进程。
        if (process.env.SYNLOVE_LLM_MANAGEMENT === 'external')
            return;
        if (await port_open(Number(process.env.GEMMA_SERVER_PORT ?? '8080')))
            return;
        const binary = process.env.GEMMA_SERVER_BIN;
        const model = process.env.GEMMA_MODEL_PATH;
        if (binary === undefined || model === undefined) {
            throw new Error('不知道 Gemma 怎么启动（缺 GEMMA_SERVER_BIN/GEMMA_MODEL_PATH），请重启一次链路。');
        }
        const args = [
            '-m', model, '--host', '127.0.0.1', '--port', process.env.GEMMA_SERVER_PORT ?? '8080',
            '-c', process.env.GEMMA_CONTEXT ?? '32768', '-ngl', '99', '--jinja', '--reasoning', 'off',
            '-np', '1', '-fa', 'on', '--alias', process.env.DSH_GEMMA_MODEL ?? 'gemma-4-E4B-it-Q4_K_M',
            '--sleep-idle-seconds', process.env.DSH_GEMMA_SLEEP_IDLE_SECONDS ?? '120',
        ];
        if (process.env.GEMMA_MMPROJ_PATH !== undefined && process.env.GEMMA_MMPROJ_PATH !== '') {
            args.push('--mmproj', process.env.GEMMA_MMPROJ_PATH);
        }
        probe('gemma', 'server.start_on_demand', { binary, model });
        const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore', detached: true });
        child.unref();
        // 等它就绪（冷启动读 5GB 权重，给足时间）
        for (let attempt = 0; attempt < 120; attempt += 1) {
            if (await port_open(Number(process.env.GEMMA_SERVER_PORT ?? '8080')))
                return;
            await new Promise(resolve => setTimeout(resolve, 2_000));
        }
        throw new Error('Gemma 服务启动后一直没就绪');
    }
    /** 轮询主循环：批次完成后才提交 cursor；错误按类别处理。 */
    async poll_loop() {
        let backoff_index = 0;
        /** 游标连续被卡住的次数；用于退避，避免服务端立刻重投造成热循环。 */
        let cursor_stall = 0;
        while (!this.controller.signal.aborted && !this.stopped) {
            if (!await this.lease.is_held()) {
                this.controller.abort();
                this.outbound.stop();
                await this.inbound.dispose();
                probe('lifecycle', 'lease.lost_stop');
                return;
            }
            // 队列里有待发送的，顺手泵一次（不依赖新消息触发）。
            void this.outbound.drain();
            const cursor = await this.store.get_cursor();
            const result = await this.ingress.poll(cursor, this.controller.signal);
            if (!await this.lease.is_held())
                continue;
            switch (result.kind) {
                case 'messages': {
                    backoff_index = 0;
                    const committable = await this.handle_inbound(result.messages, result.cursor);
                    if (committable && result.cursor !== undefined) {
                        await this.store.set_cursor(result.cursor);
                        cursor_stall = 0;
                    }
                    else if (!committable) {
                        probe('inbound', 'cursor.held', {
                            reason: '有 delivery 未达终态，等待重投或恢复',
                            delivery_ids: result.messages.map(m => m.delivery_id),
                            stall: cursor_stall + 1,
                        });
                        // 游标被卡住时服务端会立刻重投同一条消息；不加退避就是热循环
                        // （实测一次挂载失败能打出上千条重复事件）。
                        cursor_stall += 1;
                        await sleep(Math.min(5_000, 500 * cursor_stall), this.controller.signal);
                    }
                    await this.outbound.drain();
                    break;
                }
                case 'idle': {
                    backoff_index = 0;
                    if (result.cursor !== undefined)
                        await this.store.set_cursor(result.cursor);
                    await this.outbound.drain();
                    break;
                }
                case 'session_timeout': {
                    // 临时会话超时：重新通知一次并继续用原 cursor（设计文档 §10.2）。
                    probe('ingress', 'session_timeout.recover');
                    await this.ingress.notify_start(this.controller.signal).catch(error => {
                        probe('ingress', 'session_timeout.notify_failed', { error: String(error) });
                    });
                    break;
                }
                case 'auth_required': {
                    // 认证失效：停止消费，写标记，等人工扫码（不无限重试）。
                    probe('lifecycle', 'auth_required', { detail: result.detail });
                    this.write_auth_marker(result.detail);
                    this.stopped = true;
                    return;
                }
                case 'protocol_error': {
                    const wait = BACKOFF_STEPS[Math.min(backoff_index, BACKOFF_STEPS.length - 1)];
                    backoff_index += 1;
                    probe('ingress', 'backoff', { wait_ms: wait, attempt: backoff_index, detail: result.detail });
                    await sleep(wait, this.controller.signal);
                    break;
                }
            }
        }
    }
    /** 写认证失效标记，供启动器提示扫码。 */
    write_auth_marker(detail) {
        const marker = process.env.DSH_WEIXIN_TOKEN_MARKER
            ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'weixin-token-invalid.flag');
        void import('node:fs/promises')
            .then(fs => fs.writeFile(marker, `${new Date().toISOString()} ${detail}\n`, 'utf8'))
            .catch(() => undefined);
        console.error('[webhook-weixin] 认证失效，已停止消费；请运行 weixin_login.py 重新扫码。标记：' + marker);
    }
    /** 桥接 assistant-stream：聚合成正文、按 turn 绑定上下文、驱动进度/心跳。 */
    bind_agent_stream(agent) {
        const session_id = String(agent.id);
        if (this.stream_agents.get(session_id) === agent)
            return;
        this.stream_disposers.get(session_id)?.();
        // 长期记忆的读取工具装在**这个 agent 自己**的 ctx 上（用 agent.ctx.effect 保证随 agent 卸载清理）。
        // 只装"读"：写入由链路自动完成，不开放给模型，避免它把臆想的事实写进长期记忆。
        if (this.timeline !== undefined) {
            agent.ctx.effect(() => {
                register_timeline_tools(agent.ctx, this.timeline);
                register_graph_tools(agent.ctx, this.graph);
                register_notify_tools(agent.ctx, this.notify);
                register_bridge_result_tools(agent.ctx, this.store);
                // codex / opencode 的会话清单与聊天记录（便于远程指挥那些会话）
                register_bridge_session_tools(agent.ctx);
                return () => { };
            }, 'webhook-weixin.memory-tools()');
        }
        // 只处理文本分片。**turn 生命周期不在这里**：
        // `agent/assistant-stream` 的 start/end 表示"一次模型请求 attempt"（含 turn/step），
        // 一个真实任务包含多 step、多 attempt；在 attempt 上做 begin/end turn 会把一个长任务
        // 拆成一堆"伪 turn"，并让同一 turn 的回复上下文被后续消息反复覆盖（已由日志证实）。
        const dispose = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
            if (subject !== agent)
                return;
            if (frame.type === 'chunk')
                this.handle_chunk(session_id, frame);
        });
        // 真正的 turn 边界：pre-step（step===1 或 turn 变化 = 新 turn）与 turn-stopping（turn 结束）。
        const dispose_pre_step = agent.ctx.on('agent/pre-step', async ({ agent: subject, turn, step }, next) => {
            if (subject === agent && (step === 1 || this.current_turn.get(session_id) !== turn)) {
                await this.begin_turn_once(session_id, turn);
            }
            return next();
        });
        const dispose_turn_stopping = agent.ctx.on('agent/turn-stopping', ({ agent: subject, turn }) => {
            if (subject !== agent)
                return;
            void this.handle_turn_end(session_id, turn);
        });
        const dispose_error = agent.ctx.on('agent/error', ({ error }) => {
            const detail = error instanceof Error ? error.message : String(error);
            probe('inbound', 'agent.error', { session_id, error: detail });
            console.error(`[webhook-weixin] agent error session=${session_id}: ${detail}`);
            this.turn_error.set(session_id, detail);
            this.arm_turn_failure(session_id, detail);
            // 额度/鉴权/模型下线这类"重试也没用"的错误 → 自动换一个 API 再来
            const reason = classify_llm_failure(detail);
            if (reason !== undefined)
                void this.failover_model(session_id, detail, reason);
        });
        // 压缩上下文开始/结束：期间挂起新消息，结束后把它们重投。
        // 事件来源是会话本身（`compaction/start` / `compaction/end` 由压缩包发成会话事件）。
        const dispose_compaction = agent.ctx.on('session/event', (session, event) => {
            if (session !== agent.session)
                return;
            if (event.type === 'compaction/start') {
                this.compacting_sessions.add(session_id);
                probe('lifecycle', 'compaction.suspend_inbound', { session_id });
                return;
            }
            if (event.type !== 'compaction/end')
                return;
            this.compacting_sessions.delete(session_id);
            this.compact_ack_sent.delete(session_id);
            probe('lifecycle', 'compaction.resume_inbound', { session_id });
            // 压缩结束后把期间挂起的消息补处理（它们停在 received、payload 都在库里）。
            void this.inbound.recover_unfinished().then((result) => {
                if (result.recovered > 0) {
                    probe('lifecycle', 'compaction.requeued', { session_id, recovered: result.recovered });
                    void this.outbound.drain();
                }
            }).catch((error) => {
                probe('lifecycle', 'compaction.requeue_failed', { session_id, error: String(error) });
            });
        });
        this.stream_disposers.set(session_id, () => {
            dispose();
            dispose_error();
            dispose_pre_step();
            dispose_turn_stopping();
            dispose_compaction();
            ObservationRecorder.forget_session(session_id);
        });
        this.stream_agents.set(session_id, agent);
        probe('lifecycle', 'stream.bound', { session_id });
    }
    /**
     * 补跑"被重启打断的轮次"。
     *
     * 做法：启动时扫描 `inflight_turn:*` 残留标记（轮次开始写、结束删），把对应 delivery
     * 从 injected 退回 received —— 随后 `inbound.recover_unfinished()` 会把它重新注入，
     * 用户就能拿到这一轮的回复，而不是被静默丢掉。
     *
     * @returns 补跑的轮次数
     */
    async rescue_interrupted_turns() {
        let rescued = 0;
        for (const item of await this.store.list_meta_prefix(INFLIGHT_TURN_PREFIX)) {
            const session_id = item.key.slice(INFLIGHT_TURN_PREFIX.length);
            let detail = {};
            try {
                detail = JSON.parse(item.value);
            }
            catch { /* 标记坏了也删掉，别一直挂着 */ }
            await this.store.delete_meta(item.key);
            if (typeof detail.delivery_id !== 'string')
                continue;
            if (typeof detail.at === 'number' && Date.now() - detail.at < INFLIGHT_RESCUE_MIN_AGE_MS)
                continue;
            const record = await this.store.get_delivery(detail.delivery_id);
            if (record === undefined || record.status === 'failed_terminal')
                continue;
            try {
                await this.store.update_delivery(detail.delivery_id, 'received', { last_error: '重启打断了这一轮，自动重投' });
                rescued += 1;
                probe('inbound', 'turn.rescued', { session_id, turn: detail.turn, delivery_id: detail.delivery_id });
                this.queue_notice({
                    session_id,
                    user_id: record.user_id,
                    kind: 'assistant',
                    text: '刚才那轮被重启打断了，我重跑一遍。',
                });
            }
            catch (error) {
                probe('inbound', 'turn.rescue_failed', {
                    session_id, delivery_id: detail.delivery_id, error: String(error),
                });
            }
        }
        if (rescued > 0)
            console.error(`[webhook-weixin] 补跑被打断的轮次：${rescued} 条`);
        return rescued;
    }
    /**
     * 入站批次的统一入口（轮询与调试注入口都走这里）。
     *
     * **压缩上下文期间不收新消息**：只入库（payload 已落库）+ 回一句"稍后回复"，
     * 游标故意不提交；压缩结束后 `recover_unfinished()` 会把它们重投。
     * 这样新消息既不会打断/污染压缩，也不会丢。
     *
     * @param messages - 本批入站消息
     * @param cursor - 平台游标（注入口没有）
     * @returns 是否允许提交该批次 cursor
     */
    async handle_inbound(messages, cursor) {
        const compacting = [];
        for (const item of messages) {
            const session = await this.store.session_id_for(item.user_id);
            if (this.compacting_sessions.has(session))
                compacting.push(item);
        }
        if (compacting.length > 0) {
            for (const item of compacting)
                await this.notify_compacting(item.user_id);
            await this.inbound.handle_batch(messages, cursor, { hold: true });
            probe('inbound', 'batch.held_for_compaction', { count: messages.length });
            await this.outbound.drain();
            return false;
        }
        return this.inbound.handle_batch(messages, cursor);
    }
    /**
     * 压缩上下文期间收到消息：回一句"正在压缩上下文，稍后回复"（同一个窗口只回一次）。
     * 消息本身已经入库，压缩结束后会补处理。
     */
    async notify_compacting(user_id) {
        const key = await this.store.session_id_for(user_id);
        if (this.compact_ack_sent.has(key))
            return;
        this.compact_ack_sent.add(key);
        probe('outbound', 'compaction_ack', { user_id, session_id: key });
        this.queue_notice({
            session_id: key,
            user_id,
            kind: 'assistant',
            text: '（正在压缩上下文，稍后回复；你这条已经排上队了）',
        });
    }
    /**
     * 取消后的收尾（幂等）。
     *
     * `agent.cancel()` 走 abort 路径时**不会**触发 `agent/turn-stopping`（实测），
     * 所以这里把 handle_turn_end 里那些"必须做"的清理补上：
     * 停心跳（否则每 5 分钟继续发「还在处理中」）、删 inflight 标记（否则下次启动会重跑已取消的任务）、
     * 清错误/可见性/聚合器/当前轮次状态。
     */
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
        probe('lifecycle', 'turn.finalized_after_cancel', { session_id, turn });
    }
    /**
     * 一轮开始：**只在首次进入该 turn 时**绑定回复上下文并启动进度追踪。
     *
     * 关键约束（修复"同一 turn 上下文被后续消息覆盖"）：
     * 已经绑定过的 turn 绝不重绑——长任务期间用户再发消息时，
     * 那条新消息属于下一个 turn，不能改写本轮回复该用的 context_token。
     */
    async begin_turn_once(session_id, turn) {
        const already = await this.turn_context.resolve_async(session_id, turn);
        this.current_turn.set(session_id, turn);
        this.aggregators.set(session_id, new ReplyAggregator());
        this.tool_calls_seen.set(session_id, new Set());
        this.outbound.begin_turn(session_id, turn);
        if (already !== undefined && await this.binding_is_fresh(already.delivery_id)) {
            probe('outbound', 'turn.start_reuse', { session_id, turn, delivery_id: already.delivery_id });
            await this.store.set_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`, JSON.stringify({
                turn, delivery_id: already.delivery_id, at: Date.now(),
            }));
            return;
        }
        if (already !== undefined) {
            // 重启后 turn 号会重复（历史 turn_context 仍在库里）。
            // 旧绑定的 context_token 很可能已过期，复用它会让回复发不出去——这里强制重绑当前 delivery。
            probe('outbound', 'turn.rebind_stale', { session_id, turn, delivery_id: already.delivery_id });
        }
        // delivery → session 映射由入站协调器写入；取最近一条注入的 delivery 作为本轮上下文。
        // 用 bind_if_absent 而非 bind：同一 turn 的绑定一旦建立就不可被后续消息覆盖。
        const latest = await this.store.latest_delivery_for_session(session_id);
        if (latest !== undefined) {
            const delivery = await this.store.get_delivery(latest.delivery_id);
            const context_token = await this.store.delivery_context_token(latest.delivery_id);
            await this.turn_context.bind_async(session_id, turn, {
                delivery_id: latest.delivery_id,
                user_id: delivery?.user_id ?? latest.user_id,
                ...context_token === undefined ? {} : { context_token },
            });
        }
        const context = await this.turn_context.resolve_async(session_id, turn);
        probe('outbound', 'turn.start', {
            session_id, turn, delivery_id: context?.delivery_id, has_token: context?.context_token !== undefined,
        });
        // 记录"这一轮还在进行中"：进程被强杀时靠它补跑（见 rescue_interrupted_turns）。
        await this.store.set_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`, JSON.stringify({
            turn, delivery_id: context?.delivery_id, at: Date.now(),
        }));
    }
    /**
     * 该 turn 绑定是否仍然新鲜。
     * 超过 TTL 就视为"重启前的旧绑定"：turn 号会重复，但 context_token 可能已失效。
     */
    async binding_is_fresh(delivery_id) {
        const record = await this.store.get_delivery(delivery_id);
        if (record === undefined)
            return false;
        return Date.now() - record.received_at < BINDING_TTL_MS;
    }
    /**
     * 自动换模型：把失活的 API 拉黑，切到下一个可用的，并把用户刚才那条消息重做一遍。
     *
     * 全过程不重启、不丢上下文（`sessionController.selectModel` 装到下一个请求上），
     * 并同步写回 `modelConfig.json` 的默认模型——否则控制台显示的、以及下次启动器同步出去的
     * 还是那个已经挂掉的模型，等于白换。
     */
    async failover_model(session_id, detail, reason) {
        try {
            const config_path = find_model_config(PROJECT_CONFIG_DIR);
            if (config_path === undefined) {
                probe('failover', 'config_missing', { workspace: PROJECT_CONFIG_DIR });
                return;
            }
            const config = read_json_file(config_path);
            const failover = parse_failover_config(config);
            if (!failover.enabled)
                return;
            const current = this.current_model;
            const dead = this.model_health.mark_dead(current, reason, detail, cooldown_ms(reason, failover));
            probe('failover', 'model.dead', {
                provider: current.provider, model: current.model, reason, until: dead.until, detail: detail.slice(0, 120),
            });
            const next = next_alive_candidate(failover.order, current, candidate => this.model_health.is_dead(candidate));
            if (next === undefined) {
                probe('failover', 'no_candidate', { tried: current });
                const user_id = await this.store.latest_user_id();
                if (user_id !== undefined) {
                    const session_key = await this.store.get_session_id(user_id) ?? session_id;
                    this.queue_notice({
                        session_id: session_key, user_id, kind: 'assistant',
                        text: `配置里的模型接口都不可用了（${current.model}：${detail.slice(0, 80)}）。`
                            + '换个 key 或等额度恢复后我再试；也可以让我用别的模型。',
                    });
                    await this.outbound.drain();
                }
                return;
            }
            // ① 装到当前会话的下一个请求上（不丢上下文）
            const controller = this.ctx.get('sessionController');
            if (controller?.selectModel === undefined) {
                probe('failover', 'controller_missing', {});
                return;
            }
            await controller.selectModel({
                sessionId: brandString(session_id),
                provider: next.provider,
                model: next.model,
            });
            this.current_model = { provider: next.provider, model: next.model };
            // ② 写回默认模型（控制台显示 + 下次启动器同步都跟着变）
            this.persist_default_model(config_path, config, next);
            probe('failover', 'model.switched', {
                from: `${current.provider}/${current.model}`, to: `${next.provider}/${next.model}`, reason,
            });
            // ③ 告诉用户，并把刚才那条消息重做一遍
            const user_id = await this.store.latest_user_id();
            if (user_id !== undefined) {
                const session_key = await this.store.get_session_id(user_id) ?? session_id;
                this.queue_notice({
                    session_id: session_key, user_id, kind: 'assistant',
                    text: `「${current.model}」这个接口用不了了（${reason === 'quota' ? '额度用完' : reason === 'auth' ? 'key 失效' : '模型下线'}），`
                        + `我先换成「${next.model}」，把你刚才那条重做一遍。`,
                });
                await this.outbound.drain();
                await this.retry_last_message(session_id, user_id);
            }
        }
        catch (error) {
            probe('failover', 'failed', { error: String(error).slice(0, 200) });
        }
    }
    /** 把新的默认模型写回 modelConfig.json（含备份）。 */
    persist_default_model(config_path, config, next) {
        try {
            const parsed = config;
            parsed.defaultModel = { provider: next.provider, model: next.model };
            parsed.updatedAt = new Date().toISOString();
            copyFileSync(config_path, `${config_path}.bak-failover`);
            writeFileSync(config_path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            probe('failover', 'persist_failed', { error: String(error).slice(0, 160) });
        }
    }
    /** 记住最近一条用户消息（换模型后要重做它）。 */
    remember_user_message(session_id, user_id, text) {
        this.last_user_message.set(session_id, { user_id, text, at: Date.now(), retried: false });
    }
    /**
     * 重做最近一条用户消息（每个会话只自动重做一次，避免连环重试）。
     *
     * 走的是**真实入站管线**（和用户自己发一样），所以工具、记忆、回复都一样；
     * 只是 delivery id 用 `retry-` 前缀，便于在探针里区分。
     */
    async retry_last_message(session_id, user_id) {
        const remembered = this.last_user_message.get(session_id);
        if (remembered === undefined || remembered.text.trim() === '')
            return;
        if (remembered.retried) {
            probe('failover', 'retry.skipped_already', { session_id });
            return;
        }
        remembered.retried = true;
        const delivery_id = `retry-${Date.now()}-${randomBytes(3).toString('hex')}`;
        probe('failover', 'retry.start', { session_id, delivery_id, chars: remembered.text.length });
        try {
            await this.handle_inbound([{
                    delivery_id, user_id, text: remembered.text, media: [], received_at: Date.now(),
                }], undefined);
        }
        catch (error) {
            probe('failover', 'retry.failed', { session_id, error: String(error).slice(0, 160) });
        }
    }
    /**
     * 记一次 agent 错误，并在宽限期后把这一轮按失败收尾。
     *
     * 为什么必须做：模型接口持续报错（例如 429「api key 日限额已用完」）时，agent loop
     * 会一直重试/卡住，`agent/turn-stopping` 永远不来——用户那边只看到每 5 分钟一条
     * "还在处理中"，永远等不到结果（2026-09-21 23:46 那轮实测卡了 10 分钟以上）。
     * 宽限期内只要有任何新分片就取消收尾（说明重试成功了，别抢话）。
     */
    arm_turn_failure(session_id, detail) {
        const existing = this.turn_failure_timers.get(session_id);
        if (existing !== undefined)
            clearTimeout(existing);
        const timer = setTimeout(() => {
            this.turn_failure_timers.delete(session_id);
            void this.fail_turn(session_id, detail);
        }, AGENT_ERROR_GRACE_MS);
        this.turn_failure_timers.set(session_id, timer);
    }
    /** 有活动就取消待定的失败收尾。 */
    clear_turn_failure(session_id) {
        const timer = this.turn_failure_timers.get(session_id);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.turn_failure_timers.delete(session_id);
        }
    }
    /**
     * 把模型接口的报错翻成"人话 + 该怎么办"。
     *
     * 为什么必须分类：以前**所有**失败都写"多半是额度/限额用完或 key 失效"，而实测
     * 最常见的其实是传输层失败（OpenAI SDK 的 `APIConnectionError`，消息就是
     * "Connection error."——接口那一小段时间连不上/连接被断开），跟额度完全无关。
     * 说错原因会让用户白等额度、或者去换根本不坏的 key。
     */
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
    /**
     * 把卡住的一轮按失败收尾：**如实说明原因**，并把这一轮关掉。
     *
     * 宁可说"没做成 + 为什么"，也不要让用户对着"还在处理中"干等——
     * 这也是人格里"工具失败就直接说失败和可确认的原因"的要求。
     */
    async fail_turn(session_id, detail) {
        const turn = this.current_turn.get(session_id);
        if (turn === undefined)
            return;
        const user_id = (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? '';
        probe('inbound', 'turn.failed', { session_id, turn, detail });
        // 已经在这里说明过了：清掉错误标记，免得 handle_turn_end 再补一条重复的
        this.turn_error.delete(session_id);
        this.queue_assistant({
            session_id, user_id, turn,
            text: `我这轮没做成：模型接口报错「${detail.slice(0, 140)}」。\n${this.explain_llm_failure(detail)}`,
        });
        await this.handle_turn_end(session_id, turn);
    }
    /** 一轮结束：补发尾段、清理状态。 */
    async handle_turn_end(session_id, turn) {
        this.clear_turn_failure(session_id);
        // 这一轮正常收尾了：删掉"进行中"标记，别让下次启动把它当被打断的轮次补跑。
        await this.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
        // 整轮报过错、又一个字都没发出去 → 必须说一句，不能让用户对着空气等
        // （实测：中转站上游过载时 harness 会以 error 结束这一轮，若这里不补，用户什么都收不到）
        const error = this.turn_error.get(session_id);
        const visible = this.turn_visible.has(session_id);
        this.turn_error.delete(session_id);
        this.turn_visible.delete(session_id);
        if (error !== undefined && !visible) {
            probe('outbound', 'turn.failed_notice', { session_id, turn });
            this.queue_notice({
                session_id,
                user_id: (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? '',
                kind: 'assistant',
                text: `我这轮没做成：模型接口报错「${error.slice(0, 120)}」。\n${this.explain_llm_failure(error)}`,
            });
        }
        const aggregator = this.aggregators.get(session_id);
        this.aggregators.delete(session_id);
        if (aggregator !== undefined) {
            const tail = aggregator.finish();
            if (tail) {
                this.queue_assistant({
                    session_id, user_id: (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? '', turn, text: tail,
                });
            }
        }
        this.outbound.end_turn(session_id);
        this.tool_calls_seen.delete(session_id);
        this.current_turn.delete(session_id);
        this.last_progress_at.delete(session_id);
        await this.turn_context.prune_async(session_id);
        await this.outbound.drain();
        probe('outbound', 'turn.done', { session_id, turn });
    }
    /** 处理流分片：正文聚合发送、思考摘要作为进度（即心跳）。 */
    handle_chunk(session_id, frame) {
        // 只有 type='chunk' 的帧带 chunk 载荷；调用方已按帧类型分流，这里再做一次类型收窄。
        if (frame.type !== 'chunk')
            return;
        // 有输出就说明上一轮报错后恢复了（重试成功），撤掉待定的失败收尾
        this.clear_turn_failure(session_id);
        const chunk = frame.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            const aggregator = this.aggregators.get(session_id) ?? new ReplyAggregator();
            this.aggregators.set(session_id, aggregator);
            const turn = this.current_turn.get(session_id) ?? 0;
            for (const segment of aggregator.accept_chunk(chunk.text)) {
                this.outbound.note_visible(session_id);
                this.turn_visible.add(session_id); // 本轮确实有正文发出
                this.queue_assistant({ session_id, user_id: '', turn, text: segment });
            }
            this.outbound.note_visible(session_id);
            void this.outbound.drain();
            return;
        }
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            const aggregator = this.aggregators.get(session_id) ?? new ReplyAggregator();
            this.aggregators.set(session_id, aggregator);
            aggregator.accept_reasoning(chunk.text);
            // 进度推送：按时间驱动，而不是"每 N 次工具调用"。
            // 摘要本身就是心跳，所以推送后 note_visible 会把空闲阈值推后，抑制额外心跳。
            this.maybe_push_progress(session_id, aggregator);
            return;
        }
        if (chunk?.type === 'tool-call-delta' && typeof chunk.name === 'string' && chunk.name.length > 0) {
            const seen = this.tool_calls_seen.get(session_id) ?? new Set();
            const call_id = typeof chunk.id === 'string' && chunk.id.length > 0 ? chunk.id : `${chunk.name}:${seen.size}`;
            if (seen.has(call_id))
                return;
            seen.add(call_id);
            this.tool_calls_seen.set(session_id, seen);
        }
    }
    /**
     * 按时间推送思考摘要（即进度，也是心跳）。
     *
     * 触发条件：距上次推送 ≥ PROGRESS_MIN_INTERVAL_MS，且有足够长度的新摘要。
     * 不再依赖工具调用次数——否则"只调一次工具"的任务全程无进度。
     */
    maybe_push_progress(session_id, aggregator) {
        if (PROGRESS_MIN_INTERVAL_MS <= 0)
            return;
        const now = Date.now();
        const last = this.last_progress_at.get(session_id) ?? 0;
        if (now - last < PROGRESS_MIN_INTERVAL_MS)
            return;
        const excerpt = aggregator.take_reasoning_excerpt(120);
        if (excerpt === undefined || excerpt.length < PROGRESS_MIN_CHARS)
            return;
        // 只推**中文**思考摘要：模型（尤其换模型后）的思维链常是英文，
        // 直接推过去等于把"隐藏推理"摊给用户看（实测推过 "（进度·欣爱在想）user wants me"），
        // 人格里明确禁止。中文占比不够就当没有进度，宁可安静。
        const cjk = (excerpt.match(/[\u4e00-\u9fff]/g) ?? []).length;
        if (cjk < PROGRESS_MIN_CHARS)
            return;
        this.last_progress_at.set(session_id, now);
        this.queue_progress(session_id, `（进度·欣爱在想）${excerpt}`);
        probe('outbound', 'progress.pushed', { session_id, chars: excerpt.length });
        void this.outbound.drain();
    }
    /** 停止：幂等；释放监听、租约与 Agent。 */
    async stop() {
        if (this.stopped && this.running === undefined)
            return;
        this.stopped = true;
        this.controller.abort();
        await this.running?.catch(() => undefined);
        this.codex_watcher.stop();
        this.opencode_watcher.stop();
        this.outbound.stop();
        if (this.inject_server !== undefined) {
            this.inject_server.close();
            this.inject_server = undefined;
        }
        this.timeline_scheduler?.stop();
        this.timeline_scheduler = undefined;
        // 视图是惰性重建的，停止前把待写的一次性刷出来（否则 .md 可能落后于记录）
        try {
            if (this.timeline instanceof TimelineStore)
                this.timeline.flush_views();
        }
        catch (error) {
            probe('timeline', 'flush.failed', { error: String(error) });
        }
        this.graph_scheduler?.stop();
        this.graph_scheduler = undefined;
        for (const dispose of this.stream_disposers.values())
            dispose();
        this.stream_disposers.clear();
        this.stream_agents.clear();
        await this.inbound.dispose();
        this.aggregators.clear();
        this.tool_calls_seen.clear();
        // 尽力把队列里剩下的发出去，再释放所有权。
        await this.outbound.drain().catch(() => undefined);
        await this.host.dispose_agents();
        for (const dispose of this.observation_disposers)
            dispose();
        await this.lease.release();
        this.store.close();
        probe('lifecycle', 'connector.stopped');
    }
}
/** 可被 signal 打断的等待。 */
function sleep(ms, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}
/**
 * 将连接器绑定到 Cordis effect；卸载时幂等地停止。
 *
 * 关键：`start()` 必须被 **await**，让 lease 冲突 / OpenClaw 隔离失败 / Agent 能力缺失 /
 * 微信启动失败都变成插件装配失败（fail closed）。否则会退化成"Web 后台正常、微信消费者
 * 其实没起来"的假成功——此时进程还活着，但用户发消息永远没人接。
 */
export function install_weixin_connector(ctx, options) {
    const connector = new WeixinConnector(ctx, options);
    ctx.effect(async () => {
        const done = probe_timer('lifecycle', 'connector.start');
        try {
            await connector.start();
            done({ outcome: 'ok' });
        }
        catch (error) {
            probe('lifecycle', 'connector.start_failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            console.error('[webhook-weixin] 连接器启动失败：'
                + (error instanceof Error ? error.stack ?? error.message : String(error)));
            // 如实向上抛：让宿主判定插件装配失败，而不是记一条日志后继续跑。
            throw error;
        }
        return () => connector.stop();
    }, 'webhook-weixin.lifecycle()');
    return connector;
}
//# sourceMappingURL=weixinConnector.js.map