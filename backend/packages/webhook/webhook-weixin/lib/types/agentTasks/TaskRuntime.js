import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { probe } from '../diagnostics/probe.js';
import { TaskStore } from './TaskStore.js';
import { TaskMcpServer } from './TaskMcpServer.js';
import { WorkerSessionFactory } from './WorkerSessionFactory.js';
import { TaskResultCollector } from './TaskResultCollector.js';
import { PresenterEventBridge } from './PresenterEventBridge.js';
import { TaskReportStore } from './TaskReportStore.js';
import { TaskProgressCache } from './TaskProgressCache.js';
import { AgentReasoning } from './AgentReasoning.js';
import { delete_session_artifacts, sessions_root } from '../session/sessionFiles.js';
function reply_text(event) {
    if (event?.type !== 'assistant/message') return '';
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content){
        if (block?.type === 'text' && String(block.text ?? '').trim()) parts.push(String(block.text).trim());
        else if (block?.type === 'tool-call') parts.push('调用 ' + String(block.name ?? block.toolName ?? '工具'));
    }
    return parts.join('\n').slice(0, 8000);
}
export class TaskRuntime {
    ctx;
    root;
    static instances = new WeakMap();
    store;
    progress;
    mcp;
    factory;
    collector = new TaskResultCollector();
    bridge;
    config;
    active = new Map();
    channels = new Map();
    attached = new WeakSet();
    owner = randomUUID();
    ready;
    timer;
    stopped = false;
    pumping = false;
    closing;
    runs = new Set();
    worker_setup;
    constructor(ctx, root, config, factory){
        this.ctx = ctx;
        this.root = root;
        this.config = {
            maxConcurrent: 4,
            taskTimeoutMs: 1800000,
            presentationTimeoutMs: 180000,
            ...config
        };
        if (!Number.isInteger(this.config.maxConcurrent) || this.config.maxConcurrent < 1 || this.config.maxConcurrent > 4) throw new Error('任务并发必须为1至4');
        this.store = new TaskStore(join(root, 'runtime', 'agentTasks', 'taskStore.sqlite'));
        this.progress = new TaskProgressCache(root);
        if (!this.store.claim_lease(this.owner)) {
            this.store.close_store();
            throw new Error('另一个实例占用后台任务运行器');
        }
        this.store.recover_tasks();
        this.factory = factory ?? new WorkerSessionFactory(ctx, root, this.config, (child, task)=>this.worker_setup?.(child, task));
        this.mcp = new TaskMcpServer(this);
        this.bridge = new PresenterEventBridge(this);
        this.ready = this.mcp.start_server();
        this.timer = setInterval(()=>{
            if (!this.store.claim_lease(this.owner)) {
                void this.close_runtime();
                return;
            }
            void this.pump_tasks().catch((error)=>this.log_event('pump.failed', {
                    error: String(error)
                }));
        }, 2000);
        this.timer.unref?.();
    }
    static for_host(ctx, options) {
        if (typeof ctx.effect !== 'function') return undefined;
        const root = process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd();
        const path = join(root, 'config', 'agentTaskConfig.json');
        if (!existsSync(path)) return undefined;
        const config = JSON.parse(readFileSync(path, 'utf8'));
        if (!config.enabled) return undefined;
        const key = ctx.root ?? ctx.agents;
        let runtime = this.instances.get(key);
        if (!runtime) {
            runtime = new TaskRuntime(ctx, root, config);
            this.instances.set(key, runtime);
            const current = runtime;
            (ctx.root ?? ctx).effect(()=>()=>current.close_runtime());
        }
        return runtime;
    }
    is_presenting(session) {
        return this.bridge.is_presenting(session);
    }
    host_context() {
        return this.ctx;
    }
    assert_owner() {
        if (this.stopped || !this.store.has_lease(this.owner)) throw new Error('后台任务运行器已停止或失去所有权');
    }
    log_event(kind, data) {
        probe('agent-task', kind, data);
    }
    register_channel(channel, handler) {
        this.channels.set(channel, handler);
    }
    async check_worker(options, workspace) {
        const id = `task-check-${randomUUID()}`;
        let handle;
        try {
            handle = await this.factory.create_worker({
                worker: id,
                kind: 'research',
                origin: {
                    workspace
                }
            }, options);
            const names = handle.agent.ctx.tools.schemas(handle.agent).map((tool)=>tool.name);
            const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
            if (![
                'read',
                'write',
                'edit',
                shell,
                'opencode',
                'codex'
            ].every((name)=>names.includes(name))) throw new Error('统一执行预设缺少文件、命令行或编码连接器工具');
            if (existsSync(join(this.root, 'config', 'terminalConnection.json')) && ![
                'terminal_devices',
                'remote_file_list',
                'remote_file_transfer'
            ].every((name)=>names.includes(`mcp__remote-cmd__${name}`))) throw new Error('终端桥接已配置，但执行内核未装载设备与文件传输工具');
            return names.length;
        } finally{
            await handle?.dispose();
            delete_session_artifacts({
                root: sessions_root(),
                cwd: workspace,
                id
            });
        }
    }
    presenter_tool_names() {
        return [
            ...this.mcp.list_tools().map((tool)=>`mcp__synlove-task__${tool.name}`),
            'timeline_days',
            'timeline_search',
            'timeline_read',
            'relation_query',
            'mcp__remote-cmd__terminal_devices',
            'mcp__remote-cmd__remote_cmd_list'
        ];
    }
    note_input(agent, origin) {
        const key = `${origin.channel}:${origin.messageId}`;
        this.store.save_origin(key, String(agent.id), {
            ...origin,
            sessionId: String(agent.id)
        });
        return key;
    }
    async attach_presenter(agent, options) {
        if (this.attached.has(agent)) return;
        await this.ready;
        this.attached.add(agent);
        const token = this.mcp.bind_owner({
            agent,
            options,
            session: String(agent.id)
        });
        try {
            agent.ctx.tools.presentAs('native');
            await McpClient.apply(agent.ctx, {
                transport: 'streamable-http',
                serverName: 'synlove-task',
                url: this.mcp.url,
                headers: {
                    Authorization: `Bearer ${token}`
                },
                failOnStartupError: true,
                toolCallTimeoutMs: 15000,
                registerResources: false
            });
            const allow = this.presenter_tool_names();
            const known = agent.ctx.tools.view(agent).restrictableNames;
            agent.ctx.tools.restrict({
                allow: allow.filter((name)=>known.has(name))
            });
            agent.ctx.tools.guard((exec)=>allow.includes(exec.name) ? undefined : '主人格仅使用任务管理和记忆只读查询');
            agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next)=>{
                const assembly = await next();
                return {
                    ...assembly,
                    sections: assembly.sections.filter((section)=>section.name !== 'mcp-resource-servers' && (!section.name.startsWith('mcp:') || section.name === 'mcp:synlove-task'))
                };
            });
            agent.ctx.systemPrompt.section({
                name: 'synlove:presenter-protocol',
                order: 100000,
                text: readFileSync(join(this.root, 'prompts', 'PresenterProtocol.md'), 'utf8')
            });
            agent.ctx.effect(()=>()=>this.mcp.revoke_owner(token));
            new AgentReasoning(this.root, 'presenter').attach_agent(agent);
            this.log_event('presenter.ready', {
                tools: allow.length
            });
        } catch (error) {
            this.attached.delete(agent);
            this.mcp.revoke_owner(token);
            throw error;
        }
    }
    current_origin(owner, id, unique = false) {
        const events = owner.agent.session.snapshotEvents();
        const origins = [];
        for(let i = events.length - 1; i >= 0; i--){
            if (events[i].type === 'turn/start') break;
            if (events[i].type !== 'user/message') continue;
            const source = events[i].data?.source;
            if (source?.kind === 'synlove-task-result') throw new Error('结果处理轮次不能启动或修改任务');
            if (source?.kind === 'plugin' && source.form === 'snapshot' && [
                'time-context',
                'system-prompt'
            ].includes(source.plugin)) continue;
            const key = source?.taskOriginId;
            if (!key) throw new Error('当前消息没有可信通道来源，拒绝后台操作');
            const origin = this.store.get_origin(key, owner.session);
            if (!origin) throw new Error('消息来源已失效');
            origins.push({
                ...origin,
                key
            });
        }
        if (!origins.length) throw new Error('尚未绑定用户输入');
        if (id !== undefined) {
            const origin = origins.find((item)=>item.key === id);
            if (!origin) throw new Error('originId 不属于本轮可信入站消息');
            return origin;
        }
        if (unique && new Set(origins.map((item)=>`${item.channel}:${item.userId ?? ''}:${JSON.stringify(item.target)}`)).size > 1) throw new Error('本轮有多个消息来源，请用 originId 指定原消息：' + JSON.stringify(origins.map((item)=>({
                originId: item.key,
                channel: item.channel,
                request: item.originalText?.slice(0, 300)
            }))));
        return origins[0];
    }
    async call_tool(owner, name, args) {
        this.assert_owner();
        const definition = this.mcp.list_tools().find((tool)=>tool.name === name);
        if (!definition) throw new Error('未知任务工具');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('不允许的任务参数');
        const unexpected = Object.keys(args).filter((key)=>!Object.hasOwn(definition.inputSchema.properties, key) && !(name === 'task_submit' && key === 'kind'));
        if (unexpected.length) {
            const hint = name === 'task_submit' && (args.taskId || args.message) ? '；给进行中的任务补充要求请改用 task_message（参数 taskId + message），task_submit 只用于新建任务（必填 request）' : `；本工具（${name}）只接受参数：${Object.keys(definition.inputSchema.properties).join(', ')}`;
            throw new Error(`不允许的任务参数：${unexpected.join(', ')}${hint}`);
        }
        const presentation = this.is_presenting(owner.session);
        if (presentation && name !== 'task_result') throw new Error('自动结果轮次只允许读取总结');
        if (args.originId !== undefined && (typeof args.originId !== 'string' || args.originId.length > 512)) throw new Error('originId 无效');
        const origin = presentation ? undefined : this.current_origin(owner, args.originId, name === 'task_submit');
        const scope = origin?.owner ?? owner.session;
        if (name === 'task_submit') {
            if (typeof args.request !== 'string' || !args.request.trim() || args.request.length > 12000) throw new Error('任务要求必须为1至12000字符');
            const kind = 'execution';
            const key = createHash('sha256').update(`${scope}\n${origin.key}\n${args.request.trim()}`).digest('hex');
            const task = this.store.create_task(scope, key, {
                ...origin,
                options: owner.options,
                workspace: origin.workspace ?? owner.options.workspace_path
            }, args.request.trim(), kind);
            setImmediate(()=>{
                void this.pump_tasks().catch((error)=>this.log_event('start.failed', {
                        error: String(error)
                    }));
            });
            return {
                taskId: task.id,
                state: task.state,
                accepted: true,
                replyInstruction: '用自己的自然语气告诉用户后台已接下；不能说已完成。结束会主动通知，不必轮询。'
            };
        }
        if (args.taskId !== undefined && (typeof args.taskId !== 'string' || !args.taskId || args.taskId.length > 80)) throw new Error('任务ID无效');
        const id = typeof args.taskId === 'string' ? args.taskId : '';
        if (name === 'task_status' && !id) return this.store.list_tasks(scope).map((task)=>({
                taskId: task.id,
                state: task.state,
                kind: task.kind,
                progressCount: this.progress.count(task.id),
                updatedAt: task.updated
            }));
        let task;
        if (presentation) {
            const activeId = this.bridge.active.get(owner.session)?.taskId;
            if (id !== activeId) throw new Error('自动结果轮次不能读取其他任务');
            task = this.store.get_task(id, this.bridge.active.get(owner.session).owner);
        } else task = this.store.get_task(id, scope);
        if (name === 'task_status') return {
            taskId: id,
            state: task.state,
            workerSessionId: task.worker,
            progressCount: this.progress.count(id),
            updatedAt: task.updated
        };
        if (name === 'task_progress') return {
            taskId: id,
            state: task.state,
            updatedAt: task.updated,
            entries: this.progress.read(id, 30).map((row)=>({
                    at: row.at,
                    text: String(row.text ?? '').slice(0, 1200)
                })),
            note: this.progress.count(id) ? undefined : '还没有读到执行内核的回复；任务已结束的话缓存已经销毁，最终结论用 task_result'
        };
        if (name === 'task_result') {
            const offset = args.offset ?? 0;
            if (!Number.isInteger(offset) || offset < 0) throw new Error('结果偏移必须为非负整数');
            const result = task.result ?? '任务尚未形成最终总结。';
            return {
                taskId: id,
                state: task.state,
                summary: result.slice(offset, offset + 10000),
                nextOffset: offset + 10000 < result.length ? offset + 10000 : null,
                artifacts: [
                    'succeeded',
                    'partial',
                    'failed',
                    'cancelled',
                    'interrupted'
                ].includes(task.state) ? new TaskReportStore(this.root).persist_result(task) : undefined,
                verification: '以执行总结中的实际验证范围为准；会话结束不等于所有目标均已验证'
            };
        }
        const run = this.active.get(id);
        if (name === 'task_cancel') {
            if (task.state === 'queued') this.store.update_task(id, {
                state: 'cancelled',
                result: '任务在启动前已取消，没有开始执行。'
            });
            else if (run && task.state === 'running') {
                this.store.update_task(id, {
                    state: 'cancelling'
                });
                run.cancelled = true;
                run.abort.abort(new Error('用户请求取消任务'));
                run.handle?.agent.cancel({
                    kind: 'user'
                });
            }
            return {
                taskId: id,
                state: this.store.get_task(id, scope).state
            };
        }
        if (name === 'task_message') {
            if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 12000) throw new Error('补充要求必须为1至12000字符');
            if (!run?.handle || task.state !== 'running') throw new Error('任务当前不可追加；会话尚未就绪或任务已经结束');
            run.handle.agent.steer(createUserMessage({
                content: [
                    {
                        type: 'text',
                        text: args.message
                    }
                ],
                source: {
                    kind: 'user'
                }
            }));
            return {
                taskId: id,
                accepted: true,
                effective: '在执行器下一模型步骤读取，正在运行的外部命令不会被强制重做'
            };
        }
    }
    async pump_tasks() {
        if (this.stopped || this.pumping) return;
        this.pumping = true;
        try {
            this.assert_owner();
            for (const task of this.store.pending_tasks('work')){
                if (task.state !== 'queued' || this.active.size >= this.config.maxConcurrent) continue;
                const entry = {
                    task,
                    handle: undefined,
                    cancelled: false,
                    abort: new AbortController()
                };
                this.active.set(task.id, entry);
                this.store.update_task(task.id, {
                    state: 'running'
                });
                const work = this.run_task(entry);
                this.runs.add(work);
                void work.finally(()=>this.runs.delete(work));
            }
            void this.bridge.pump_results().catch((error)=>this.log_event('notice.failed', {
                    error: String(error)
                }));
        } finally{
            this.pumping = false;
        }
    }
    async run_task(entry) {
        const task = entry.task;
        const timer = setTimeout(()=>{
            entry.cancelled = true;
            entry.timeout = true;
            entry.abort.abort(new Error('后台任务超时'));
            entry.handle?.agent.cancel({
                kind: 'timeout'
            });
        }, this.config.taskTimeoutMs);
        try {
            entry.handle = await this.factory.create_worker(task, task.origin.options, entry.abort.signal);
            this.assert_owner();
            if (this.stopped || entry.cancelled) entry.handle.agent.cancel({
                kind: 'host'
            });
            else {
                entry.handle.agent.followup(createUserMessage({
                    content: [
                        {
                            type: 'text',
                            text: [
                                `任务ID：${task.id}；获准工作区：${task.origin.workspace}。所有任务使用统一执行工具集。`,
                                `用户本次原文（约束不能丢失）：${task.origin.originalText ?? ''}`,
                                `具体任务：${task.request}`,
                                '报告使用 save_report 保存到宿主固定目录；不要把任务说明中自动补写的旧目录当成真实路径，也不要让主人格代写文件。',
                                '长报告先保存，再给简短最终总结（建议1500字以内），保留结论、真实路径、风险与未完成项，不把整篇报告塞进总结。',
                                '每一轮回复的最后单独一行写进度摘要，固定格式：摘要：本轮做了……；希望……；结果……（不超过120字）。这一行是给主人格看进度的，每轮都要写，没有进展也要如实写。',
                                '不要向用户直接发消息；执行完给出完整最终总结，包含实际完成、验证、产物、风险与未完成项。'
                            ].join('\n')
                        }
                    ],
                    source: {
                        kind: 'user'
                    }
                }));
                const workerId = String(task.worker);
                const stop = this.ctx?.on?.('session/event', (session, event)=>{
                    if (String(session?.header?.id ?? session) !== workerId) return;
                    const text = reply_text(event);
                    if (!text) return;
                    try {
                        this.progress.append(task.id, text, Number(event?.time) || Date.now());
                    } catch  {}
                });
                entry.progressOff = typeof stop === 'function' ? stop : undefined;
                await entry.handle.agent.whenIdle();
            }
            const result = this.collector.collect_result(entry.handle.agent, 0, entry.cancelled, true);
            await entry.handle.dispose();
            entry.handle = undefined;
            this.assert_owner();
            this.store.update_task(task.id, {
                state: entry.timeout ? 'interrupted' : result.state,
                result: (entry.timeout ? '任务超时，已请求取消；不能确认外部操作全部停止。\n' : '') + result.result
            });
        } catch (error) {
            if (!this.stopped && this.store.has_lease(this.owner)) this.store.update_task(task.id, {
                state: entry.timeout ? 'interrupted' : entry.cancelled ? 'cancelled' : 'failed',
                result: `后台执行${entry.cancelled ? '已请求停止；外部副作用需核对' : '失败'}：${String(error).slice(0, 1000)}`
            });
        } finally{
            clearTimeout(timer);
            entry.progressOff?.();
            this.progress.clear(task.id);
            try {
                await entry.handle?.dispose();
            } catch  {}
            this.active.delete(task.id);
            this.log_event('task.ended', {
                taskId: task.id
            });
            if (!this.stopped) void this.pump_tasks().catch(()=>{});
        }
    }
    async close_runtime() {
        if (this.closing) return this.closing;
        this.stopped = true;
        clearInterval(this.timer);
        for (const run of this.active.values()){
            run.cancelled = true;
            run.abort.abort(new Error('后台任务宿主停止'));
            run.handle?.agent.cancel({
                kind: 'host'
            });
        }
        this.closing = (async ()=>{
            const notices = this.bridge.close_bridge();
            await this.mcp.close_server();
            await Promise.allSettled([
                ...this.runs
            ]);
            await notices;
            this.store.release_lease(this.owner);
            this.store.close_store();
        })();
        return this.closing;
    }
}
