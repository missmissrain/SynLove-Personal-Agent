import { appendFile } from 'node:fs/promises';
import { probe } from '../diagnostics/probe.js';
import { TaskRuntime } from '../agentTasks/TaskRuntime.js';
export class HarnessSessionHost {
    ctx;
    options;
    tasks;
    handles = new Map();
    disposed = false;
    composition;
    constructor(ctx, options){
        this.ctx = ctx;
        this.options = options;
        this.tasks = TaskRuntime.for_host(ctx, options);
    }
    assert_capabilities() {
        const get = (name)=>this.ctx.get(name);
        const missing = [];
        if (get('agents') === undefined) missing.push('agents');
        if (get('agentPresets') === undefined) missing.push('agentPresets');
        if (get('sessionPersistence') === undefined) missing.push('sessionPersistence');
        if (get('llm') === undefined) missing.push('llm');
        if (this.options.agent_preset !== undefined && get('agentPresets') !== undefined) {
            probe('lifecycle', 'capability.preset_requested', {
                preset: this.options.agent_preset
            });
        }
        if (missing.length > 0) {
            throw new Error(`webhook-weixin: 装配检查失败，缺少服务 ${missing.join(', ')}。` + '连接器拒绝启动（避免出现"能启动但发消息才发现没有工具/没有持久化"的假成功）。');
        }
        probe('lifecycle', 'capability.ok', {
            preset: this.options.agent_preset ?? '(default)',
            provider: this.options.provider,
            model: this.options.model
        });
    }
    reset_composition() {
        this.composition = undefined;
        probe('lifecycle', 'composition.reset');
    }
    get_agent(session_id) {
        return this.ctx.agents.get(session_id);
    }
    async create_agent(session_id) {
        this.assert_not_disposed();
        const composition = await this.compose();
        try {
            const handle = await this.ctx.agents.create({
                sessionId: session_id,
                meta: {
                    cwd: this.options.workspace_path,
                    ...composition.agentPreset === undefined ? {} : {
                        agentPreset: composition.agentPreset
                    },
                    ...this.options.provider === undefined ? {} : {
                        provider: this.options.provider
                    },
                    ...this.options.model === undefined ? {} : {
                        model: this.options.model
                    }
                },
                ...this.agent_options() === undefined ? {} : {
                    agentOptions: this.agent_options()
                },
                ...composition.setup === undefined ? {} : {
                    setup: composition.setup
                }
            });
            try {
                await this.tasks?.attach_presenter(handle.agent, this.options);
            } catch (error) {
                await handle.dispose();
                throw error;
            }
            this.handles.set(String(handle.agent.id), handle);
            probe('lifecycle', 'agent.created', {
                session_id: String(handle.agent.id)
            });
            return handle.agent;
        } catch (error) {
            if (!is_session_already_exists(error)) throw error;
            probe('lifecycle', 'agent.create_conflict_resume', {
                session_id: String(session_id)
            });
            return this.resume_agent(session_id);
        }
    }
    async resume_agent(session_id) {
        this.assert_not_disposed();
        const composition = await this.compose();
        let handle;
        try {
            handle = await this.ctx.agents.resume({
                resumeSessionId: session_id,
                ...this.agent_options() === undefined ? {} : {
                    agentOptions: this.agent_options()
                },
                ...composition.setup === undefined ? {} : {
                    setup: composition.setup
                }
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/^session ["'][^"']+["'] not found$/i.test(message)) throw error;
            probe('lifecycle', 'agent.resume_missing_create', {
                session_id: String(session_id)
            });
            return this.create_agent(session_id);
        }
        try {
            await this.tasks?.attach_presenter(handle.agent, this.options);
        } catch (error) {
            await handle.dispose();
            throw error;
        }
        this.handles.set(String(handle.agent.id), handle);
        probe('lifecycle', 'agent.resumed', {
            session_id: String(handle.agent.id)
        });
        return handle.agent;
    }
    async dispose_agent(session_id) {
        const key = String(session_id);
        const handle = this.handles.get(key);
        if (handle === undefined) return false;
        this.handles.delete(key);
        try {
            await handle.dispose();
            probe('lifecycle', 'agent.disposed_one', {
                session_id: key
            });
            return true;
        } catch (error) {
            probe('lifecycle', 'agent.dispose_failed', {
                session_id: key,
                error: String(error)
            });
            return false;
        }
    }
    async dispose_agents() {
        if (this.disposed) return;
        this.disposed = true;
        const entries = [
            ...this.handles.values()
        ];
        this.handles.clear();
        for (const handle of entries){
            try {
                await handle.dispose();
            } catch (error) {
                probe('lifecycle', 'agent.dispose_failed', {
                    error: String(error)
                });
            }
        }
        probe('lifecycle', 'agents.disposed', {
            count: entries.length
        });
    }
    async compose() {
        if (this.composition !== undefined) return this.composition;
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) {
            throw new Error('webhook-weixin: agentPresets 服务缺失，无法挂载 Agent preset（会导致 Agent 没有任何工具）。');
        }
        try {
            const resolvedId = (await presets.resolve(this.tasks?.config.presenterPreset ?? this.options.agent_preset)).id;
            const composition = {
                agentPreset: resolvedId,
                setup: async (agentCtx)=>{
                    await presets.mount(agentCtx, resolvedId);
                }
            };
            this.composition = composition;
            probe('lifecycle', 'preset.resolved', {
                requested: this.options.agent_preset ?? '(default)',
                resolved: resolvedId
            });
            return composition;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`webhook-weixin: 无法解析 Agent preset "${this.options.agent_preset ?? '(default)'}"，` + `拒绝以"无工具 Agent"继续运行：${detail}`);
        }
    }
    agent_options() {
        const provider = this.options.provider;
        const model = this.options.model;
        if (provider === undefined || model === undefined) {
            probe('lifecycle', 'agent_options.missing_model', {
                provider,
                model
            });
            return undefined;
        }
        const level = this.options.reasoning_effort;
        if (level === undefined) return {
            provider,
            model
        };
        return {
            provider,
            model,
            reasoningEffort: level
        };
    }
    assert_not_disposed() {
        if (this.disposed) throw new Error('webhook-weixin: 宿主已释放，不能再创建 Agent');
    }
}
function is_session_already_exists(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /already exists|duplicate|EEXIST|session_exists/i.test(message);
}
export async function trace_to_file(line) {
    const path = process.env.DSH_WEIXIN_DEBUG_LOG;
    if (!path) return;
    try {
        await appendFile(path, `${new Date().toISOString()} [weixin] ${line}\n`, 'utf8');
    } catch  {}
}
