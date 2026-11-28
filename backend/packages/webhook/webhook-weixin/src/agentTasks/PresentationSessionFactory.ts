/**
 * 主人格结果表达会话：复制当前主人格，使用空历史生成一条完整通知，隔离失败轮次与旧报告腔。
 * 参数 runtime 为唯一任务运行器；默认最多输出1536 token，不导入用户历史或后台工具。
 */
import { randomUUID } from 'node:crypto'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'

export class PresentationSessionFactory {
  /** runtime 提供宿主服务、当前模型选项和五个受限任务工具。 */
  constructor(private runtime: any) {}
  /** agent 为真实主人格，task 为已落库任务；返回无父历史的新表达会话。 */
  async create_session(agent: any, task: any): Promise<any> {
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    const personas = assembly.sections.filter((section: any) =>
      ['deployment:persona-prefix','deployment:persona-suffix'].includes(section.name))
    const options = { ...task.origin.options, maxTokens:1536 }
    const handle = await this.runtime.host_context().agents.create({
      sessionId:`notice-${randomUUID()}`,
      agentOptions:options,
      meta:{cwd:this.runtime.root},
      setup:async (child: any) => {
        for (const section of personas) child.systemPrompt.section({
          name:section.name,
          order:child.systemPrompt.getSectionOrder(section.name.endsWith('prefix') ? 'DEPLOYMENT_PERSONA_PREFIX' : 'DEPLOYMENT_PERSONA_SUFFIX'),
          text:section.text,
        })
      },
    })
    try { await this.runtime.attach_presenter(handle.agent, options); return handle }
    catch (error) { await handle.dispose(); throw error }
  }
}
