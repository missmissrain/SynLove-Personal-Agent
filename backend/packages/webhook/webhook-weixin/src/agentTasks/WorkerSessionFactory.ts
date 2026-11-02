/**
 * 独立执行会话工厂：复用 Harness 工厂，显式挂载任务预设及执行提示词，不继承主人格工具限制。
 * 参数 ctx 为宿主作用域、root 为生产目录、config 为独立任务配置；默认不派生下一级。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'

export class WorkerSessionFactory {
  /** ctx 必须来自连接器宿主而非主人格 Agent；config 不包含模型密钥。 */
  constructor(private ctx: any, private root: string, private config: any, private setup?: (ctx: any, task: any) => void) {}
  /** task 为已持久化任务，options 为实际模型路由；新会话没有父聊天 seed。 */
  async create_worker(task: any, options: any, signal?: AbortSignal): Promise<any> {
    const presets = this.ctx.get('agentPresets')
    const preset = await presets.resolve(this.config.workerPreset)
    const persona = readFileSync(join(this.root, 'prompts', 'TaskExecution.md'), 'utf8')
    return this.ctx.agents.create({
      signal,
      sessionId: brandString(task.worker),
      meta: { cwd: task.origin.workspace, agentPreset: preset.id },
      agentOptions: { ...options, ...this.config.workerModel },
      setup: async (child: any, agent: any) => {
        await presets.mount(child, preset.id)
        child.tools.presentAs('native')
        this.setup?.(child, task)
        child.systemPrompt.section({
          name: 'deployment:persona-prefix',
          order: child.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: persona,
        })
        child.systemPrompt.section({
          name: 'deployment:persona-suffix',
          order: child.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: '',
        })
        const deny = ['subagent', 'fork', 'send_message', 'interrupt_agent', 'send_file',
          'task_submit', ...['task_submit','task_status','task_message','task_cancel','task_result']
            .map(name => `mcp__synlove-task__${name}`)]
        const known = child.tools.view(agent).restrictableNames
        const allow = this.config.toolAllow?.[task.kind]
        child.tools.restrict({ deny: deny.filter(name => known.has(name)),
          ...(allow ? { allow: allow.filter((name: string) => known.has(name)) } : {}) })
        child.tools.guard((exec: any) => deny.includes(exec.name) || (allow && !allow.includes(exec.name))
          ? '该工具不在本次后台任务权限内' : undefined)
      },
    })
  }
}
