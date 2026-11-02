import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import { WorkerServiceTools } from './WorkerServiceTools.js';
export class WorkerSessionFactory {
    ctx;
    root;
    config;
    setup;
    constructor(ctx, root, config, setup){
        this.ctx = ctx;
        this.root = root;
        this.config = config;
        this.setup = setup;
    }
    async create_worker(task, options, signal) {
        const presets = this.ctx.get('agentPresets');
        const preset = await presets.resolve(this.config.workerPreset);
        const persona = readFileSync(join(this.root, 'prompts', 'TaskExecution.md'), 'utf8');
        return this.ctx.agents.create({
            signal,
            sessionId: brandString(task.worker),
            meta: {
                cwd: task.origin.workspace,
                agentPreset: preset.id
            },
            agentOptions: {
                ...options,
                ...this.config.workerModel
            },
            setup: async (child, agent)=>{
                await presets.mount(child, preset.id);
                await new WorkerServiceTools(this.root).mount_tools(child, task.kind);
                child.tools.presentAs('native');
                this.setup?.(child, task);
                child.systemPrompt.section({
                    name: 'deployment:persona-prefix',
                    order: child.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
                    text: persona
                });
                child.systemPrompt.section({
                    name: 'deployment:persona-suffix',
                    order: child.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
                    text: ''
                });
                child.systemPrompt.section({
                    name: 'synlove:worker-protocol',
                    order: 100000,
                    text: readFileSync(join(this.root, 'prompts', 'WorkerProtocol.md'), 'utf8')
                });
                const deny = [
                    'subagent',
                    'fork',
                    'send_message',
                    'interrupt_agent',
                    'send_file',
                    'task_submit',
                    ...[
                        'task_submit',
                        'task_status',
                        'task_message',
                        'task_cancel',
                        'task_result'
                    ].map((name)=>`mcp__synlove-task__${name}`)
                ];
                const known = child.tools.view(agent).restrictableNames;
                const allow = this.config.toolAllow?.[task.kind];
                child.tools.restrict({
                    deny: deny.filter((name)=>known.has(name)),
                    ...allow ? {
                        allow: allow.filter((name)=>known.has(name))
                    } : {}
                });
                child.tools.guard((exec)=>deny.includes(exec.name) || allow && !allow.includes(exec.name) ? '该工具不在本次后台任务权限内' : undefined);
            }
        });
    }
}
