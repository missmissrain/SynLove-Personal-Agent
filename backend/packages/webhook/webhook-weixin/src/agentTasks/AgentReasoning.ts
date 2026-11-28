/**
 * 角色思考强度：每次模型请求读取独立JSON，按实际路由能力设置参数，主子会话互不继承。
 * 参数root为生产目录、role为presenter或worker；未配置默认low，无能力时使用模型默认值。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../diagnostics/probe.ts'

export class AgentReasoning {
  private notice = ''
  /** root为可信工程目录，role为固定内部角色；不从用户消息或工具参数接收。 */
  constructor(private root: string, private role: 'presenter' | 'worker') {}

  /** 无参数；每步读取最新设置，缺失或损坏时回退low并记录脱敏诊断，避免中断聊天。 */
  read_level(): string {
    try {
      const data = JSON.parse(readFileSync(join(this.root, 'config', 'agentReasoning.json'), 'utf8').replace(/^\uFEFF/, ''))
      const level = data?.[this.role] ?? 'low'
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) throw new Error('invalid')
      return level
    } catch (error: any) {
      if (error.code !== 'ENOENT') this.report_state('low', undefined, 'invalid-config')
      return 'low'
    }
  }

  /** agent为真实会话；最外层请求中间件在模型路由确定后处理强度，不改在途请求。 */
  attach_agent(agent: any): void {
    agent.ctx.on('agent/request', async (payload: any, next: any) => {
      const resolved = await next()
      const level = this.read_level()
      const info = await agent.ctx.llm.resolveModelInfo(resolved.provider, resolved.model, payload.signal)
      const { reasoningEffort: _inherited, ...base } = resolved
      const supported = info.reasoning?.efforts?.some((item: any) => item.id === level)
      this.report_state(level, supported ? level : info.reasoning?.defaultEffort,
        supported ? 'applied' : 'model-default')
      return supported ? { ...base, reasoningEffort: level } : base
    }, { prepend: true })
  }

  /** requested/effective为档位，mode为兼容状态；变化时记录一次，不含消息和凭据。 */
  private report_state(requested: string, effective: string | undefined, mode: string): void {
    const key = `${requested}:${effective ?? ''}:${mode}`
    if (this.notice === key) return
    this.notice = key
    probe('agent-task', 'reasoning.configured', { role: this.role, requested, effective: effective ?? 'default', mode })
  }
}
