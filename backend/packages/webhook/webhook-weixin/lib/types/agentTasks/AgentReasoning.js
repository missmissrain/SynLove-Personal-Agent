import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
export class AgentReasoning {
    root;
    role;
    notice = '';
    constructor(root, role){
        this.root = root;
        this.role = role;
    }
    read_level() {
        try {
            const data = JSON.parse(readFileSync(join(this.root, 'config', 'agentReasoning.json'), 'utf8').replace(/^\uFEFF/, ''));
            const level = data?.[this.role] ?? 'low';
            if (![
                'low',
                'medium',
                'high',
                'xhigh',
                'max'
            ].includes(level)) throw new Error('invalid');
            return level;
        } catch (error) {
            if (error.code !== 'ENOENT') this.report_state('low', undefined, 'invalid-config');
            return 'low';
        }
    }
    attach_agent(agent) {
        agent.ctx.on('agent/request', async (payload, next)=>{
            const resolved = await next();
            const level = this.read_level();
            const info = await agent.ctx.llm.resolveModelInfo(resolved.provider, resolved.model, payload.signal);
            const { reasoningEffort: _inherited, ...base } = resolved;
            const supported = info.reasoning?.efforts?.some((item)=>item.id === level);
            this.report_state(level, supported ? level : info.reasoning?.defaultEffort, supported ? 'applied' : 'model-default');
            return supported ? {
                ...base,
                reasoningEffort: level
            } : base;
        }, {
            prepend: true
        });
    }
    report_state(requested, effective, mode) {
        const key = `${requested}:${effective ?? ''}:${mode}`;
        if (this.notice === key) return;
        this.notice = key;
        probe('agent-task', 'reasoning.configured', {
            role: this.role,
            requested,
            effective: effective ?? 'default',
            mode
        });
    }
}
