import { randomUUID } from 'node:crypto';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
export class PresentationSessionFactory {
    runtime;
    constructor(runtime){
        this.runtime = runtime;
    }
    async create_session(agent, task) {
        const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent));
        const personas = assembly.sections.filter((section)=>[
                'deployment:persona-prefix',
                'deployment:persona-suffix'
            ].includes(section.name));
        const options = {
            ...task.origin.options,
            maxTokens: 1536
        };
        const handle = await this.runtime.host_context().agents.create({
            sessionId: `notice-${randomUUID()}`,
            agentOptions: options,
            meta: {
                cwd: this.runtime.root
            },
            setup: async (child)=>{
                for (const section of personas)child.systemPrompt.section({
                    name: section.name,
                    order: child.systemPrompt.getSectionOrder(section.name.endsWith('prefix') ? 'DEPLOYMENT_PERSONA_PREFIX' : 'DEPLOYMENT_PERSONA_SUFFIX'),
                    text: section.text
                });
            }
        });
        try {
            await this.runtime.attach_presenter(handle.agent, options);
            return handle;
        } catch (error) {
            await handle.dispose();
            throw error;
        }
    }
}
