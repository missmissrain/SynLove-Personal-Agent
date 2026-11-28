/**
 * 图谱主模型客户端：复用已注册的主对话适配器，不使用 Gemma 或显存闸门。
 * 参数：get_llm 获取现有模型服务，get_model 获取当前主模型；timeout_ms 默认五分钟。
 * 只发独立事实提取请求，不携带主人格会话，也不挂载工具。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { probe } from '../diagnostics/probe.ts'

export class GraphModel {
  /** get_llm 为服务获取器；get_model 返回当前主模型路由；超时以毫秒计。 */
  constructor(
    private readonly get_llm: () => any,
    private readonly get_model: () => { provider: string, model: string },
    private readonly timeout_ms = 300_000,
  ) {}

  /** prompt 为图谱短协议提示词；只接受正常结束的完整正文，失败由调度器保留水位重试。 */
  async complete(prompt: string): Promise<string> {
    const route = this.get_model()
    const llm = this.get_llm()
    if (!llm || !route.provider || !route.model) throw Error('图谱主模型未配置或尚未就绪')
    const signal = AbortSignal.timeout(this.timeout_ms)
    const blocks = new BlockAssembler()
    let finished = false
    for await (const chunk of llm.stream({
      ...route, maxTokens: 4096, signal,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'synlove-graph' },
      })],
    })) {
      signal.throwIfAborted()
      blocks.push(chunk)
      if (chunk.type === 'finish') {
        finished = true
        if (chunk.reason.kind !== 'stop') throw Error(`图谱主模型未正常完成：${chunk.reason.kind}`)
      }
    }
    signal.throwIfAborted()
    const text = blocks.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    if (!finished || !text.trim()) throw Error('图谱主模型没有返回完整正文')
    probe('graph', 'model.completed', { ...route, usage: blocks.usage })
    return text
  }
}
