import z from '@deepseek-ai/schemastery';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessSessionHost, probe, get_shared_memory, register_timeline_tools, register_graph_tools } from '@deepseek-ai/dsh-webhook-weixin';
import { QqGateway } from './gateway.js';
import { send_qq_media, send_qq_text } from './send.js';
import { QqTokenProvider } from './token.js';
import { QqOutbox } from './QqOutbox.js';
import { QqRemoteOutbox } from './QqRemoteOutbox.js';
import { QqStateRemoteClient } from './QqStateRemoteClient.js';
import { QqRemoteLease } from './QqRemoteLease.js';
import { QqGatewayLease } from './QqGatewayLease.js';
import { BackendNotifications } from './BackendNotifications.js';
function shared_session_id() {
    if ((process.env.DSH_SESSION_SHARED ?? '').trim() === '') return '';
    const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh');
    try {
        return readFileSync(join(home, 'shared-session.txt'), 'utf8').split('\n')[0]?.trim() ?? '';
    } catch  {
        return 'main';
    }
}
export const name = 'webhook-qq';
export const inject = [
    'agents',
    'agentPresets',
    'sessionPersistence'
];
export const Config = z.object({
    app_id: z.string().required(),
    client_secret: z.string().role('secret').required(),
    workspace_path: z.string().required(),
    provider: z.string().required(),
    model: z.string().required(),
    agent_preset: z.string(),
    base_url: z.string(),
    intents: z.number()
});
export function apply(ctx, config) {
    if (!config.app_id.trim()) throw new Error('webhook-qq app_id must be non-empty');
    if (!config.client_secret.trim()) throw new Error('webhook-qq client_secret must be non-empty');
    probe('lifecycle', 'qq.plugin.apply', {
        app_id: config.app_id,
        preset: config.agent_preset ?? '',
        shared_env: process.env.DSH_SESSION_SHARED ?? '',
        shared_id: shared_session_id()
    });
    const host = new HarnessSessionHost(ctx, {
        ...config.agent_preset === undefined ? {} : {
            agent_preset: config.agent_preset
        },
        workspace_path: config.workspace_path,
        provider: config.provider,
        model: config.model
    });
    host.assert_capabilities();
    const tokens = new QqTokenProvider({
        appId: config.app_id,
        clientSecret: config.client_secret,
        ...config.base_url === undefined ? {} : {
            baseUrl: config.base_url
        }
    });
    const pending = new Map();
    const bound = new WeakSet();
    let outbox;
    const last_msg = new Map();
    const asst_seq = new Map();
    const record_memory = async (session_id, role, text, stable_id)=>{
        const suite = get_shared_memory();
        if (suite === undefined) return;
        try {
            await suite.timeline.append({
                id: stable_id,
                ts: Date.now(),
                role,
                text,
                session_id,
                user_id: session_id
            });
        } catch (error) {
            probe('memory', 'qq.record_failed', {
                error: String(error)
            });
        }
    };
    const register_query_tools = (ctx)=>{
        const suite = get_shared_memory();
        if (suite === undefined) return;
        register_timeline_tools(ctx, suite.timeline);
        register_graph_tools(ctx, suite.graph);
    };
    const flush = async (session_id)=>{
        const item = pending.get(session_id);
        if (item === undefined || item.text.trim() === '') return;
        const seq = (asst_seq.get(session_id) ?? 0) + 1;
        asst_seq.set(session_id, seq);
        await record_memory(session_id, 'assistant', item.text.trim(), `qq-asst-${session_id}-${seq}`);
        {
            await get_outbox().enqueue_reply(item);
            pending.delete(session_id);
            await get_outbox().drain_queue();
        }
    };
    const bind_stream = (agent, session_id)=>{
        if (bound.has(agent)) return;
        bound.add(agent);
        agent.ctx.on('agent/assistant-stream', (payload)=>{
            if (host.tasks?.is_presenting(session_id)) return;
            if (payload.agent !== undefined && payload.agent !== agent) return;
            const frame = payload.frame;
            if (frame?.type !== 'chunk') return;
            const chunk = frame.chunk;
            if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return;
            const item = pending.get(session_id);
            if (item !== undefined) item.text += chunk.text;
        });
        agent.ctx.on('agent/turn-stopping', (payload)=>{
            if (host.tasks?.is_presenting(session_id)) return;
            if (payload.agent !== undefined && payload.agent !== agent) return;
            void flush(session_id).catch((error)=>probe('outbound', 'qq.flush_failed', {
                    error: String(error).slice(0, 160)
                }));
        });
    };
    const wait_for_agent = async (session_id)=>{
        const deadline = Date.now() + 45_000;
        let last_error;
        while(Date.now() < deadline){
            const live = host.get_agent(session_id);
            if (live !== undefined) return live;
            try {
                return await host.create_agent(session_id);
            } catch (error) {
                last_error = error;
                const message = String(error?.message ?? error);
                if (!/SessionAlreadyOwned|already owned|already exists|正在写入|busy/i.test(message)) throw error;
                probe('inbound', 'qq.session_busy', {
                    session_id: String(session_id),
                    retry_ms: 2000
                });
                await new Promise((resolve)=>setTimeout(resolve, 2000));
            }
        }
        throw last_error ?? new Error('会话一直被占用，等不到写入句柄');
    };
    const handle_event = async (kind, data)=>{
        const author = data.author ?? {};
        const openid = author.user_openid ?? author.member_openid ?? author.id;
        const content = typeof data.content === 'string' ? data.content.trim() : '';
        const msg_id = typeof data.id === 'string' ? data.id : undefined;
        const group = typeof data.group_openid === 'string' ? data.group_openid : undefined;
        if (openid === undefined || content === '') return;
        const shared = group === undefined ? shared_session_id() : '';
        const session_id = brandString(shared !== '' ? shared : `qq-${group === undefined ? openid : `g-${group}-${openid}`}`);
        const target = group === undefined ? {
            userOpenid: openid
        } : {
            groupOpenid: group
        };
        probe('inbound', 'qq.message', {
            kind,
            session_id: String(session_id),
            chars: content.length,
            group: group !== undefined
        });
        if (msg_id !== undefined) await record_memory(String(session_id), 'user', content, `qq-${msg_id}`);
        try {
            const agent = await wait_for_agent(session_id);
            register_query_tools(agent.ctx);
            const session_key = String(session_id);
            if (msg_id !== undefined) last_msg.set(session_key, msg_id);
            if (!host.tasks) {
                const media_tool = defineTool({
                    name: 'send_file',
                    description: '把本地图片/视频/语音/文档真正发到当前 QQ 聊天（不是只给路径）。用户说"发我""发过来""截图给我"时用它。',
                    parameters: {
                        path: {
                            type: 'string',
                            description: '本地文件绝对路径（20MB 以内）'
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
                        const result = await send_qq_media(tokens, target, file, last_msg.get(session_key), config.base_url);
                        if (result.ok) return {
                            ok: true,
                            text: `已发送：${file}（${result.mode}）`
                        };
                        return {
                            ok: false,
                            text: `发送失败：${result.error ?? '未知错误'}`
                        };
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
            bind_stream(agent, String(session_id));
            pending.set(String(session_id), {
                text: pending.get(String(session_id))?.text ?? '',
                ...msg_id === undefined ? {} : {
                    msgId: msg_id
                },
                target
            });
            const taskOriginId = host.tasks?.note_input(agent, {
                channel: 'qq',
                messageId: msg_id ?? `${Date.now()}-${openid}`,
                owner: shared !== '' ? 'shared-household' : `qq:${group ?? ''}:${openid}`,
                target,
                userId: openid,
                originalText: content
            });
            const message = createUserMessage({
                content: [
                    {
                        type: 'text',
                        text: content
                    }
                ],
                source: {
                    kind: 'plugin',
                    plugin: 'webhook-qq',
                    form: 'notice',
                    summary: 'QQ 消息',
                    ...taskOriginId ? {
                        taskOriginId
                    } : {}
                }
            });
            if (host.tasks || agent.status === 'idle') agent.followup(message);
            else agent.steer(message);
        } catch (error) {
            probe('inbound', 'qq.handle_failed', {
                session_id: String(session_id),
                error: String(error).slice(0, 160)
            });
            console.error(`[webhook-qq] 处理消息失败：${String(error).slice(0, 200)}`);
            await send_qq_text(tokens, target, '我这边刚才没处理成，稍后再试一次好吗？', msg_id, config.base_url);
        }
    };
    const get_outbox = ()=>{
        if (outbox !== undefined) return outbox;
        const send = async (row, mark)=>{
            const progress = {
                sent_parts: row.sent_parts,
                on_sent: mark
            };
            const result = await send_qq_text(tokens, row.target, row.text, row.msgId, config.base_url, progress);
            if (!result.ok && result.mode === 'passive' && /HTTP 400|HTTP 403/.test(result.error ?? '')) {
                return send_qq_text(tokens, row.target, row.text, undefined, config.base_url, progress);
            }
            return result;
        };
        const report = (state)=>probe('outbound', 'qq.send', state);
        if ((process.env.SYNLOVE_QQ_STATE_MODE ?? 'local').trim().toLowerCase() === 'remote') {
            outbox = new QqRemoteOutbox(new QqStateRemoteClient(), send, report);
        } else {
            outbox = new QqOutbox(process.env.DSH_QQ_OUTBOX ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-outbox.json'), send, report);
        }
        return outbox;
    };
    host.tasks?.register_channel('qq', {
        resolve: async (origin)=>{
            const current = origin.target.groupOpenid ? origin.sessionId : shared_session_id() || origin.sessionId;
            const agent = await wait_for_agent(brandString(current));
            bind_stream(agent, current);
            return agent;
        },
        send: async (task, text)=>{
            const id = await get_outbox().enqueue_reply({
                text,
                target: task.origin.target,
                dedupeKey: `task-${task.id}`
            });
            void get_outbox().drain_queue();
            return id;
        }
    });
    const gateway = new QqGateway({
        token: ()=>tokens.get(),
        ...config.intents === undefined ? {} : {
            intents: config.intents
        },
        ...config.base_url === undefined ? {} : {
            baseUrl: config.base_url
        },
        on_event: (event)=>{
            void handle_event(event.t, event.d);
        },
        on_health: (state)=>probe('lifecycle', 'qq.health', {
                ...state,
                pid: process.pid
            }),
        log: (message)=>{
            console.error(`[webhook-qq] ${message}`);
            probe('lifecycle', 'qq.gateway', {
                message: message.slice(0, 160)
            });
        }
    });
    const lock_path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-gateway.pid');
    const remote_state = (process.env.SYNLOVE_QQ_STATE_MODE ?? 'local').trim().toLowerCase() === 'remote';
    const lock_held = (()=>{
        try {
            const pid = Number(readFileSync(lock_path, 'utf8').trim());
            if (pid > 0 && pid !== process.pid) {
                try {
                    process.kill(pid, 0);
                    return true;
                } catch  {
                    return false;
                }
            }
        } catch  {
            return false;
        }
        return false;
    })();
    ctx.effect(async ()=>{
        if (!remote_state && lock_held) {
            console.error('[webhook-qq] 另一个实例已占用网关（qq-gateway.pid），本实例不连 QQ');
            probe('lifecycle', 'qq.gateway.skip_duplicate', {
                pid: process.pid
            });
            return ()=>{};
        }
        const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        const remote_client = remote_state ? new QqStateRemoteClient() : undefined;
        const lease = remote_client === undefined ? new QqGatewayLease(join(home, 'qq-gateway-lease.db')) : new QqRemoteLease(remote_client, config.app_id);
        if (!await lease.acquire_lease()) {
            await lease.release_lease();
            probe('lifecycle', 'qq.gateway.skip_duplicate', {
                pid: process.pid
            });
            return ()=>{};
        }
        let retry;
        try {
            if (!remote_state) writeFileSync(lock_path, String(process.pid), 'utf8');
            get_outbox();
            const notifications = new BackendNotifications(home, (row)=>get_outbox().enqueue_reply(row));
            retry = setInterval(()=>{
                void notifications.receive_results().then(()=>outbox?.drain_queue()).catch((error)=>probe('outbound', 'qq.outbox_failed', {
                        error: String(error).slice(0, 160)
                    }));
            }, 5_000);
            void get_outbox().drain_queue().catch((error)=>probe('outbound', 'qq.outbox_failed', {
                    error: String(error).slice(0, 160)
                }));
            gateway.start();
            probe('lifecycle', 'qq.gateway.start', {});
        } catch (error) {
            if (retry !== undefined) clearInterval(retry);
            outbox?.stop_queue();
            await lease.release_lease();
            try {
                if (!remote_state && readFileSync(lock_path, 'utf8').trim() === String(process.pid)) unlinkSync(lock_path);
            } catch  {}
            throw error;
        }
        return async ()=>{
            gateway.stop();
            if (retry !== undefined) clearInterval(retry);
            outbox?.stop_queue();
            await lease.release_lease();
            try {
                if (!remote_state && readFileSync(lock_path, 'utf8').trim() === String(process.pid)) unlinkSync(lock_path);
            } catch  {}
            probe('lifecycle', 'qq.gateway.stop', {});
        };
    });
}
